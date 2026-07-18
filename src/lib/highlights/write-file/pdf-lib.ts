import { RGB, TFile } from 'obsidian';
import { PDFArray, PDFDict, PDFDocument, PDFFont, PDFHexString, PDFName, PDFNull, PDFNumber, PDFPage, PDFRef, PDFString, StandardFonts, degrees, drawLinesOfText, rgb } from '@cantoo/pdf-lib';

import { PDFPlusLibSubmodule } from 'lib/submodule';
import { formatAnnotationID, getBorderRadius, hexToRgb } from 'utils';
import { Rect, DestArray } from 'typings';
import { IPdfIo, TextMarkupAnnotationSubtype } from '.';


export class PdfLibIO extends PDFPlusLibSubmodule implements IPdfIo {

    async addTextMarkupAnnotation(file: TFile, pageNumber: number, rects: Rect[], subtype: TextMarkupAnnotationSubtype, colorName?: string, contents?: string) {
        if (!this.plugin.settings.author) {
            throw new Error(`${this.plugin.manifest.name}: The author name is not set. Please set it in the plugin settings.`);
        }

        return await this.process(file, (pdfDoc) => {
            const page = pdfDoc.getPage(pageNumber - 1);
            const { r, g, b } = this.plugin.domManager.getRgb(colorName);
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
                Rect: geometry.mergeRectangles(...rects),
                QuadPoints: geometry.rectsToQuadPoints(rects),
                // For Contents & T, make sure to pass a PDFString, not a raw string!!
                // https://github.com/Hopding/pdf-lib/issues/555#issuecomment-670243166
                Contents: PDFHexString.fromText(contents ?? ''),
                M: PDFString.fromDate(new Date()),
                T: PDFHexString.fromText(this.plugin.settings.author),
                CA: subtype === 'Highlight' ? this.plugin.settings.writeHighlightToFileOpacity : 1.0,
                Border: subtype === 'Highlight' ? [borderRadius, borderRadius, 0] : undefined,
                C: [r / 255, g / 255, b / 255],
            });

            const annotationID = formatAnnotationID(ref.objectNumber, ref.generationNumber);
            return annotationID;
        });
    }
    
    async addHighlightAnnotation(file: TFile, pageNumber: number, rects: Rect[], colorName?: string, contents?: string) {
        return await this.addTextMarkupAnnotation(file, pageNumber, rects, 'Highlight', colorName, contents);
    }

    async addLinkAnnotation(file: TFile, pageNumber: number, rects: Rect[], dest: DestArray | string, colorName?: string, contents?: string) {
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
                Rect: geometry.mergeRectangles(...rects),
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
     * Adds a free text annotation (a text box whose text is directly shown on the page,
     * see 12.5.6.6 "Free Text Annotations" in the PDF spec) to the specified position.
     *
     * @param pos The position of the top-left corner of the text box (in the on-screen sense,
     * i.e. taking the page rotation into account), in PDF user space coordinates.
     * @returns A promise resolving to the ID of the newly created annotation.
     */
    async addFreeTextAnnotation(file: TFile, pageNumber: number, pos: { x: number, y: number }, contents: string, options?: { fontSize?: number, colorHex?: string }) {
        if (!this.plugin.settings.author) {
            throw new Error(`${this.plugin.manifest.name}: The author name is not set. Please set it in the plugin settings.`);
        }

        return await this.process(file, async (pdfDoc) => {
            const page = pdfDoc.getPage(pageNumber - 1);
            const fontSize = options?.fontSize ?? this.plugin.settings.freeTextFontSize;
            const { r, g, b } = hexToRgb(options?.colorHex ?? this.plugin.settings.freeTextColor) ?? { r: 0, g: 0, b: 0 };

            const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
            const layout = this.computeFreeTextLayout(font, contents, fontSize);
            const rect = this.computeFreeTextRect(page, pos, layout.width, layout.height);

            const ref = this.addAnnotation(page, {
                Subtype: 'FreeText',
                Rect: rect,
                // For Contents & T, make sure to pass a PDFString, not a raw string!!
                // https://github.com/Hopding/pdf-lib/issues/555#issuecomment-670243166
                Contents: PDFHexString.fromText(contents),
                // The default appearance string is required for free text annotations
                // and carries the font and the text color (Table 174 in PDF 32000-1:2008).
                DA: PDFString.of(`/Helv ${fontSize} Tf ${(r / 255).toFixed(4)} ${(g / 255).toFixed(4)} ${(b / 255).toFixed(4)} rg`),
                Q: 0, // left-justified
                M: PDFString.fromDate(new Date()),
                T: PDFHexString.fromText(this.plugin.settings.author),
                CA: 1.0,
                F: 4, // the "Print" flag: make the text survive printing
            });

            const annot = page.node.context.lookup(ref, PDFDict);
            try {
                this.writeFreeTextAppearance(page, annot, font, contents, fontSize, { r, g, b });
            } catch (e) {
                // Failed to generate the appearance stream, most probably because the text contains
                // characters that cannot be encoded in the standard Helvetica font (e.g. CJK).
                // The annotation is still valid without an appearance stream; pdf.js (hence Obsidian)
                // renders it from Contents & DA, but some external viewers might not display it.
                console.warn(`${this.plugin.manifest.name}: Falling back to a free text annotation without an appearance stream.`, e);
            }

            return formatAnnotationID(ref.objectNumber, ref.generationNumber);
        });
    }

    computeFreeTextLayout(font: PDFFont, contents: string, fontSize: number) {
        const lines = contents.split(/\r?\n/);
        const pad = 4;
        const lineHeight = fontSize * 1.2;
        const ascent = font.heightAtSize(fontSize, { descender: false });

        const encodable = lines.every((line) => this.canEncodeInStandardFont(font, line));
        let width: number;
        if (encodable) {
            width = Math.max(...lines.map((line) => font.widthOfTextAtSize(line, fontSize))) + 2 * pad;
        } else {
            // The text contains characters that cannot be encoded in the standard fonts
            // (e.g. CJK); fall back to a rough (generous) estimate of one em per character.
            width = Math.max(...lines.map((line) => Array.from(line).length)) * fontSize + 2 * pad;
        }
        const height = lines.length * lineHeight + 2 * pad;

        return { lines, width, height, pad, lineHeight, ascent, encodable };
    }

    /**
     * Checks whether the given single-line text can be faithfully encoded in the given standard font.
     * Some pdf-lib versions throw on unencodable characters while others silently replace them
     * with "?", so both cases must be detected.
     */
    canEncodeInStandardFont(font: PDFFont, line: string): boolean {
        const codePoints = Array.from(line);
        let hex: string;
        try {
            hex = font.encodeText(line).toString(); // e.g. '<48656C6C6F>'
        } catch {
            return false;
        }
        if ((hex.length - 2) / 2 !== codePoints.length) return false;
        for (let i = 0; i < codePoints.length; i++) {
            if (hex.substr(2 * i + 1, 2).toUpperCase() === '3F' && codePoints[i] !== '?') return false;
        }
        return true;
    }

    /**
     * Computes the value of the Rect entry of a free text annotation such that the text box
     * appears with the given on-screen size at the given position (= the on-screen top-left corner
     * of the box), taking the page rotation into account.
     */
    computeFreeTextRect(page: PDFPage, pos: { x: number, y: number }, width: number, height: number): [number, number, number, number] {
        const rotation = ((page.getRotation().angle % 360) + 360) % 360;

        // The on-screen "right" and "down" directions expressed in PDF user space
        const directions: Record<number, { right: [number, number], down: [number, number] }> = {
            0: { right: [1, 0], down: [0, -1] },
            90: { right: [0, 1], down: [1, 0] },
            180: { right: [-1, 0], down: [0, 1] },
            270: { right: [0, -1], down: [-1, 0] }
        };
        const { right, down } = directions[rotation] ?? directions[0];

        const corner = {
            x: pos.x + width * right[0] + height * down[0],
            y: pos.y + width * right[1] + height * down[1]
        };

        const [left, bottom, rectRight, top] = [
            Math.min(pos.x, corner.x), Math.min(pos.y, corner.y),
            Math.max(pos.x, corner.x), Math.max(pos.y, corner.y)
        ];

        // Shift the rectangle so that it does not stick out of the page (as long as it fits)
        const box = page.getCropBox();
        const shiftX = Math.max(box.x - left, Math.min(0, box.x + box.width - rectRight));
        const shiftY = Math.max(box.y - bottom, Math.min(0, box.y + box.height - top));

        return [left + shiftX, bottom + shiftY, rectRight + shiftX, top + shiftY];
    }

    /**
     * Generates an appearance stream (the AP entry) for a free text annotation so that
     * the text reliably shows up in external PDF viewers as well.
     * Throws if the text cannot be encoded in the standard Helvetica font.
     */
    writeFreeTextAppearance(page: PDFPage, annot: PDFDict, font: PDFFont, contents: string, fontSize: number, color: RGB) {
        const context = page.doc.context;
        const { lines, width, height, pad, lineHeight, ascent, encodable } = this.computeFreeTextLayout(font, contents, fontSize);
        const rotation = ((page.getRotation().angle % 360) + 360) % 360;

        if (!encodable) {
            throw new Error(`${this.plugin.manifest.name}: The text contains characters that cannot be encoded in the standard Helvetica font.`);
        }

        const encodedLines = lines.map((line) => font.encodeText(line));
        const operators = drawLinesOfText(encodedLines, {
            color: rgb(color.r / 255, color.g / 255, color.b / 255),
            font: 'Helv',
            size: fontSize,
            rotate: degrees(0),
            xSkew: degrees(0),
            ySkew: degrees(0),
            x: pad,
            y: height - pad - ascent, // the baseline of the first line
            lineHeight,
        });

        // Rotate the appearance to compensate for the page rotation so that the text
        // appears upright on the screen. The viewer maps the bounding box of the
        // Matrix-transformed BBox onto Rect (8.4.4 "Appearance Streams" in the PDF spec),
        // so no translation is needed here.
        const matrices: Record<number, number[]> = {
            0: [1, 0, 0, 1, 0, 0],
            90: [0, 1, -1, 0, 0, 0],
            180: [-1, 0, 0, -1, 0, 0],
            270: [0, -1, 1, 0, 0, 0]
        };
        const matrix = matrices[rotation] ?? matrices[0];

        const streamRef = context.register(
            context.formXObject(operators, {
                Resources: { Font: { Helv: font.ref } },
                BBox: [0, 0, width, height],
                Matrix: matrix,
            })
        );
        annot.set(PDFName.of('AP'), context.obj({ N: streamRef }));
    }

    /**
     * Re-generates the appearance stream of a free text annotation after its contents
     * have been modified. No-op for other annotation types.
     */
    async refreshFreeTextAppearance(pdfDoc: PDFDocument, page: PDFPage, annot: PDFDict) {
        if (annot.get(PDFName.of('Subtype')) !== PDFName.of('FreeText')) return;

        const contents = this.getContentsFromAnnotation(annot) ?? '';

        // Recover the font size & text color from the default appearance string
        let fontSize = this.plugin.settings.freeTextFontSize;
        let color: RGB = { r: 0, g: 0, b: 0 };
        const da = annot.get(PDFName.of('DA'));
        if (da instanceof PDFString || da instanceof PDFHexString) {
            const daStr = da.decodeText();
            const fontMatch = daStr.match(/\/\S+\s+([\d.]+)\s+Tf/);
            if (fontMatch) fontSize = parseFloat(fontMatch[1]);
            const colorMatch = daStr.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/);
            if (colorMatch) {
                color = {
                    r: Math.round(parseFloat(colorMatch[1]) * 255),
                    g: Math.round(parseFloat(colorMatch[2]) * 255),
                    b: Math.round(parseFloat(colorMatch[3]) * 255)
                };
            }
        }

        // Keep the on-screen top-left corner of the box where it is and re-size the Rect for the new contents
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const oldRect = annot.get(PDFName.of('Rect'));
        if (oldRect instanceof PDFArray) {
            const [left, bottom, right, top] = oldRect.asArray().map((obj) => obj instanceof PDFNumber ? obj.asNumber() : 0);
            const rotation = ((page.getRotation().angle % 360) + 360) % 360;
            const topLeftCorners: Record<number, { x: number, y: number }> = {
                0: { x: left, y: top },
                90: { x: left, y: bottom },
                180: { x: right, y: bottom },
                270: { x: right, y: top }
            };
            const pos = topLeftCorners[rotation] ?? topLeftCorners[0];

            const layout = this.computeFreeTextLayout(font, contents, fontSize);
            const newRect = this.computeFreeTextRect(page, pos, layout.width, layout.height);
            annot.set(PDFName.of('Rect'), page.doc.context.obj(newRect));
        }

        try {
            this.writeFreeTextAppearance(page, annot, font, contents, fontSize, color);
        } catch (e) {
            // The new text cannot be encoded in the standard Helvetica font (e.g. CJK):
            // remove the stale appearance stream & let the viewer render the annotation from Contents & DA.
            annot.delete(PDFName.of('AP'));
            console.warn(`${this.plugin.manifest.name}: Removed the appearance stream of a free text annotation because the new text cannot be encoded in the standard Helvetica font.`, e);
        }
    }

    async process<T>(file: TFile, fn: (pdfDoc: PDFDocument) => T) {
        const pdfDoc = await this.lib.loadPdfLibDocument(file);

        const ret = await fn(pdfDoc);

        await this.app.vault.modifyBinary(file, await pdfDoc.save());
        return ret;
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
        await this.processAnnotation(file, pageNumber, id, async (annot, pdfDoc, page) => {
            this.setContentsToAnnotation(annot, content);
            // For free text annotations, the contents are directly displayed on the page,
            // so the appearance stream must be kept in sync (no-op for other subtypes)
            await this.refreshFreeTextAppearance(pdfDoc, page, annot);
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

    async processAnnotation(file: TFile, pageNumber: number, id: string, fn: (annot: PDFDict, pdfDoc: PDFDocument, page: PDFPage) => any): Promise<void> {
        return await this.process(file, async (pdfDoc) => {
            const page = pdfDoc.getPage(pageNumber - 1);
            const ref = this.findAnnotationRef(page, id);
            if (ref) {
                const annot = page.node.context.lookup(ref, PDFDict);
                await fn(annot, pdfDoc, page);
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
