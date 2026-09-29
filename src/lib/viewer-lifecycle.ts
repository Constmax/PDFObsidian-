import { Component, TFile } from 'obsidian';

import PDFPlus from 'main';
import { PDFViewerChild } from 'typings';


export interface ViewerContext {
    plugin: PDFPlus;
    child: PDFViewerChild;
}

export interface DocumentContext extends ViewerContext {
    file: TFile;
}

/**
 * Something PDF++ attaches to every PDF viewer. Everything a hook registers on `scope`
 * (child components, events, DOM events, cleanup callbacks) is removed when the scope ends.
 */
export interface ViewerFeature {
    /** Shown in error messages. */
    name: string;
    /**
     * Called once per viewer, after pdf.js' viewer has been set up. `scope` ends when the viewer
     * is unloaded, before pdf.js' viewer is torn down, so the document is still alive then.
     */
    viewer?(scope: Component, ctx: ViewerContext): void;
    /**
     * Called every time a file has been loaded into the viewer. Every write to a PDF reloads its viewers,
     * so this runs again after each write. `scope` ends when the next load begins, and when the viewer is unloaded.
     */
    document?(scope: Component, ctx: DocumentContext): void;
}

/**
 * The lifetimes of one PDF viewer (`PDFViewerChild`), as nested components: this component lives as
 * long as the viewer, and holds a child component for the document currently loaded.
 *
 * Handlers registered once per file load on a component that lives as long as the viewer pile up,
 * since every write to the file reloads it. The document scope gives them a lifetime that matches.
 */
export class ViewerLifecycle extends Component {
    /** The scope of the document currently loaded; null while a load is in progress. */
    document: Component | null = null;
    /** Identifies the latest load, so that an earlier one finishing late doesn't open a scope. */
    private loadCount = 0;

    constructor(public plugin: PDFPlus, public child: PDFViewerChild, private features: readonly ViewerFeature[]) {
        super();
    }

    onload() {
        const ctx: ViewerContext = { plugin: this.plugin, child: this.child };
        for (const feature of this.features) {
            if (feature.viewer) this.runHook(feature, 'viewer', () => feature.viewer!(this, ctx));
        }
    }

    /**
     * To be called when the viewer starts loading a file. Ends the scope of the previous document.
     * Returns the ticket to pass to `documentLoaded()`.
     */
    beginDocument(): number {
        if (this.document) {
            this.removeChild(this.document);
            this.document = null;
        }
        return ++this.loadCount;
    }

    /**
     * To be called when the file has been loaded. Opens the new document's scope and runs the `document` hooks.
     * Returns null if another load began in the meantime or the viewer has been unloaded.
     */
    documentLoaded(ticket: number, file: TFile): Component | null {
        if (ticket !== this.loadCount || this.child.unloaded) return null;

        const scope = this.document = this.addChild(new Component());
        const ctx: DocumentContext = { plugin: this.plugin, child: this.child, file };
        for (const feature of this.features) {
            if (feature.document) this.runHook(feature, 'document', () => feature.document!(scope, ctx));
        }
        return scope;
    }

    /** A broken feature must not break the viewer or the other features. */
    private runHook(feature: ViewerFeature, hook: string, fn: () => void) {
        try {
            fn();
        } catch (err) {
            console.error(`${this.plugin.manifest.name}: "${feature.name}" failed in its ${hook} hook`, err);
        }
    }
}

/** The features attached to every PDF viewer, in the order they are set up. */
export const viewerFeatures: ViewerFeature[] = [];
