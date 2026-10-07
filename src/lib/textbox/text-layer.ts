import { PDFArray, PDFDict, PDFDocument, PDFFont, PDFHexString, PDFName, PDFNumber, PDFPage, PDFRef, PDFStream, PDFString, StandardFonts } from '@cantoo/pdf-lib';


/** Marks the content streams written here, so that they can be found and replaced on the next write. */
const MARKER = PDFName.of('PDFPlusTextLayer');
const FONT_KEY = 'PDFPlusTL';
/** pdf.js' line height for text boxes, as a multiple of the font size. */
const LINE_HEIGHT = 1.35;

/**
 * Make the text of the text boxes (FreeText annotations) searchable and selectable like an OCR layer:
 * per page, one extra content stream with the text as invisible text (render mode 3).
 *
 * Idempotent: the streams written by an earlier call are removed first, so the text layer always
 * matches the annotations as they are now (edited or deleted text boxes included).
 *
 * Text is set in Helvetica, so characters outside WinAnsi are left out.
 * ponytail: ignores the annotation's own /Rotate and positions lines by pdf.js' line height, not exactly.
 */
export async function syncTextBoxTextLayer(doc: PDFDocument): Promise<void> {
    let font: PDFFont | undefined;

    for (const page of doc.getPages()) {
        const contents = page.node.normalizedEntries().Contents;
        removeMarkedStreams(page, contents);

        const lines = textBoxLines(page);
        if (!lines.length) continue;

        font ??= doc.embedStandardFont(StandardFonts.Helvetica);
        const known = new Set(font.getCharacterSet());
        const ops = lines
            .map((line) => ({ ...line, text: [...line.text].filter((c) => known.has(c.codePointAt(0)!)).join('') }))
            .filter((line) => line.text.trim())
            .map((line) => `/${FONT_KEY} ${line.size} Tf ${textMatrix(page.getRotation().angle, line.x, line.y)} Tm ${font!.encodeText(line.text)} Tj`);
        if (!ops.length) continue;

        page.node.newFontDictionary(FONT_KEY, font.ref);
        const stream = doc.context.stream(`q BT 3 Tr\n${ops.join('\n')}\nET Q`, { PDFPlusTextLayer: true });
        page.node.addContentStream(doc.context.register(stream));
    }
}

interface Line { text: string; x: number; y: number; size: number }

function removeMarkedStreams(page: PDFPage, contents: PDFArray | undefined) {
    if (!contents) return;
    for (let i = contents.size() - 1; i >= 0; i--) {
        const ref = contents.get(i);
        const stream = page.doc.context.lookup(ref);
        if (stream instanceof PDFStream && stream.dict.has(MARKER)) {
            contents.remove(i);
            // pdf-lib saves every object in the context, referenced or not.
            if (ref instanceof PDFRef) page.doc.context.delete(ref);
        }
    }
}

/** One entry per line of text of every text box on the page. */
function textBoxLines(page: PDFPage): Line[] {
    const lines: Line[] = [];
    for (const annot of page.node.Annots()?.asArray() ?? []) {
        const dict = page.doc.context.lookupMaybe(annot, PDFDict);
        if (dict?.get(PDFName.of('Subtype')) !== PDFName.of('FreeText')) continue;

        const text = decode(dict.get(PDFName.of('Contents')));
        const rect = dict.lookupMaybe(PDFName.of('Rect'), PDFArray)?.asArray().map((n) => (n as PDFNumber).asNumber());
        if (!text.trim() || rect?.length !== 4) continue;

        const size = fontSize(dict);
        const [x1, y1, x2, y2] = rect;
        const rotation = page.getRotation().angle;
        text.trimEnd().split(/\r\n|\r|\n/).forEach((line, i) => {
            // Lines are laid out from the corner that is the top left of the rotated page.
            const offset = size + i * size * LINE_HEIGHT;
            const [x, y] = rotation === 90 ? [x1 + offset, y1]
                : rotation === 180 ? [x2, y1 + offset]
                : rotation === 270 ? [x2 - offset, y2]
                : [x1, y2 - offset];
            lines.push({ text: line, x, y, size });
        });
    }
    return lines;
}

/** Text matrix for text that reads left to right on a page displayed with the given /Rotate. */
function textMatrix(rotation: number, x: number, y: number) {
    const [a, b] = rotation === 90 ? [0, 1] : rotation === 180 ? [-1, 0] : rotation === 270 ? [0, -1] : [1, 0];
    return `${a} ${b} ${-b} ${a} ${x} ${y}`;
}

function decode(value: unknown): string {
    return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : '';
}

/** Font size from the default appearance string, e.g. `0 0 0 rg /Helv 10 Tf`. */
function fontSize(dict: PDFDict): number {
    const match = /([\d.]+)\s+Tf/.exec(decode(dict.get(PDFName.of('DA'))));
    return match ? parseFloat(match[1]) : 10;
}
