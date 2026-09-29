import { Menu, Platform, setIcon, setTooltip } from 'obsidian';

import PDFPlus from 'main';
import { PDFPlusComponent } from 'lib/component';
import { ColorPalette } from 'color-palette';
import { FontSizeTarget, TextboxTool } from 'lib/textbox/tool';
import { PDFToolbar, PDFViewerChild } from 'typings';
import { showChildElOnParentElHover, showMenuUnderParentEl } from 'utils';
import { ScrollMode, SpreadMode } from 'pdfjs-enums';


export class PDFPlusToolbar extends PDFPlusComponent {
    static elInstanceMap = new Map<HTMLElement, PDFPlusToolbar>();

    toolbar: PDFToolbar;
    child: PDFViewerChild;

    constructor(plugin: PDFPlus, toolbar: PDFToolbar, child: PDFViewerChild) {
        super(plugin);
        this.toolbar = toolbar;
        this.child = child;
    }

    onload() {
        this.addColorPalette();
        this.addTextboxButton();
        this.replaceDisplayOptionsDropdown();
        this.addZoomLevelInputEl();
        this.makeDropdownInToolbarHoverable();
    }

    onunload() {

    }

    addColorPalette() {
        this.child.palette = this.addChild(
            new ColorPalette(this.plugin, this.child, this.toolbar.toolbarLeftEl)
        );
    }

