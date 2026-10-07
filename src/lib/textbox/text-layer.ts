import { PDFArray, PDFDict, PDFDocument, PDFFont, PDFHexString, PDFName, PDFNumber, PDFPage, PDFRef, PDFStream, PDFString, StandardFonts } from '@cantoo/pdf-lib';


/** Marks the content streams written here, so that they can be found and replaced on the next write. */
const MARKER = 'PDFPlusTextLayer';
const FONT_KEY = 'PDFPlusTL';
/** pdf.js' line height for text boxes, as a multiple of the font size. */
const LINE_HEIGHT = 1.35;

/**
 * Per page /Rotate: the reading direction in page space, and the corner of the Rect
 * (as indices into `[x1, y1, x2, y2]`) that is the top left of the displayed page.
 */
const ORIENTATIONS: Record<number, { dir: [number, number], corner: [number, number] }> = {
    0: { dir: [1, 0], corner: [0, 3] },
    90: { dir: [0, 1], corner: [0, 1] },
    180: { dir: [-1, 0], corner: [2, 1] },
    270: { dir: [0, -1], corner: [2, 3] },
};

/**
 * Make the text of the text boxes (FreeText annotations) searchable and selectable like an OCR layer:
 * per page, one extra content stream with the text as invisible text (render mode 3).
 *
 * Idempotent: the streams written by an earlier call are removed first, so the text layer always
 * matches the annotations as they are now (edited or deleted text boxes included).
 *
 * Doesn't use pdf-lib's page normalization, which wraps the page content in another `q`/`Q` on every
 * call. Instead the stream goes first, where the graphics state is still the initial one.
 *
 * Text is set in Helvetica, so characters outside WinAnsi are left out.
 * ponytail: ignores the annotation's own /Rotate and positions lines by pdf.js' line height, not exactly.
 */
export async function syncTextBoxTextLayer(doc: PDFDocument): Promise<void> {
    const pages = doc.getPages();
    // Remove everything first: pages can share inherited resources, and with them the font entry.
    pages.forEach(removeTextLayer);

    let font: PDFFont | undefined;
    for (const page of pages) {
        const { dir: [a, b], corner } = ORIENTATIONS[((page.getRotation().angle % 360) + 360) % 360] ?? ORIENTATIONS[0];
        const lines = textBoxLines(page, a, b, corner);
        if (!lines.length) continue;

        font ??= doc.embedStandardFont(StandardFonts.Helvetica);
        const encodable = new Set(font.getCharacterSet());
        const ops = lines
            .map((line) => ({ ...line, text: [...line.text].filter((c) => encodable.has(c.codePointAt(0)!)).join('') }))
            .filter((line) => line.text.trim())
            .map((line) => `/${FONT_KEY} ${line.size} Tf ${a} ${b} ${-b} ${a} ${line.x} ${line.y} Tm ${font!.encodeText(line.text)} Tj`);
        if (!ops.length) continue;

        fontsOf(page, true)!.set(PDFName.of(FONT_KEY), font.ref);
        const stream = doc.context.register(doc.context.stream(`q BT 3 Tr\n${ops.join('\n')}\nET Q`, { [MARKER]: true }));
        const contents = page.node.get(PDFName.of('Contents'));
        const array = doc.context.lookup(contents);
        if (array instanceof PDFArray) array.insert(0, stream);
        else page.node.set(PDFName.of('Contents'), doc.context.obj(contents ? [stream, contents] : [stream]));
    }
}

interface Line { text: string; x: number; y: number; size: number }

/** Remove the marked streams and the font entry, also from the document: pdf-lib saves every object in it. */
function removeTextLayer(page: PDFPage) {
    const { context } = page.doc;
    const contents = context.lookup(page.node.get(PDFName.of('Contents')));
    if (contents instanceof PDFArray) {
        for (let i = contents.size() - 1; i >= 0; i--) {
            const ref = contents.get(i);
            const stream = context.lookup(ref);
            if (stream instanceof PDFStream && stream.dict.has(PDFName.of(MARKER))) {
                contents.remove(i);
                if (ref instanceof PDFRef) context.delete(ref);
            }
        }
    }

    const fonts = fontsOf(page, false);
    const font = fonts?.get(PDFName.of(FONT_KEY));
    if (font) {
        fonts!.delete(PDFName.of(FONT_KEY));
        if (font instanceof PDFRef) context.delete(font);
    }
}

/** The page's font resources (possibly inherited), created if `create` is set. */
function fontsOf(page: PDFPage, create: boolean): PDFDict | undefined {
    const { context } = page.doc;
    let resources = page.node.Resources();
    if (!resources) {
        if (!create) return;
        resources = context.obj({});
        page.node.set(PDFName.of('Resources'), resources);
    }
    let fonts = resources.lookupMaybe(PDFName.of('Font'), PDFDict);
    if (!fonts && create) {
        fonts = context.obj({});
        resources.set(PDFName.of('Font'), fonts);
    }
    return fonts;
}

/** One entry per line of text of every text box on the page, starting at `corner` and reading along `(a, b)`. */
function textBoxLines(page: PDFPage, a: number, b: number, corner: [number, number]): Line[] {
    const lines: Line[] = [];
    for (const annot of page.node.Annots()?.asArray() ?? []) {
        const dict = page.doc.context.lookupMaybe(annot, PDFDict);
        if (dict?.get(PDFName.of('Subtype')) !== PDFName.of('FreeText')) continue;

        const text = decodePdfText(dict.get(PDFName.of('Contents')));
        const rect = dict.lookupMaybe(PDFName.of('Rect'), PDFArray)?.asArray().map((n) => (n as PDFNumber).asNumber());
        if (!text.trim() || rect?.length !== 4) continue;

        const size = fontSize(dict);
        text.trimEnd().split(/\r\n|\r|\n/).forEach((line, i) => {
            // Each line is further down the displayed page, i.e. along (b, -a).
            const offset = size + i * size * LINE_HEIGHT;
            lines.push({ text: line, x: rect[corner[0]] + b * offset, y: rect[corner[1]] - a * offset, size });
        });
    }
    return lines;
}

function decodePdfText(value: unknown): string {
    return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : '';
}

/** Font size from the default appearance string, e.g. `0 0 0 rg /Helv 10 Tf`. */
function fontSize(dict: PDFDict): number {
    const match = /([\d.]+)\s+Tf/.exec(decodePdfText(dict.get(PDFName.of('DA'))));
    return match ? parseFloat(match[1]) : 10;
}
