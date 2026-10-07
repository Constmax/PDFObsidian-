import { RGB, TFile } from 'obsidian';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, PDFPage, PDFRef, PDFString } from '@cantoo/pdf-lib';

import { PDFPlusLibSubmodule } from 'lib/submodule';
import { formatAnnotationID, getBorderRadius, hexToRgb } from 'utils';
import { DestArray } from 'typings';
import { IPdfIo, TextMarkupAnnotationSubtype } from '.';
import { RotatedRect, boundingRect, corners, rotate } from '../rotation';


export class PdfLibIO extends PDFPlusLibSubmodule implements IPdfIo {

    async addTextMarkupAnnotation(file: TFile, pageNumber: number, rects: RotatedRect[], subtype: TextMarkupAnnotationSubtype, colorName?: string, contents?: string) {
        if (!this.plugin.settings.author) {
            throw new Error('The annotation author is not set. Please set it in the plugin settings.');
        }

        return await this.process(file, (pdfDoc) => {
            const page = pdfDoc.getPage(pageNumber - 1);
            const { r, g, b } = this.plugin.domManager.getRgb(colorName);
            const color = [r / 255, g / 255, b / 255];
            const opacity = this.plugin.settings.writeHighlightToFileOpacity;
            const borderRadius = getBorderRadius();
            const geometry = this.lib.highlight.geometry;

            // Since pdf-lib does not provide a high-level API to add annotation to a PDF file,
            // we have to interact with some low-level objects.
            // Note that pdf-lib has functions like drawRectangle, but it does not produce referenceable annotations.
            // For the meaning of each entry, refer to the PDF specification:
            // - 12.5.2 "Annotation Dictionaries", 
            // - 12.5.6.2 "Markup Annotations" and 
            // - 12.5.6.10 "Text Markup Annotations".
            const ref = this.addAnnotation(page, {
                Subtype: subtype,
                Rect: boundingRect(rects),
                QuadPoints: geometry.rectsToQuadPoints(rects),
                // For Contents & T, make sure to pass a PDFString, not a raw string!!
                // https://github.com/Hopding/pdf-lib/issues/555#issuecomment-670243166
                Contents: PDFHexString.fromText(contents ?? ''),
                M: PDFString.fromDate(new Date()),
                T: PDFHexString.fromText(this.plugin.settings.author),
                CA: subtype === 'Highlight' ? opacity : 1.0,
                Border: subtype === 'Highlight' ? [borderRadius, borderRadius, 0] : undefined,
                C: color,
                // pdf.js draws text markups from the bounding boxes of the quads, so tilted ones need their own appearance
                AP: rects.some((rect) => rect.angle) ? this.addTiltedAppearance(pdfDoc, subtype, rects, color, opacity) : undefined,
            });

            const annotationID = formatAnnotationID(ref.objectNumber, ref.generationNumber);
            return annotationID;
        });
    }
    
    async addHighlightAnnotation(file: TFile, pageNumber: number, rects: RotatedRect[], colorName?: string, contents?: string) {
        return await this.addTextMarkupAnnotation(file, pageNumber, rects, 'Highlight', colorName, contents);
    }

    async addLinkAnnotation(file: TFile, pageNumber: number, rects: RotatedRect[], dest: DestArray | string, colorName?: string, contents?: string) {
        return await this.process(file, (pdfDoc) => {
            const page = pdfDoc.getPage(pageNumber - 1);
            const rgb = hexToRgb(this.plugin.settings.pdfLinkColor);
            const { r, g, b } = rgb ?? { r: 0, g: 0, b: 0 };
            const geometry = this.lib.highlight.geometry;

            let Dest;
            if (typeof dest === 'string') {
                Dest = PDFString.of(dest);
            } else {
                const targetPageRef = pdfDoc.getPage(dest[0]).ref;
                Dest = [targetPageRef, dest[1], ...dest.slice(2).map((num: number | null): PDFNumber | typeof PDFNull => typeof num === 'number' ? PDFNumber.of(num) : PDFNull)];
            }

            const ref = this.addAnnotation(page, {
                Subtype: 'Link',
                Rect: boundingRect(rects),
                QuadPoints: geometry.rectsToQuadPoints(rects),
                Dest,
                M: PDFString.fromDate(new Date()),
                Border: [0, 0, this.plugin.settings.pdfLinkBorder ? 1 : 0],
                C: [r / 255, g / 255, b / 255],
            });

            const annotationID = formatAnnotationID(ref.objectNumber, ref.generationNumber);
            return annotationID;
        });
    }