    addTextboxButton() {
        const { toolbarLeftEl } = this.toolbar;
        // Toolbars are rebuilt on 'update-dom' without unloading the previous instance.
        toolbarLeftEl.querySelectorAll(`.${TextboxTool.BUTTON_CLS}, .${TextboxTool.FONT_SIZE_CLS}`).forEach((el) => el.remove());

        if (!this.lib.isEditable(this.child)) return;

        const buttonEl = toolbarLeftEl.createDiv(`clickable-icon ${TextboxTool.BUTTON_CLS}`, (el) => {
            setIcon(el, 'lucide-type');
            setTooltip(el, 'Add text box');
            el.toggleClass('is-active', !!this.child.textbox?.active);
            el.addEventListener('click', () => this.child.textbox?.toggle());
        });
        this.register(() => buttonEl.remove());

        const fontSizeEl = createDiv(TextboxTool.FONT_SIZE_CLS, (el) => {
            setTooltip(el, 'Font size');
            el.toggle(!!this.child.textbox?.active);

            // Buttons must not take the focus from the text box being typed into.
            const addButton = (icon: string, tooltip: string, onClick: (buttonEl: HTMLElement) => void) => {
                return el.createDiv('clickable-icon', (buttonEl) => {
                    setIcon(buttonEl, icon);
                    setTooltip(buttonEl, tooltip);
                    buttonEl.addEventListener('mousedown', (evt) => evt.preventDefault());
                    buttonEl.addEventListener('click', () => onClick(buttonEl));
                });
            };

            const inputEl = createEl('input', {
                cls: 'pdf-plus-textbox-font-size-value',
                type: 'text',
                attr: { inputmode: 'numeric', 'aria-label': 'Font size' },
                value: String(this.child.textbox?.fontSize ?? TextboxTool.defaultFontSize),
            });
            /** While the input has the focus: the text boxes the size applies to. */
            let inputTarget: FontSizeTarget | null = null;
            /** Whether the input holds a typed value that hasn't been applied yet. */
            let dirty = false;

            const showSize = () => {
                inputEl.value = String(this.child.textbox?.fontSize ?? TextboxTool.defaultFontSize);
                dirty = false;
            };
            const setSize = (size: number) => {
                const tool = this.child.textbox;
                if (!tool) return;
                // While the input has the focus, the text box gets it back when the input is done.
                if (inputTarget) tool.setFontSize(size, inputTarget, false);
                else tool.setFontSize(size);
                showSize();
            };
            const step = (delta: number) => {
                const tool = this.child.textbox;
                if (!tool) return;
                const typed = dirty ? parseFloat(inputEl.value.replace(',', '.')) : NaN;
                const size = isNaN(typed) ? tool.fontSize : typed;
                // Whole numbers only, also from sizes like 10.5 of existing annotations.
                setSize(TextboxTool.clampFontSize(delta > 0 ? Math.floor(size) + delta : Math.ceil(size) + delta));
            };
            const apply = () => {
                if (!dirty) return;
                const typed = parseFloat(inputEl.value.replace(',', '.'));
                if (isNaN(typed)) showSize();
                else setSize(TextboxTool.clampFontSize(typed));
            };
            const endInput = (returnFocus: boolean) => {
                const target = inputTarget;
                inputTarget = null;
                inputEl.win.removeEventListener('pointerdown', onPointerDown, true);
                if (target) this.child.textbox?.endFontSizeInput(target, returnFocus);
            };
            const beginInput = () => {
                if (inputTarget || !this.child.textbox) return;
                inputTarget = this.child.textbox.beginFontSizeInput();
                inputEl.win.addEventListener('pointerdown', onPointerDown, true);
            };
            // A click elsewhere ends the input before pdf.js handles it: applying the size moves
            // the text box (pdf.js keeps its top line in place), which pdf.js would otherwise
            // take for dragging it, and not select the text box that was clicked.
            const onPointerDown = (evt: PointerEvent) => {
                if (evt.target instanceof Node && el.contains(evt.target)) return;
                apply();
                endInput(false);
            };

            addButton('lucide-minus', 'Decrease font size', () => step(-1));
            el.append(inputEl);
            addButton('lucide-plus', 'Increase font size', () => step(1));

            // Before the focus moves, while the text box being typed into is still in edit mode.
            inputEl.addEventListener('pointerdown', () => {
                if (inputEl.ownerDocument.activeElement !== inputEl) beginInput();
            });
            inputEl.addEventListener('focus', () => {
                // Focused with the keyboard, or back from another window.
                beginInput();
                inputEl.select();
            });
            inputEl.addEventListener('input', () => dirty = true);
            inputEl.addEventListener('blur', () => {
                // Another window got the focus: continue when it comes back.
                if (!inputEl.ownerDocument.hasFocus()) return;
                apply();
                endInput(false);
                showSize();
            });
            inputEl.addEventListener('keydown', (evt) => {
                // Don't let pdf.js or Obsidian handle keys typed here.
                evt.stopPropagation();
                if (evt.key === 'Enter' || evt.key === 'Escape') {
                    // Don't let the key reach the text box that gets the focus back.
                    evt.preventDefault();
                    if (evt.key === 'Enter') apply();
                    else showSize();
                    endInput(true);
                    if (inputEl.ownerDocument.activeElement === inputEl) inputEl.blur();
                } else if (evt.key === 'ArrowUp' || evt.key === 'ArrowDown') {
                    evt.preventDefault();
                    step(evt.key === 'ArrowUp' ? 1 : -1);
                }
            });

            addButton('lucide-chevron-down', 'Font size presets', (buttonEl) => {
                const tool = this.child.textbox;
                if (!tool) return;
                // The menu may take the focus.
                const target = inputTarget ?? tool.captureFontSizeTarget();
                const menu = new Menu();
                for (const size of TextboxTool.FONT_SIZES) {
                    menu.addItem((item) => {
                        item.setTitle(String(size))
                            .setChecked(size === tool.fontSize)
                            .onClick(() => {
                                tool.setFontSize(size, target, !inputTarget);
                                showSize();
                            });
                    });
                }
                showMenuUnderParentEl(menu, buttonEl);
            });
        });
        buttonEl.after(fontSizeEl);
        this.register(() => fontSizeEl.remove());
    }

    makeDropdownInToolbarHoverable() {
        const { toolbar, plugin } = this;

        if (!plugin.settings.hoverableDropdownMenuInToolbar || Platform.isPhone) return;

        toolbar.toolbarLeftEl.querySelectorAll<HTMLElement>('div.clickable-icon')
            .forEach((buttonEl) => {
                const iconEl = buttonEl.firstElementChild;
                // Opening the font size presets on hover would take the keys typed into a text box.
                if (buttonEl.closest('.' + TextboxTool.FONT_SIZE_CLS)) return;
                if (iconEl && iconEl.matches('svg.lucide-chevron-down')) {
                    let childMenu: Menu | null = null;

                    showChildElOnParentElHover({
                        parentEl: buttonEl,
                        createChildEl: () => {
                            if (!buttonEl.hasClass('has-active-menu')) {
                                buttonEl.click();
                                for (const menu of plugin.shownMenus) {
                                    if (menu.parentEl === buttonEl) {
                                        childMenu = menu;
                                        return menu.dom;
                                    }
                                }
                            }
                            return childMenu = null;
                        },
                        removeChildEl: () => {
                            if (childMenu) {
                                childMenu.hide();
                                childMenu = null;
                            }
                        },
                        component: this.child.component,
                        timeout: 200,
                    });
                }
            });
    }

