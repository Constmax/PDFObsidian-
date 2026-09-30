// Writes a small multi-page text PDF (real text layer, standard font) to the
// given path. Used by obsidian-dev.mjs so the test vault needs no binary fixture.
import { writeFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';

const out = process.argv[2];
if (!out) {
    console.error('usage: node make-sample-pdf.mjs <out.pdf>');
    process.exit(1);
}

const paragraph = 'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. '
    + 'How vexingly quick daft zebras jump! Sphinx of black quartz, judge my vow.';

const doc = await PDFDocument.create();
doc.setTitle('PDF++ sample');
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

for (let n = 1; n <= 3; n++) {
    const page = doc.addPage([595, 842]); // A4
    page.drawText(`Page ${n}`, { x: 60, y: 770, size: 24, font: bold });
    let y = 730;
    for (let i = 1; i <= 8; i++) {
        page.drawText(`${n}.${i} ${paragraph}`, {
            x: 60, y, size: 11, font, color: rgb(0, 0, 0), maxWidth: 475, lineHeight: 15,
        });
        y -= 80;
    }
}

await writeFile(out, await doc.save());
