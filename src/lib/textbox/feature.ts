import { Menu, setIcon, setTooltip } from 'obsidian';

import { ViewerFeature } from 'lib/viewer-lifecycle';
import { showMenuUnderParentEl } from 'utils';
import { TextboxTool } from './tool';


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

        const fontSizeEl = createDiv(`clickable-icon ${TextboxTool.FONT_SIZE_CLS}`, (el) => {
            setTooltip(el, 'Font size');
            el.createSpan({ cls: 'pdf-plus-textbox-font-size-value', text: String(child.textbox?.fontSize ?? TextboxTool.defaultFontSize) });
            setIcon(el.createSpan(), 'lucide-chevron-down');
            el.toggle(!!child.textbox?.active);
            // Keep the focus in the text box being typed into.
            el.addEventListener('mousedown', (evt) => evt.preventDefault());
            el.addEventListener('click', () => {
                const tool = child.textbox;
                if (!tool) return;
                tool.rememberActiveEditor();
                const menu = new Menu();
                for (const size of TextboxTool.FONT_SIZES) {
                    menu.addItem((item) => {
                        item.setTitle(String(size))
                            .setChecked(size === tool.fontSize)
                            .onClick(() => tool.setFontSize(size));
                    });
                }
                showMenuUnderParentEl(menu, el);
            });
        });
        buttonEl.after(fontSizeEl);
        scope.register(() => fontSizeEl.remove());
    },
};
