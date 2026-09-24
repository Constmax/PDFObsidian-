import { Notice, TFile } from 'obsidian';
import { PDFDocument } from '@cantoo/pdf-lib';

import { PDFPlusLibSubmodule } from './submodule';


/**
 * Something that holds unsaved changes to a PDF outside of the file, e.g. text boxes
 * typed into pdf.js' annotation editor layer but not saved yet.
 *
 * Any write to the file reloads every viewer showing it, which discards such changes.
 * A registered draft source therefore gets its drafts merged into every write that
 * goes through the coordinator, so that they end up in the file instead of being lost.
 */
export interface PDFDraftSource {
    /** Path of the PDF file this source holds drafts for. Read on every write, so it may change on rename. */
    readonly path: string;
    hasDrafts(): boolean;
    /**
     * Merge the drafts into `data` (the current content of the file) and return the result.
     * Must not write anything by itself.
     */
    applyDrafts(data: ArrayBuffer): Promise<ArrayBuffer>;
    /** Called once the data returned by `applyDrafts` has been written successfully. */
    onDraftsWritten(): void;
    /**
     * Called synchronously when the file was modified by someone other than this coordinator
     * (a sync plugin, another app, ...). The viewers are about to reload; this is the last
     * chance to capture drafts from the old document.
     */
    onForeignModify?(): void;
}

export class PDFWriteConflictError extends Error {
    constructor(path: string) {
        super(`${path} was modified by someone else in the meantime. Nothing was written.`);
        this.name = 'PDFWriteConflictError';
    }
}

export type FileStamp = { mtime: number, size: number };

/**
 * Serializes all writes to a PDF file and makes every writer work on the current content of the file.
 *
 * Without this, each writer reads the file, modifies it and writes the whole file back.
 * When two of these overlap, or when a writer works on an old copy (like pdf.js' `saveDocument()`,
 * which is based on the bytes loaded when the viewer opened the file), the last one to write
 * silently discards the changes of the others.
 */
export class PDFWriteCoordinator extends PDFPlusLibSubmodule {
    /** Maximum number of attempts when the file is modified by a third party during a write. */
    static MAX_ATTEMPTS = 3;

    private queues = new Map<string, Promise<unknown>>();
    private sources = new Set<PDFDraftSource>();
    /** Stamp of the file right after our last write, used to tell our own modify events from foreign ones. */
    private ownStamps = new Map<string, FileStamp>();
    /** Paths currently being written by us. The modify event may fire before `modifyBinary` resolves. */
    private writing = new Set<string>();

    /** Returns a function that unregisters the source. */
    registerDraftSource(source: PDFDraftSource): () => void {
        this.sources.add(source);
        return () => this.sources.delete(source);
    }

    /**
     * Read-modify-write `file` with exclusive access.
     *
     * `fn` receives the current content of the file, with pending drafts already merged in,
     * and returns the new content, or `null` if it has nothing to change. The file is written
     * at most once. Drafts are written even if `fn` returns `null`.
     */
    async modify(file: TFile, fn: (data: ArrayBuffer) => ArrayBuffer | null | Promise<ArrayBuffer | null>): Promise<void> {
        await this.exclusive(file.path, () => this.modifyUnlocked(file, fn));
    }

    /** Load `file` with pdf-lib, let `fn` modify it, and save it back — all under exclusive access. */
    async modifyWithPdfLib<T>(file: TFile, fn: (doc: PDFDocument) => T | Promise<T>): Promise<T> {
        let ret!: T;
        await this.modify(file, async (data) => {
            const doc = await this.lib.loadPdfLibDocumentFromArrayBuffer(data);
            ret = await fn(doc);
            return toArrayBuffer(await doc.save());
        });
        return ret;
    }

    /** Write pending drafts for `file`, if there are any. */
    async flush(file: TFile): Promise<void> {
        // Don't read the whole file just to find out there is nothing to write.
        if (!this.draftSourcesFor(file).length) return;
        await this.modify(file, () => null);
    }

    /**
     * For writers that restructure the document (e.g. insert or remove pages), onto whose result
     * drafts cannot be rebased: write pending drafts first, so that they move along with their pages,
     * then let `fn` compute the new content from the current one. All of this happens under
     * exclusive access, so other writes of this plugin can't get in between.
     *
     * Unlike `modify()`, `fn` is called only once: if a third party wrote the file in the meantime,
     * a `PDFWriteConflictError` is thrown and nothing is written.
     */
    async rewrite(file: TFile, fn: (data: ArrayBuffer) => ArrayBuffer | null | Promise<ArrayBuffer | null>): Promise<void> {
        await this.exclusive(file.path, async () => {
            await this.modifyUnlocked(file, () => null);

            const before = await this.stat(file);
            const out = await fn(await this.app.vault.readBinary(file));
            if (!out) return;

            if (!sameStamp(before, await this.stat(file))) throw this.conflict(file);
            await this.replace(file, out);
        });
    }