    replaceDisplayOptionsDropdown() {
        const { app, toolbar, child } = this;
        const clickableIconEl = toolbar.zoomInEl.nextElementSibling;
        if (!clickableIconEl?.hasClass('clickable-icon')) return;
        const svgIconEl = clickableIconEl.firstElementChild;
        if (!svgIconEl?.matches('svg.lucide-chevron-down')) return;

        const eventBus = toolbar.pdfViewer.eventBus;
        const pdfViewer = toolbar.pdfViewer.pdfViewer;
        if (!eventBus || !pdfViewer) return;

        toolbar.zoomInEl.after(createDiv('clickable-icon', (dropdownEl) => {
            setIcon(dropdownEl, 'lucide-chevron-down');
            setTooltip(dropdownEl, 'Display options');

            let shown = false;
            dropdownEl.addEventListener('click', () => {
                if (!shown) {
                    const currentScaleValue = pdfViewer.currentScaleValue;
                    const scrollMode = pdfViewer.scrollMode;
                    const spreadMode = pdfViewer.spreadMode;
                    const isThemed = !!app.loadLocalStorage('pdfjs-is-themed');
                    const menu = new Menu()
                        .addSections(['zoom', 'scroll', 'spread', 'appearance', 'settings'])
                        .addItem((item) => {
                            item.setSection('zoom')
                                .setIcon('lucide-move-horizontal')
                                .setTitle('Fit width')
                                .setChecked(currentScaleValue === 'page-width')
                                .onClick(() => {
                                    return eventBus.dispatch('scalechanged', {
                                        source: toolbar,
                                        value: 'page-width'
                                    });
                                });
                        })
                        .addItem((item) => {
                            item.setSection('zoom')
                                .setIcon('lucide-move-vertical')
                                .setTitle('Fit height')
                                .setChecked(currentScaleValue === 'page-height')
                                .onClick(() => {
                                    return eventBus.dispatch('scalechanged', {
                                        source: toolbar,
                                        value: 'page-height'
                                    });
                                });
                        })
                        .addItem((item) => {
                            item.setSection('zoom')
                                .setIcon('lucide-move')
                                .setTitle('Fit page')
                                .setChecked(currentScaleValue === 'page-fit')
                                .onClick(() => {
                                    return eventBus.dispatch('scalechanged', {
                                        source: toolbar,
                                        value: 'page-fit'
                                    });
                                });
                        })
                        .addItem((item) => {
                            item.setSection('scroll')
                                .setIcon('lucide-chevrons-up-down')
                                .setTitle('Vertical scroll')
                                .setChecked(scrollMode === ScrollMode.VERTICAL)
                                .onClick(() => {
                                    eventBus.dispatch('switchscrollmode', {
                                        source: toolbar,
                                        mode: ScrollMode.VERTICAL
                                    });
                                });
                        })
                        .addItem((item) => {
                            item.setSection('scroll')
                                .setIcon('lucide-chevrons-left-right')
                                .setTitle('Hotizontal scroll')
                                .setChecked(scrollMode === ScrollMode.HORIZONTAL)
                                .onClick(() => {
                                    eventBus.dispatch('switchscrollmode', {
                                        source: toolbar,
                                        mode: ScrollMode.HORIZONTAL
                                    });
                                });
                        })
                        .addItem((item) => {
                            item.setSection('scroll')
                                .setIcon('lucide-sticky-note')
                                .setTitle('In-page scroll')
                                .setChecked(scrollMode === ScrollMode.PAGE)
                                .onClick(() => {
                                    eventBus.dispatch('switchscrollmode', {
                                        source: toolbar,
                                        mode: ScrollMode.PAGE
                                    });
                                });
                        })
                        .addItem((item) => {
                            item.setSection('scroll')
                                .setIcon('lucide-wrap-text')
                                .setTitle('Wrapped scroll')
                                .setChecked(scrollMode === ScrollMode.WRAPPED)
                                .onClick(() => {
                                    eventBus.dispatch('switchscrollmode', {
                                        source: toolbar,
                                        mode: ScrollMode.WRAPPED
                                    });
                                });
                        })
                        .addItem((item) => {
                            item.setSection('spread')
                                .setIcon('lucide-rectangle-vertical')
                                .setTitle('Single page')
                                .setChecked(spreadMode === SpreadMode.NONE)
                                .onClick(() => {
                                    eventBus.dispatch('switchspreadmode', {
                                        source: toolbar,
                                        mode: SpreadMode.NONE
                                    });
                                });
                        })
                        .addItem((item) => {
                            item.setSection("spread")
                                .setIcon("rectangle-vertical-double")
                                .setTitle('Two pages (odd)')
                                .setChecked(spreadMode === SpreadMode.ODD)
                                .onClick(() => {
                                    eventBus.dispatch('switchspreadmode', {
                                        source: toolbar,
                                        mode: SpreadMode.ODD
                                    });
                                });
                        })
                        .addItem((item) => {
                            item.setSection('spread')
                                .setIcon('rectangle-vertical-double')
                                .setTitle('Two pages (even)')
                                .setChecked(spreadMode === SpreadMode.EVEN)
                                .onClick(() => {
                                    eventBus.dispatch('switchspreadmode', {
                                        source: toolbar,
                                        mode: SpreadMode.EVEN
                                    });
                                });
                        })
                        .addItem((item) => {
                            item.setSection('appearance')
                                .setIcon("lucide-palette")
                                .setTitle('Adapt to theme')
                                .setChecked(isThemed)
                                .onClick(() => {
                                    app.saveLocalStorage('pdfjs-is-themed', isThemed ? null : 'true');
                                    child.onCSSChange();
                                    // I also considered replacing the above line with this.app.workspace.trigger('css-change'),
                                    // but I decided to use PDF++'s custom event to avoid potential conflicts with core features.
                                    this.plugin.trigger('adapt-to-theme-change', { adapt: !isThemed });
                                });
                        })
                        .addItem((item) => {
                            item.setSection('settings')
                                .setIcon('lucide-settings')
                                .setTitle('Customize defaults...')
                                .onClick(() => {
                                    this.plugin.openSettingTab()
                                        .scrollToHeading('viewer-option');
                                });
                        });
                    menu.onHide(() => {
                        shown = false;
                    });
                    showMenuUnderParentEl(menu, dropdownEl);
                    shown = true;
                }
            });

            toolbar.toolbarEl.doc.win.setTimeout(() => {
                clickableIconEl.remove();
                toolbar.toolbarLeftEl.insertAfter(dropdownEl, toolbar.zoomInEl);
            });
        }));
    }

