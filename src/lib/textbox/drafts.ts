import { Notice, TFile } from 'obsidian';
import { PDFDocumentProxy } from 'pdfjs-dist';

import { PDFPlusLib } from 'lib';
import { PDFDraftSource } from 'lib/pdf-write-coordinator';
import { PDFViewerChild } from 'typings';
import { Draft, DraftBase, EDITOR_KEY_PREFIX, SerializedEditor, applyDrafts } from './rebase';


/**
 * The unsaved annotation editors (text boxes etc.) of one PDF viewer, as a draft source
 * for the write coordinator.
 *
 * Drafts are captured from pdf.js' annotation storage and kept here until they are written.
 * They survive the viewer reloading the file, which happens after every write to it.
 */
export class PDFViewerDrafts implements PDFDraftSource {
    private drafts = new Map<string, Draft>();
    /** Distinguishes documents the viewer has loaded, since editor ids restart with each one. */
    private generations = new WeakMap<PDFDocumentProxy, number>();
    private nextGeneration = 0;
    /**
     * Documents whose editors have been written. The viewer reloads the file asynchronously
     * after a write; until then, the old document must not be captured again, or a write
     * queued right behind would add its editors a second time.
     */
    private written = new WeakSet<PDFDocumentProxy>();
    private lastCaptured: PDFDocumentProxy | null = null;
    /** `child.file` is briefly null while the viewer reloads — exactly when drafts need their file most. */
    private lastPath = '';
    private unregister: () => void;

    constructor(private lib: PDFPlusLib, private child: PDFViewerChild) {
        this.lastPath = child.file?.path ?? '';
        this.unregister = lib.writer.registerDraftSource(this);
    }

    get path(): string {
        const path = this.child.file?.path;
        if (path) this.lastPath = path;
        return this.lastPath;
    }

    hasDrafts(): boolean {
        return this.pending > 0;
    }

    async applyDrafts(data: ArrayBuffer): Promise<ArrayBuffer> {
        const result = await applyDrafts(this.lib, data, [...this.drafts.values()]);
        if (result.report.rescuedAsNew) {
            new Notice(`${this.lib.plugin.manifest.name}: ${result.report.rescuedAsNew} edited annotation(s) had been changed or removed by someone else. Your version was saved as a new annotation.`, 10000);
        }
        return result.data;
    }

    onDraftsWritten() {
        this.drafts.clear();
        if (this.lastCaptured) this.written.add(this.lastCaptured);
    }

    onForeignModify() {
        // The viewer is about to reload the file and destroy the current document.
        const count = this.pending;
        if (!count) return;

        const name = this.path.split('/').pop();
        const kept = () => new Notice(`${this.lib.plugin.manifest.name}: ${name} was modified elsewhere. ${count} unsaved annotation(s) are kept and will be saved with the next change to this file.`, 10000);
        this.save()
            .then(() => {
                if (this.drafts.size) kept();
                else new Notice(`${this.lib.plugin.manifest.name}: ${name} was modified elsewhere. ${count} unsaved annotation(s) were merged into the new version and saved.`, 8000);
            })
            .catch((err) => {
                console.error(err);
                kept();
            });
    }

    /**
     * Number of unsaved drafts. Captures synchronously, so this is also the way to secure drafts
     * right before the viewer destroys its document (on close or reload).
     */
    get pending(): number {
        this.capture();
        return this.drafts.size;
    }

    /** Write all drafts to the file. Drafts that could not be written stay pending. */
    async save(): Promise<void> {
        if (!this.pending) return;
        const file = this.lib.app.vault.getAbstractFileByPath(this.path);
        if (file instanceof TFile) await this.lib.writer.flush(file);
    }

    dispose() {
        this.unregister();
    }

    /**
     * Read the unsaved editors of the currently loaded document. Drafts from documents
     * loaded earlier are kept until they are written.
     */
    private capture() {
        const pdfViewer = this.child.pdfViewer?.pdfViewer;
        const doc = pdfViewer?.pdfDocument;
        if (!doc || this.written.has(doc)) return;
        this.lastCaptured = doc;

        // pdf.js adds an editor to the annotation storage only when it is committed, so a text box
        // being typed into isn't there yet. Commit it; this also serializes its current text.
        const active = (pdfViewer as any)._layerProperties?.annotationEditorUIManager?.getActive();
        if (active?.isInEditMode() && active.parent) active.commitOrRemove(); // empty ones can't be committed

        let generation = this.generations.get(doc);
        if (generation === undefined) {
            generation = this.nextGeneration++;
            this.generations.set(doc, generation);
        }
        // The worker only picks up storage keys starting with EDITOR_KEY_PREFIX as new annotations.
        const prefix = `${EDITOR_KEY_PREFIX}g${generation}_`;
        for (const key of this.drafts.keys()) {
            if (key.startsWith(prefix)) this.drafts.delete(key);
        }

        for (const [key, value] of doc.annotationStorage as unknown as Iterable<[string, any]>) {
            if (typeof value?.serialize !== 'function') continue;

            const data: SerializedEditor | null = value.serialize(false);
            if (!data) continue; // empty, or unchanged since loaded

            this.drafts.set(prefix + key, { key: prefix + key, data, base: data.id !== null ? baseOf(value) : null });
        }
    }
}

/** The annotation an editor was created from. pdf.js keeps it as `_initialData`. */
function baseOf(editor: any): DraftBase | null {
    const initial = editor._initialData;
    if (!initial || typeof initial.id !== 'string') return null;
    return {
        id: initial.id,
        annotationType: initial.annotationType,
        pageIndex: initial.pageIndex,
        rect: Array.from(initial.rect),
        value: initial.value,
    };
}