    /**
     * An appearance like the default one pdf.js draws for highlights and underlines, but following the rotated quads.
     * Returns undefined for the other subtypes, which keep pdf.js' default appearance.
     */
    addTiltedAppearance(pdfDoc: PDFDocument, subtype: TextMarkupAnnotationSubtype, rects: RotatedRect[], color: number[], opacity: number) {
        const fmt = (x: number) => x.toFixed(3);
        let content, resources;
        if (subtype === 'Highlight') {
            const quads = rects.map((rect) => {
                const [ltx, lty, rtx, rty, lbx, lby, rbx, rby] = corners(rect).map(fmt);
                return `${ltx} ${lty} m ${rtx} ${rty} l ${rbx} ${rby} l ${lbx} ${lby} l h`;
            });
            content = [`${color.map(fmt).join(' ')} rg`, '/R0 gs', ...quads, 'f'];
            // pdf.js only uses an existing highlight appearance if it has an ExtGState
            resources = { ExtGState: { R0: { Type: 'ExtGState', BM: 'Multiply', ca: opacity } } };
        } else if (subtype === 'Underline') {
            // like pdf.js: a 0.571 wide line 1.3 above the bottom of each quad
            const lines = rects.map(({ rect: [left, bottom, right], angle }) => {
                const [x1, y1, x2, y2] = [...rotate(left, bottom + 1.3, angle), ...rotate(right, bottom + 1.3, angle)].map(fmt);
                return `${x1} ${y1} m ${x2} ${y2} l`;
            });
            content = [`${color.map(fmt).join(' ')} RG`, '[] 0 d 0.571 w', ...lines, 'S'];
        } else {
            return undefined;
        }
        const context = pdfDoc.context;
        const stream = context.register(context.stream(content.join('\n'), {
            Type: 'XObject',
            Subtype: 'Form',
            FormType: 1,
            BBox: boundingRect(rects),
            Resources: resources,
        }));
        return { N: stream };
    }

    async process<T>(file: TFile, fn: (pdfDoc: PDFDocument) => T) {
        return await this.lib.writer.modifyWithPdfLib(file, fn);
    }

    async read<T>(file: TFile, fn: (pdfDoc: PDFDocument) => T) {
        const pdfDoc = await this.lib.loadPdfLibDocument(file);
        return await fn(pdfDoc);
    }

    addAnnotation(page: PDFPage, annotDict: Record<string, any>): PDFRef {
        const context = page.doc.context;
        const ref = context.register(
            context.obj({
                Type: 'Annot',
                ...annotDict
            })
        );
        page.node.addAnnot(ref);
        // page.node.set(PDFName.of('Annots'), context.obj([...page.node.Annots()?.asArray() ?? [], ref]));
        return ref;
    }

    async deleteAnnotation(file: TFile, pageNumber: number, id: string) {
        await this.process(file, (pdfDoc) => {
            const page = pdfDoc.getPage(pageNumber - 1);
            const ref = this.findAnnotationRef(page, id);
            if (ref) page.node.removeAnnot(ref);
        });
    }

    async getAnnotationContents(file: TFile, pageNumber: number, id: string): Promise<string | null> {
        const annot = await this.getAnnotation(file, pageNumber, id);
        if (annot) {
            const contents = this.getContentsFromAnnotation(annot);
            return contents ?? null;
        }
        return null;
    }

    async setAnnotationContents(file: TFile, pageNumber: number, id: string, content: string): Promise<void> {
        await this.processAnnotation(file, pageNumber, id, (annot) => {
            this.setContentsToAnnotation(annot, content);
        });
    }

    async getAnnotationColor(file: TFile, pageNumber: number, id: string): Promise<RGB | null> {
        const annot = await this.getAnnotation(file, pageNumber, id);
        if (annot) {
            return this.getColorFromAnnotation(annot) ?? null;
        }
        return null;
    }

    async setAnnotationColor(file: TFile, pageNumber: number, id: string, rgb: RGB): Promise<any> {
        await this.processAnnotation(file, pageNumber, id, async (annot) => {
            this.setColorToAnnotation(annot, rgb);
        });
    }

    async getAnnotationOpacity(file: TFile, pageNumber: number, id: string): Promise<number | null> {
        const annot = await this.getAnnotation(file, pageNumber, id);
        if (annot) {
            return this.getOpacityFromAnnotation(annot) ?? null;
        }
        return null;
    }