    addZoomLevelInputEl() {
        if (!this.settings.zoomLevelInputBoxInToolbar) return;

        const { toolbar } = this;

        const eventBus = toolbar.pdfViewer.eventBus;
        const pdfViewer = toolbar.pdfViewer.pdfViewer;
        if (!eventBus || !pdfViewer) return;

        const dividerEl = toolbar.zoomOutEl.nextElementSibling;
        if (!dividerEl?.hasClass('pdf-toolbar-divider')) return;
        dividerEl.remove();
        this.register(() => toolbar.zoomOutEl.after(createDiv('pdf-toolbar-divider')));

        toolbar.zoomOutEl.after(createEl('input', 'pdf-zoom-level-input', (inputEl) => {
            this.register(() => inputEl.remove());

            inputEl.type = 'number';
            inputEl.addEventListener('click', () => {
                return inputEl.select();
            });
            inputEl.addEventListener('change', () => {
                const value = inputEl.valueAsNumber / 100;
                const clamped = Math.min(Math.max(value, window.pdfjsViewer.MIN_SCALE), window.pdfjsViewer.MAX_SCALE);
                pdfViewer.currentScale = clamped;
            });
            eventBus.on('scalechanging', ({ scale }) => {
                inputEl.value = Math.round(scale * 100) + '';
            });
            if (pdfViewer.currentScale) {
                inputEl.value = Math.round(pdfViewer.currentScale * 100) + '';
            }

            inputEl.doc.win.setTimeout(() => {
                inputEl.after(createSpan({ cls: 'pdf-zoom-level-percent', text: '%' }, (spanEl) => {
                    this.register(() => spanEl.remove());
                }));
            });
        }));
    }
}
