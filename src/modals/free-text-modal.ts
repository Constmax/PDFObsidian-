import { Notice, Setting, TextAreaComponent, TFile } from 'obsidian';

import PDFPlus from 'main';
import { PDFPlusModal } from 'modals';
import { getModifierNameInPlatform } from 'utils';
import { PDFViewerChild } from 'typings';


/**
 * A modal for entering the text of a free text annotation to be written into a PDF file
 * at the given position (see ColorPalette.prototype.startFreeTextPlacement).
 */
export class PDFFreeTextModal extends PDFPlusModal {
    child: PDFViewerChild;
    file: TFile;
    pageNumber: number;
    /** The on-screen top-left corner of the text box in PDF user space coordinates. */
    x: number;
    y: number;

    textarea: TextAreaComponent | null;
    fontSize: number;
    colorHex: string;

    constructor(plugin: PDFPlus, child: PDFViewerChild, file: TFile, pageNumber: number, x: number, y: number) {
        super(plugin);
        this.child = child;
        this.file = file;
        this.pageNumber = pageNumber;
        this.x = x;
        this.y = y;

        this.textarea = null;
        this.fontSize = plugin.settings.freeTextFontSize;
        this.colorHex = plugin.settings.freeTextColor;

        this.containerEl.addClass('pdf-plus-free-text-modal');

        this.scope.register(['Mod'], 'Enter', () => {
            this.save();
        });
    }

    onOpen() {
        super.onOpen();

        this.titleEl.setText(`${this.plugin.manifest.name}: add text to PDF`);

        new Setting(this.contentEl)
            .setName('Text')
            .setDesc('This text will be written into the PDF file as a "FreeText" annotation, which is supported by the standard PDF format and thus visible in external PDF viewers as well.')
            .addTextArea((textarea) => {
                this.textarea = textarea;
                textarea.inputEl.rows = 5;
                textarea.inputEl.setCssStyles({ width: '100%' });
            });

        new Setting(this.contentEl)
            .setName('Font size')
            .addSlider((slider) => {
                slider.setLimits(6, 48, 1)
                    .setValue(this.fontSize)
                    .setDynamicTooltip()
                    .onChange((value) => {
                        this.fontSize = value;
                    });
            });

        new Setting(this.contentEl)
            .setName('Text color')
            .addColorPicker((picker) => {
                picker.setValue(this.colorHex)
                    .onChange((value) => {
                        this.colorHex = value;
                    });
            });

        new Setting(this.contentEl)
            .addButton((button) => {
                button.setButtonText('Add')
                    .setCta()
                    .onClick(() => {
                        this.save();
                    });
            })
            .addButton((button) => {
                button.setButtonText('Cancel')
                    .onClick(() => this.close());
            })
            .setClass('no-border')
            .then((setting) => {
                setting.controlEl.createDiv({
                    cls: 'pdf-plus-annotation-edit-modal-save-instructions',
                    text: `Press ${getModifierNameInPlatform('Mod')} + Enter to save.`
                });
            });

        setTimeout(() => this.textarea?.inputEl.focus());
    }

    async save() {
        const contents = this.textarea?.getValue() ?? '';
        this.close();
        if (!contents.trim()) return;

        const palette = this.lib.getColorPaletteFromChild(this.child);
        palette?.setStatus('Writing text into file...', 10000);

        try {
            await this.lib.highlight.writeFile.addFreeTextAnnotationAt(
                this.file, this.pageNumber, this.x, this.y, contents,
                { fontSize: this.fontSize, colorHex: this.colorHex }
            );
            // The file modification causes the PDF viewer to be reloaded, so we have to
            // re-fetch the palette after the reload to show the status message.
            setTimeout(() => {
                this.lib.getColorPaletteFromChild(this.child)?.setStatus('Text added to file', 2000);
            }, 300);
        } catch (e) {
            new Notice(`${this.plugin.manifest.name}: An error occurred while attempting to add the text. See the developer console for the details.`);
            console.error(e);
        }
    }
}
