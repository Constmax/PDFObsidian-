import { describe, expect, it } from 'vitest';

import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFPage, PDFString } from '@cantoo/pdf-lib';

import { syncTextBoxTextLayer } from '../src/lib/textbox/text-layer';


function fonts(page: PDFPage) {
    return page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict);
}

async function docWithTextBox(contents: string, rotate = 0) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 300]);
    page.setRotation({ type: 'degrees' as any, angle: rotate });
    const annot = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'FreeText', Rect: [10, 200, 100, 250],
        Contents: PDFHexString.fromText(contents), DA: PDFString.of('0 0 0 rg /Helv 12 Tf'),
    }));
    page.node.set(PDFName.of('Annots'), doc.context.obj([annot]));
    return { doc, page, annot };
}

/** The decoded text streams written by syncTextBoxTextLayer, as plain strings. */
function layerStreams(doc: PDFDocument) {
    return doc.context.enumerateIndirectObjects()
        .map(([, obj]) => obj as any)
        .filter((obj) => obj.dict?.has(PDFName.of('PDFPlusTextLayer')))
        .map((obj) => new TextDecoder().decode(obj.contents ?? obj.getContents()));
}

describe('syncTextBoxTextLayer', () => {
    it('writes each line as invisible text at the top of the box', async () => {
        const { doc } = await docWithTextBox('Hallo\nWelt');
        await syncTextBoxTextLayer(doc);
        const [stream] = layerStreams(doc);
        expect(stream).toContain('3 Tr');
        expect(stream).toContain('1 0 0 1 10 238 Tm'); // 250 - 12
        expect(stream).toContain('1 0 0 1 10 221.8 Tm'); // 250 - 12 - 12 * 1.35
    });

    it('is idempotent and follows edits and deletions', async () => {
        const { doc, page, annot } = await docWithTextBox('alt');
        await syncTextBoxTextLayer(doc);
        await syncTextBoxTextLayer(doc);
        expect(layerStreams(doc)).toHaveLength(1);

        (doc.context.lookup(annot) as any).set(PDFName.of('Contents'), PDFHexString.fromText('neu'));
        await syncTextBoxTextLayer(doc);
        expect(layerStreams(doc)).toHaveLength(1);

        page.node.delete(PDFName.of('Annots'));
        await syncTextBoxTextLayer(doc);
        expect(layerStreams(doc)).toHaveLength(0);
        expect(fonts(page).get(PDFName.of('PDFPlusTL'))).toBeUndefined();
    });

    it('registers the font under the name the stream uses, once', async () => {
        const { doc, page } = await docWithTextBox('x');
        await syncTextBoxTextLayer(doc);
        await syncTextBoxTextLayer(doc);
        expect(layerStreams(doc)[0]).toContain('/PDFPlusTL 12 Tf');
        expect(fonts(page).keys().map(String)).toEqual(['/PDFPlusTL']);
    });

    it('leaves the existing page content as it is', async () => {
        const { doc, page } = await docWithTextBox('x');
        const content = doc.context.register(doc.context.stream('0 0 m 10 10 l S'));
        page.node.set(PDFName.of('Contents'), content);
        const other = doc.addPage();
        other.node.set(PDFName.of('Contents'), content);

        for (let i = 0; i < 3; i++) await syncTextBoxTextLayer(doc);
        expect((page.node.Contents() as PDFArray).asArray()).toEqual([expect.anything(), content]);
        expect(other.node.get(PDFName.of('Contents'))).toBe(content);
    });

    it('turns the lines with the page rotation', async () => {
        const { doc } = await docWithTextBox('x', 90);
        await syncTextBoxTextLayer(doc);
        expect(layerStreams(doc)[0]).toContain('0 1 -1 0 22 200 Tm');
    });

    it('survives a save and load', async () => {
        const { doc } = await docWithTextBox('Größe §');
        await syncTextBoxTextLayer(doc);
        const again = await PDFDocument.load(await doc.save());
        expect(layerStreams(again)).toHaveLength(1);
    });
});
