import { Menu, setIcon, setTooltip } from 'obsidian';

import { ViewerFeature } from 'lib/viewer-lifecycle';
import { showMenuUnderParentEl } from 'utils';
import { FontSizeTarget, TextboxTool } from './tool';


export const textboxFeature: ViewerFeature = {
    name: 'text box tool',

    // Once per viewer, not per file load: unsaved text boxes must survive the reload that follows every write.
    viewer(scope, { plugin, child }) {
        child.textbox = scope.addChild(new TextboxTool(plugin, child));
    },

    toolbar(scope, { plugin, child, toolbar }) {
        if (!plugin.lib.isEditable(child)) return;

        const buttonEl = toolbar.toolbarLeftEl.createDiv(`clickable-icon ${TextboxTool.BUTTON_CLS}`, (el) => {
            setIcon(el, 'lucide-type');
            setTooltip(el, 'Add text box');
            el.toggleClass('is-active', !!child.textbox?.active);
            el.addEventListener('click', () => child.textbox?.toggle());
        });
        scope.register(() => buttonEl.remove());

        const fontSizeEl = createDiv(TextboxTool.FONT_SIZE_CLS, (el) => {
            setTooltip(el, 'Font size');
            el.toggle(!!child.textbox?.active);

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
                value: String(child.textbox?.fontSize ?? TextboxTool.defaultFontSize),
            });
            /** While the input has the focus: the text boxes the size applies to. */
            let inputTarget: FontSizeTarget | null = null;
            /** Whether the input holds a typed value that hasn't been applied yet. */
            let dirty = false;

            const showSize = () => {
                inputEl.value = String(child.textbox?.fontSize ?? TextboxTool.defaultFontSize);
                dirty = false;
            };
            const setSize = (size: number) => {
                const tool = child.textbox;
                if (!tool) return;
                // While the input has the focus, the text box gets it back when the input is done.
                if (inputTarget) tool.setFontSize(size, inputTarget, false);
                else tool.setFontSize(size);
                showSize();
            };
            const step = (delta: number) => {
                const tool = child.textbox;
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
                if (target) child.textbox?.endFontSizeInput(target, returnFocus);
            };
            const beginInput = () => {
                if (inputTarget || !child.textbox) return;
                inputTarget = child.textbox.beginFontSizeInput();
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
                const tool = child.textbox;
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
        scope.register(() => fontSizeEl.remove());
    },
};
