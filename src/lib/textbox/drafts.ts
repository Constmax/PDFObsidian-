import { Notice } from 'obsidian';
import { PDFDocumentProxy } from 'pdfjs-dist';

import { PDFPlusLib } from 'lib';
import { PDFDraftSource } from 'lib/pdf-write-coordinator';
import { PDFViewerChild } from 'typings';
import { AnnotationStyle, Draft, DraftBase, EDITOR_KEY_PREFIX, STYLE_KEYS, SerializedEditor, applyDrafts, normalizeColor } from './rebase';


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
     * Serialized data of the drafts written from the current document, by key. The viewer reloads
     * the file asynchronously after a write; until then, the old document still holds these editors,
     * and they must not be captured again, or a write queued right behind would add them a second time.
     * Editors that were created or changed after being captured for a write are not in here and are kept.
     */
    private written = new Map<string, string>();
    /** The drafts merged by the last `applyDrafts()`, which `onDraftsWritten()` confirms. */
    private applying: Draft[] = [];
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
        this.capture();
        return this.drafts.size > 0;
    }

    async applyDrafts(data: ArrayBuffer): Promise<ArrayBuffer> {
        this.applying = [...this.drafts.values()];
        const result = await applyDrafts(this.lib, data, this.applying);
        if (result.report.rescuedAsNew) {
            new Notice(`${this.lib.plugin.manifest.name}: ${result.report.rescuedAsNew} edited annotation(s) had been changed or removed by someone else. Your version was saved as a new annotation.`, 10000);
        }
        return result.data;
    }

    onDraftsWritten() {
        for (const draft of this.applying) {
            const json = JSON.stringify(draft.data);
            this.written.set(draft.key, json);
            // A draft edited further while the write was in progress still needs to be written.
            const current = this.drafts.get(draft.key);
            if (current && JSON.stringify(current.data) === json) this.drafts.delete(draft.key);
        }
        this.applying = [];
    }

    onForeignModify() {
        // The viewer is about to reload the file and destroy the current document.
        this.capture();
        const file = this.child.file;
        if (!this.drafts.size || !file) return;

        const count = this.drafts.size;
        const kept = () => new Notice(`${this.lib.plugin.manifest.name}: ${file.name} was modified elsewhere. ${count} unsaved annotation(s) are kept and will be saved with the next change to this file.`, 10000);
        this.lib.writer.flush(file)
            .then(() => {
                if (this.drafts.size) kept();
                else new Notice(`${this.lib.plugin.manifest.name}: ${file.name} was modified elsewhere. ${count} unsaved annotation(s) were merged into the new version and saved.`, 8000);
            })
            .catch((err) => {
                console.error(err);
                kept();
            });
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
        if (!doc) return;

        // pdf.js adds an editor to the annotation storage only when it is committed, so a text box
        // being typed into isn't there yet. Commit it; this also serializes its current text.
        const active = (pdfViewer as any)._layerProperties?.annotationEditorUIManager?.getActive();
        if (active?.isInEditMode() && active.parent) active.commit();

        let generation = this.generations.get(doc);
        if (generation === undefined) {
            generation = this.nextGeneration++;
            this.generations.set(doc, generation);
            // A new document means the one whose written editors had to be skipped is gone.
            this.written.clear();
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

            // Already written and unchanged since: the file has it; the viewer just hasn't reloaded yet.
            // (If it was changed after all, it is written again as a new annotation. That duplicates it,
            // but the other option is losing the change.)
            if (this.written.get(prefix + key) === JSON.stringify(data)) continue;

            this.drafts.set(prefix + key, { key: prefix + key, data, base: data.id !== null ? baseOf(value) : null });
        }
    }
}

/** `AnnotationEditorType`s in pdf.js; they equal the corresponding `AnnotationType`s. */
const HIGHLIGHT = 9;
const INK = 15;

/** The annotation an editor was created from. pdf.js keeps it as `_initialData`. */
function baseOf(editor: any): DraftBase | null {
    const initial = editor._initialData;
    if (!initial || typeof initial.id !== 'string') return null;
    return {
        id: initial.id,
        // A free highlight is an ink annotation in the file, but its editor records it as a highlight.
        annotationType: initial.annotationType === HIGHLIGHT && initial.inkLists ? INK : initial.annotationType,
        pageIndex: initial.pageIndex,
        rect: Array.from(initial.rect),
        value: initial.value,
        style: styleOf(initial),
    };
}

/** The formatting properties `_initialData` has. Which ones depends on the editor type. */
function styleOf(initial: any): AnnotationStyle {
    const style: AnnotationStyle = {};
    for (const key of STYLE_KEYS) {
        if (initial[key] === undefined) continue;
        (style as any)[key] = key === 'color' ? normalizeColor(initial.color) : initial[key];
    }
    return style;
}