    /** Read `file` after writing pending drafts, for when its content is only used elsewhere (e.g. copied to another file). */
    async readFlushed(file: TFile): Promise<ArrayBuffer> {
        return await this.exclusive(file.path, async () => {
            await this.modifyUnlocked(file, () => null);
            return await this.app.vault.readBinary(file);
        });
    }

    /** Replace the whole content of `file`, waiting for other writes to finish first. */
    async overwrite(file: TFile, data: ArrayBuffer): Promise<void> {
        await this.exclusive(file.path, () => this.replace(file, data));
    }

    /** Whether the last modify event for `file` stems from a write of this coordinator. */
    isOwnWrite(file: TFile): boolean {
        if (this.writing.has(file.path)) return true;
        const stamp = this.ownStamps.get(file.path);
        return !!stamp && sameStamp(stamp, file.stat);
    }

    /** To be called on every `modify` event of the vault. */
    onVaultModify(file: TFile) {
        if (file.extension !== 'pdf' || this.isOwnWrite(file)) return;
        for (const source of this.sources) {
            if (source.path === file.path) source.onForeignModify?.();
        }
    }

    onRename(file: TFile, oldPath: string) {
        const stamp = this.ownStamps.get(oldPath);
        if (stamp) {
            this.ownStamps.delete(oldPath);
            this.ownStamps.set(file.path, stamp);
        }
        const queue = this.queues.get(oldPath);
        if (queue) {
            this.queues.delete(oldPath);
            this.queues.set(file.path, queue);
        }
        if (this.writing.delete(oldPath)) this.writing.add(file.path);
    }

    private conflict(file: TFile) {
        const error = new PDFWriteConflictError(file.path);
        new Notice(`${this.plugin.manifest.name}: ${error.message}`, 8000);
        return error;
    }

    private draftSourcesFor(file: TFile) {
        return [...this.sources].filter((source) => source.path === file.path && source.hasDrafts());
    }

    /** Must be called under exclusive access to `file`. */
    private async modifyUnlocked(file: TFile, fn: (data: ArrayBuffer) => ArrayBuffer | null | Promise<ArrayBuffer | null>): Promise<void> {
        for (let attempt = 1; ; attempt++) {
            const before = await this.stat(file);
            let data = await this.app.vault.readBinary(file);

            const sources = this.draftSourcesFor(file);
            for (const source of sources) {
                data = await source.applyDrafts(data);
            }

            const result = await fn(data);
            const out = result ?? (sources.length ? data : null);
            if (!out) return;

            // Optimistic check: if a third party wrote the file while we were working on it,
            // start over from its new content instead of overwriting it.
            const now = await this.stat(file);
            if (!sameStamp(before, now)) {
                if (attempt >= PDFWriteCoordinator.MAX_ATTEMPTS) throw this.conflict(file);
                continue;
            }

            await this.write(file, out);
            for (const source of sources) source.onDraftsWritten();
            return;
        }
    }

    /**
     * Write `data` as the new content of `file` without merging drafts into it. Must be called under exclusive access.
     *
     * The write reloads the viewers, and since it is our own, draft sources are not warned as for a
     * foreign modification. So capture their drafts before writing and merge them into the new content afterwards.
     */
    private async replace(file: TFile, data: ArrayBuffer) {
        const hadDrafts = this.draftSourcesFor(file).length > 0;
        await this.write(file, data);
        if (hadDrafts) {
            try {
                await this.modifyUnlocked(file, () => null);
            } catch (err) {
                // The drafts stay with their sources and are written with the next change.
                console.error(err);
            }
        }
    }

    private async write(file: TFile, data: ArrayBuffer) {
        const path = file.path;
        this.writing.add(path);
        try {
            await this.app.vault.modifyBinary(file, data);
            this.ownStamps.set(file.path, { mtime: file.stat.mtime, size: file.stat.size });
        } finally {
            // The file may have been renamed during the write, in which case onRename() moved the entry.
            this.writing.delete(path);
            this.writing.delete(file.path);
        }
    }

    /** Stamp straight from the disk. `file.stat` lags behind until Obsidian's file watcher catches up. */
    private async stat(file: TFile): Promise<FileStamp | null> {
        const stat = await this.app.vault.adapter.stat(file.path);
        return stat ? { mtime: stat.mtime, size: stat.size } : null;
    }

    /** Run `task` after all previously scheduled tasks for `path` have settled. */
    private exclusive<T>(path: string, task: () => Promise<T>): Promise<T> {
        const previous = this.queues.get(path) ?? Promise.resolve();
        const current = previous.then(task, task);
        const tail = current.then(() => { }, () => { });
        this.queues.set(path, tail);
        tail.then(() => {
            // Look the entry up by identity: onRename() may have moved it to another path.
            for (const [key, queue] of this.queues) {
                if (queue === tail) this.queues.delete(key);
            }
        });
        return current;
    }
}

function sameStamp(a: FileStamp | null, b: FileStamp | null) {
    return !!a && !!b && a.mtime === b.mtime && a.size === b.size;
}

/** pdf-lib and pdf.js return Uint8Arrays that may be views into larger buffers. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