    async setAnnotationOpacity(file: TFile, pageNumber: number, id: string, opacity: number): Promise<any> {
        await this.processAnnotation(file, pageNumber, id, async (annot) => {
            this.setOpacityToAnnotation(annot, opacity);
        });
    }

    findAnnotationRef(page: PDFPage, id: string): PDFRef | undefined {
        return page.node.Annots()
            ?.asArray()
            .find((ref): ref is PDFRef => {
                return ref instanceof PDFRef
                    && formatAnnotationID(ref.objectNumber, ref.generationNumber) === id;
            });
    }

    async getAnnotation(file: TFile, pageNumber: number, id: string): Promise<PDFDict | null> {
        return await this.read(file, (pdfDoc) => {
            const page = pdfDoc.getPage(pageNumber - 1);
            const ref = this.findAnnotationRef(page, id);
            return ref ? page.node.context.lookup(ref, PDFDict) : null;
        });
    }

    async processAnnotation(file: TFile, pageNumber: number, id: string, fn: (annot: PDFDict) => any): Promise<void> {
        return await this.process(file, async (pdfDoc) => {
            const page = pdfDoc.getPage(pageNumber - 1);
            const ref = this.findAnnotationRef(page, id);
            if (ref) {
                const annot = page.node.context.lookup(ref, PDFDict);
                await fn(annot);
            }
        });
    }

    getColorFromAnnotation(annot: PDFDict) {
        const appearanceStream = annot.get(PDFName.of('AP'));
        if (!appearanceStream) {
            const color = annot.get(PDFName.of('C'));
            if (color instanceof PDFArray) {
                const colorArray = color.asArray();

                // non-RGB color is not supported for now
                if (colorArray.length === 3) {
                    const [r, g, b] = colorArray.map((c) => {
                        if (c instanceof PDFNumber) {
                            return Math.round(c.asNumber() * 255);
                        }
                        throw new Error(`${this.plugin.manifest.name}: Invalid color`);
                    });
                    return { r, g, b };
                }
            }
        }
    }

    setColorToAnnotation(annot: PDFDict, rgb: RGB) {
        const color = annot.get(PDFName.of('C'));
        if (color instanceof PDFArray) {
            color.set(0, PDFNumber.of(rgb.r / 255));
            color.set(1, PDFNumber.of(rgb.g / 255));
            color.set(2, PDFNumber.of(rgb.b / 255));
        }
    }

    getContentsFromAnnotation(annot: PDFDict) {
        const contents = annot.get(PDFName.of('Contents'));
        // Use decodeText, not asString, to avoid encoding issues
        if (contents instanceof PDFString || contents instanceof PDFHexString) return contents.decodeText();
    }

    setContentsToAnnotation(annot: PDFDict, contents: string) {
        // Use PDFHextString.fromText, not PDFString.of, to avoid encoding issues
        // https://github.com/Hopding/pdf-lib/issues/516
        annot.set(PDFName.of('Contents'), PDFHexString.fromText(contents));
    }

    getOpacityFromAnnotation(annot: PDFDict) {
        const appearanceStream = annot.get(PDFName.of('AP'));
        if (!appearanceStream) { // see Table 170 in PDF 32000-1:2008 
            const opacity = annot.get(PDFName.of('CA'));
            if (opacity instanceof PDFNumber) return opacity.asNumber();
        }
    }

    setOpacityToAnnotation(annot: PDFDict, opacity: number) {
        annot.set(PDFName.of('CA'), PDFNumber.of(opacity));
    }

    getAuthorFromAnnotation(annot: PDFDict) {
        const author = annot.get(PDFName.of('T'));
        // Use decodeText, not asString, to avoid encoding issues
        if (author instanceof PDFString || author instanceof PDFHexString) return author.decodeText();
    }

    setAuthorToAnnotation(annot: PDFDict, author: string) {
        // Use PDFHextString.fromText, not PDFString.of, to avoid encoding issues
        // https://github.com/Hopding/pdf-lib/issues/516
        annot.set(PDFName.of('T'), PDFHexString.fromText(author));
    }

    getBorderWidthFromAnnotation(annot: PDFDict) {
        const border = annot.get(PDFName.of('Border'));
        if (border instanceof PDFArray) {
            const borderWidth = border.asArray()[2];
            if (borderWidth instanceof PDFNumber) return borderWidth.asNumber();
        }
    }

    setBorderWidthToAnnotation(annot: PDFDict, width: number) {
        const border = annot.get(PDFName.of('Border'));
        if (border instanceof PDFArray) {
            border.set(2, PDFNumber.of(width));
        }
    }
}
