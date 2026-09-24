import { PDFPlusLib } from 'lib';
import { toArrayBuffer } from 'lib/pdf-write-coordinator';


/** An annotation editor serialized by pdf.js (`AnnotationEditor.serialize()`), as it goes into the annotation storage. */
export interface SerializedEditor {
    annotationType: number;
    pageIndex: number;
    /** Object reference of the annotation this editor modifies (e.g. `"644R"`), or `null` for a new annotation. */
    id: string | null;
    deleted?: boolean;
    rect?: number[];
    value?: string;
    popupRef?: string;
    [key: string]: unknown;
}

/** The existing annotation an editor was created from, as it was when the viewer loaded the file. */
export interface DraftBase {
    id: string;
    annotationType: number;
    pageIndex: number;
    rect: number[];
    /** Text content, for annotation types that have one. */
    value?: string;
    /** The formatting the editor was loaded with. The replayed edit writes these values back. */
    style: AnnotationStyle;
}

/**
 * Formatting properties of an annotation that a replayed edit overwrites, in the form pdf.js'
 * editors take them from the annotation (`deserialize()`). Only those present are compared.
 */
export interface AnnotationStyle {
    color?: number[] | null;
    fontSize?: number;
    opacity?: number;
    thickness?: number;
    rotation?: number;
    comment?: string | null;
}

export const STYLE_KEYS = ['color', 'fontSize', 'opacity', 'thickness', 'rotation', 'comment'] as const;

/** `AnnotationType.FREETEXT` in pdf.js. */
const FREETEXT = 3;

/** pdf.js' worker only treats annotation storage entries whose key starts with this as editors to save. */
export const EDITOR_KEY_PREFIX = 'pdfjs_internal_editor_';

export interface Draft {
    /** Key in the annotation storage. Must start with `EDITOR_KEY_PREFIX` and be unique among the drafts. */
    key: string;
    data: SerializedEditor;
    /** Set iff `data.id` is not `null`. */
    base: DraftBase | null;
}

export interface RebaseReport {
    applied: number;
    /** Edits of existing annotations whose object number changed in the meantime. */
    remapped: number;
    /** Edits of annotations that are gone or were changed by someone else; saved as new annotations instead. */
    rescuedAsNew: number;
    /** Deletions of annotations that are gone anyway. */
    dropped: number;
}

/** How far a rectangle may move (in PDF points) and still count as the same annotation. */
const RECT_TOLERANCE = 0.5;

/**
 * Write `drafts` into `data` using pdf.js, the same way `saveDocument()` does, but based on
 * `data` instead of the (possibly outdated) bytes the viewer loaded.
 *
 * pdf.js passes annotation storage entries that are not editor instances to the worker
 * unchanged, so serialized editors can be replayed onto a fresh document.
 *
 * Edits of existing annotations refer to them by object number. When someone else rewrote
 * the file in the meantime, that number may now belong to a different object. Such edits are
 * therefore only applied to an annotation that still matches the version the edit was based on;
 * otherwise the text is saved as a new annotation rather than overwriting something unknown.
 */
export async function applyDrafts(lib: PDFPlusLib, data: ArrayBuffer, drafts: Draft[]): Promise<{ data: ArrayBuffer, report: RebaseReport }> {
    const report: RebaseReport = { applied: 0, remapped: 0, rescuedAsNew: 0, dropped: 0 };
    if (!drafts.length) return { data, report };

    // getDocument() transfers the buffer to the worker, which detaches it here.
    const doc = await lib.loadPDFDocumentFromArrayBuffer(data.slice(0));
    try {
        const annotationsCache = new Map<number, any[]>();
        const annotationsOn = async (pageIndex: number) => {
            let annots = annotationsCache.get(pageIndex);
            if (!annots) {
                annots = pageIndex < doc.numPages ? await (await doc.getPage(pageIndex + 1)).getAnnotations() : [];
                annotationsCache.set(pageIndex, annots);
            }
            return annots;
        };

        for (const draft of drafts) {
            const entry: SerializedEditor = { ...draft.data };

            if (entry.id !== null) {
                const current = draft.base && findAnnotation(await annotationsOn(draft.base.pageIndex), draft.base);
                if (current) {
                    if (current.id !== entry.id) report.remapped++;
                    entry.id = current.id;
                } else if (entry.deleted) {
                    report.dropped++;
                    continue;
                } else {
                    entry.id = null;
                    delete entry.popupRef;
                    report.rescuedAsNew++;
                }
            }

            doc.annotationStorage.setValue(draft.key, entry);
            report.applied++;
        }

        if (!report.applied) return { data, report };
        return { data: toArrayBuffer(await doc.saveDocument()), report };
    } finally {
        await doc.destroy();
    }
}

/** Find the annotation matching `base`, preferring the one that still has the same object number. */
function findAnnotation(annots: any[], base: DraftBase): any | undefined {
    const matches = (annot: any) => annot.annotationType === base.annotationType
        && rectsClose(annot.rect, base.rect)
        && (base.value === undefined || (annot.textContent ?? []).join('\n') === base.value)
        && stylesEqual(styleOf(annot), base.style);

    return annots.find((annot) => annot.id === base.id && matches(annot))
        ?? annots.find(matches);
}

/** The formatting of an annotation from `getAnnotations()`, taken the same way pdf.js' editors take it. */
function styleOf(annot: any): AnnotationStyle {
    return {
        color: normalizeColor(annot.annotationType === FREETEXT ? annot.defaultAppearanceData?.fontColor : annot.color),
        fontSize: annot.defaultAppearanceData?.fontSize,
        opacity: annot.opacity,
        thickness: annot.borderStyle?.rawWidth,
        rotation: annot.rotation,
        comment: annot.contentsObj?.str || null,
    };
}

export function normalizeColor(color: ArrayLike<number> | null | undefined): number[] | null {
    return color ? Array.from(color) : null;
}

/** Whether `current` has the same value as `base` for every property `base` has. */
function stylesEqual(current: AnnotationStyle, base: AnnotationStyle) {
    return STYLE_KEYS.every((key) => {
        if (!(key in base)) return true;
        const a = current[key], b = base[key];
        if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
        return (a ?? null) === (b ?? null);
    });
}

function rectsClose(a: number[] | undefined, b: number[]) {
    return !!a && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= RECT_TOLERANCE);
}
