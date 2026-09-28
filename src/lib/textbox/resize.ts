import { around } from 'monkey-around';

import PDFPlus from 'main';


/** Value of pdf.js' `AnnotationType.FREETEXT` (annotation data from the worker). */
const ANNOTATION_TYPE_FREETEXT = 3;

/** Class of text boxes with a width set by the user; their text wraps (see styles.css). */
const FIXED_WIDTH_CLS = 'pdf-plus-textbox-fixed-width';
const HANDLE_CLS = 'pdf-plus-textbox-handle';
const CORNERS = ['nw', 'ne', 'sw', 'se'] as const;
type Corner = typeof CORNERS[number];

/** Narrowest width a text box can be resized to, in multiples of its font size. */
const MIN_WIDTH_EM = 3;

/**
 * The parts of pdf.js' FreeText editor used here, plus the state this module keeps on it.
 * pdf-dist doesn't type the editors.
 */
interface FreeTextEditor {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
    div: HTMLElement | null;
    editorDiv?: HTMLElement;
    editorType: string;
    parentDimensions: [number, number];
    annotationElementId: string | null;
    isInEditMode(): boolean;
    fixAndSetPosition(): void;
    addToAnnotationStorage(): void;
    serialize(isForCopying?: boolean): Record<string, any> | null;

    /** Set iff the user gave the text box a size (now or in an earlier session); `width` is then that width. */
    pdfPlusFixedWidth?: boolean;
    /** Height set by the user, relative to the page. The text box grows beyond it if the text needs more room. */
    pdfPlusMinHeight?: number;
    /** Resized since loaded. pdf.js doesn't count that as a change of an existing annotation. */
    pdfPlusResized?: boolean;
    /** The text with the line breaks as displayed, from the last time it could be measured. */
    pdfPlusWrapped?: WrappedText;
    pdfPlusObserver?: MutationObserver;
}

/*
 * Text boxes with a size set by the user.
 *
 * The user sets the width and a minimum height; the text box grows if the text needs more room.
 * The height needs no special handling in the file: it is simply the annotation's /Rect.
 *
 * pdf.js' text boxes are as wide as their longest line, and pdf.js generates the appearance
 * stream (what other viewers show) from the text's own line breaks. Here, a text box with a
 * fixed width wraps its text on screen, and when it is saved, the text gets a line break
 * wherever it is wrapped on screen, so the file looks the same everywhere.
 *
 * To let the text flow again after reloading, the saved text (`/Contents`) marks which line
 * breaks came from wrapping:
 * - a line break that replaced a space is saved as " \n", a line break typed by the user as "\n"
 *   (with the line's trailing spaces removed);
 * - the text of a fixed-width text box ends with a space.
 * When pdf.js turns such an annotation into an editor again, the wrapped line breaks become
 * spaces again and the text box gets the width of the annotation.
 */

const patchedEditorClasses = new WeakSet<object>();
let layerPatched = false;

/** Patch pdf.js' annotation editor layer. Idempotent; undone when the plugin unloads. */
export function patchTextboxResizing(plugin: PDFPlus) {
    if (layerPatched) return;
    const AnnotationEditorLayer = (window.pdfjsLib as any)?.AnnotationEditorLayer;
    if (!AnnotationEditorLayer) return;
    layerPatched = true;

    plugin.register(around(AnnotationEditorLayer.prototype, {
        // Creates editors from existing annotations (and from copied editors).
        deserialize(old) {
            return async function (this: any, data: any) {
                const source = fixedWidthSource(data);
                if (source === null) return old.call(this, data);

                // pdf.js takes the text from the appearance stream (`textContent`), which has
                // all line breaks. Hand it the text without the wrapped ones.
                const editor: FreeTextEditor | null = await old.call(this, Object.create(data, {
                    textContent: { value: source.split('\n') },
                }));
                if (editor) {
                    editor.pdfPlusFixedWidth = true;
                    editor.pdfPlusMinHeight = editor.height;
                }
                return editor;
            };
        },
        add(old) {
            return function (this: any, editor: FreeTextEditor) {
                const ret = old.call(this, editor);
                if (editor?.editorType === 'freetext') {
                    patchEditorClass(plugin, editor.constructor);
                    setUpEditor(editor);
                }
                return ret;
            };
        },
    }));
    plugin.register(() => layerPatched = false);
}

function patchEditorClass(plugin: PDFPlus, editorClass: any) {
    if (patchedEditorClasses.has(editorClass)) return;
    patchedEditorClasses.add(editorClass);

    plugin.register(around(editorClass.prototype, {
        serialize(old) {
            return function (this: FreeTextEditor, isForCopying = false) {
                if (!this.pdfPlusFixedWidth || isForCopying) return old.call(this, isForCopying);

                let data = old.call(this, false);
                if (!data && this.pdfPlusResized && this.annotationElementId) {
                    // Unchanged except for the width: pdf.js would skip the annotation.
                    data = old.call(this, true);
                    if (data) {
                        delete data.isCopy;
                        data.id = this.annotationElementId;
                    }
                }
                if (!data || data.deleted || typeof data.value !== 'string') return data;

                const measured = measureWrappedText(this) ?? this.pdfPlusWrapped;
                // Only if it is the current text; the DOM may lag behind.
                if (measured && measured.source === trimLines(data.value)) data.value = measured.wrapped;
                return data;
            };
        },
    }));
}

/** Add the resize handles and apply the width. Called whenever the editor is added to a layer. */
function setUpEditor(editor: FreeTextEditor) {
    const div = editor.div;
    if (!div) return;

    if (!div.querySelector(':scope > .' + HANDLE_CLS)) {
        for (const corner of CORNERS) {
            const handle = div.createDiv({ cls: [HANDLE_CLS, `${HANDLE_CLS}-${corner}`] });
            handle.addEventListener('pointerdown', (evt) => startResize(editor, corner, evt));
            // Keep the focus in the text box being typed into; pdf.js ends editing on focusout.
            handle.addEventListener('mousedown', (evt) => evt.preventDefault());
        }
    }
    div.toggleClass('pdf-plus-textbox-resizable', editor.rotation === 0);

    if (editor.pdfPlusFixedWidth) {
        fixSize(editor);
        applySize(editor);
    }
}

/** Switch the text box to a fixed size, with wrapping text. */
function fixSize(editor: FreeTextEditor) {
    editor.pdfPlusFixedWidth = true;
    editor.div?.addClass(FIXED_WIDTH_CLS);
    normalizeTextNodes(editor);

    // pdf.js rewrites the text (e.g. on undo) with non-breaking spaces, where CSS can't wrap.
    if (!editor.pdfPlusObserver && editor.editorDiv) {
        editor.pdfPlusObserver = new MutationObserver(() => {
            if (!editor.isInEditMode()) normalizeTextNodes(editor);
        });
        editor.pdfPlusObserver.observe(editor.editorDiv, { childList: true });
    }
}

function applySize(editor: FreeTextEditor) {
    const style = editor.div?.style;
    if (!style) return;
    style.width = `${(editor.width * 100).toFixed(4)}%`;
    style.minHeight = editor.pdfPlusMinHeight ? `${(editor.pdfPlusMinHeight * 100).toFixed(4)}%` : '';
}

function startResize(editor: FreeTextEditor, corner: Corner, evt: PointerEvent) {
    if (evt.button !== 0 || editor.rotation !== 0 || !editor.div) return;
    // Keep pdf.js from dragging the text box.
    evt.stopPropagation();
    evt.preventDefault();

    const div = editor.div;
    const [parentWidth, parentHeight] = editor.parentDimensions;
    const { width: startWidth, height: startHeight } = div.getBoundingClientRect();
    const startLeft = editor.x * parentWidth;
    const startTop = editor.y * parentHeight;
    const startX = evt.clientX;
    const startY = evt.clientY;
    const fromLeft = corner === 'nw' || corner === 'sw';
    const fromTop = corner === 'nw' || corner === 'ne';
    const fontSize = editor.editorDiv ? parseFloat(getComputedStyle(editor.editorDiv).fontSize) : 10;
    const maxWidth = fromLeft ? startLeft + startWidth : parentWidth - startLeft;
    // An empty text box is only a few pixels wide; don't let it wrap after every character.
    const minWidth = Math.min(maxWidth, MIN_WIDTH_EM * (fontSize || 10));
    const maxHeight = fromTop ? startTop + startHeight : parentHeight - startTop;

    let lastEvent: PointerEvent | null = null;
    let frame: number | null = null;
    let resized = false;

    const update = () => {
        frame = null;
        if (!lastEvent) return;
        const dx = lastEvent.clientX - startX;
        const dy = lastEvent.clientY - startY;
        if (!resized) {
            if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return; // a click, not a drag
            resized = true;
            fixSize(editor);
        }

        const width = Math.max(minWidth, Math.min(maxWidth, fromLeft ? startWidth - dx : startWidth + dx));
        const minHeight = Math.max(0, Math.min(maxHeight, fromTop ? startHeight - dy : startHeight + dy));
        editor.width = width / parentWidth;
        editor.pdfPlusMinHeight = minHeight / parentHeight;
        applySize(editor);
        // Never smaller than the text needs.
        const height = div.getBoundingClientRect().height;
        editor.height = height / parentHeight;
        // Not fixAndSetPosition(): it makes pdf.js move the text box in the DOM, which ends the drag.
        if (fromLeft) {
            editor.x = (startLeft + startWidth - width) / parentWidth;
            div.style.left = `${(editor.x * 100).toFixed(4)}%`;
        }
        if (fromTop) {
            editor.y = (startTop + startHeight - height) / parentHeight;
            div.style.top = `${(editor.y * 100).toFixed(4)}%`;
        }
    };
    const onMove = (evt: PointerEvent) => {
        lastEvent = evt;
        frame ??= win.requestAnimationFrame(update);
    };
    const onEnd = () => {
        win.removeEventListener('pointermove', onMove, true);
        win.removeEventListener('pointerup', onEnd, true);
        win.removeEventListener('pointercancel', onEnd, true);
        if (frame !== null) win.cancelAnimationFrame(frame);
        update();
        div.removeClass('is-resizing');
        if (!resized) return;

        editor.fixAndSetPosition();
        editor.pdfPlusResized = true;
        editor.pdfPlusWrapped = measureWrappedText(editor) ?? undefined;
        // Existing annotations are in the storage already; new ones only once they have text.
        editor.addToAnnotationStorage();
    };

    // On the window rather than with pointer capture on the handle: the handle may leave the DOM.
    const win = div.win;
    div.addClass('is-resizing');
    win.addEventListener('pointermove', onMove, true);
    win.addEventListener('pointerup', onEnd, true);
    win.addEventListener('pointercancel', onEnd, true);
}

/**
 * The text of an existing FreeText annotation saved as a fixed-width text box, with the wrapped
 * line breaks turned back into spaces. `null` if `data` is anything else.
 */
function fixedWidthSource(data: any): string | null {
    if (data?.data?.annotationType !== ANNOTATION_TYPE_FREETEXT) return null;
    const raw = data.data.contentsObj?.str;
    if (typeof raw !== 'string' || !raw.endsWith(' ') || !raw.trim()) return null;

    // Only if the appearance stream still shows this text, i.e. no other app edited just one of them.
    const shown: string[] | undefined = data.textContent;
    if (!shown?.length || stripWhitespace(shown.join('')) !== stripWhitespace(raw)) return null;

    return decodeWrappedText(raw);
}

/** See the comment at the top. */
function decodeWrappedText(wrapped: string) {
    return wrapped.replace(/ $/, '').replaceAll(' \n', ' ');
}

interface WrappedText {
    /** Encoded as described at the top. */
    wrapped: string;
    /** The text as pdf.js has it, without the wrapped line breaks. */
    source: string;
}

/** The editor's text with a line break wherever it is wrapped on screen. `null` if it isn't displayed. */
function measureWrappedText(editor: FreeTextEditor): WrappedText | null {
    const editorDiv = editor.editorDiv;
    if (!editorDiv?.isConnected || !editor.div?.offsetParent) return null;

    const lineHeight = parseFloat(getComputedStyle(editorDiv).fontSize) || 10;
    const range = document.createRange();
    const wrapped: string[] = [];
    const source: string[] = [];

    // pdf.js puts each line typed by the user into a div of its own (or a text node or <br>),
    // and ignores a <br> right after a text node, like here.
    let prev: Node | null = null;
    for (const block of Array.from(editorDiv.childNodes)) {
        if (prev?.nodeType === Node.TEXT_NODE && block.nodeName === 'BR') continue;
        prev = block;

        const textNodes: Text[] = [];
        if (block.nodeType === Node.TEXT_NODE) textNodes.push(block as Text);
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

        let line = '';
        let whole = '';
        let top: number | null = null;
        for (const node of textNodes) {
            const text = (node.nodeValue ?? '').replaceAll('\xa0', ' ');
            for (let i = 0; i < text.length;) {
                const char = String.fromCodePoint(text.codePointAt(i)!);
                range.setStart(node, i);
                range.setEnd(node, i + char.length);
                const rect = range.getClientRects()[0];
                if (rect && rect.width > 0) {
                    if (top !== null && rect.top > top + lineHeight / 2) {
                        // Wrapped before this character: at a space, or inside a long word.
                        wrapped.push(line.endsWith(' ') ? line.trimEnd() + ' \n' : line + '\n');
                        line = '';
                    }
                    top = rect.top;
                }
                line += char;
                whole += char;
                i += char.length;
            }
        }
        wrapped.push(line.trimEnd() + '\n');
        source.push(whole.trimEnd());
    }

    const text = wrapped.join('').trimEnd();
    if (!text) return null;
    return { wrapped: text + ' ', source: source.join('\n').trimEnd() };
}

/** pdf.js writes spaces as non-breaking spaces; CSS can't wrap there. */
function normalizeTextNodes(editor: FreeTextEditor) {
    const editorDiv = editor.editorDiv;
    if (!editorDiv) return;
    const walker = document.createTreeWalker(editorDiv, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.nodeValue?.includes('\xa0')) node.nodeValue = node.nodeValue.replaceAll('\xa0', ' ');
    }
}

function trimLines(text: string) {
    return text.replaceAll('\xa0', ' ').split('\n').map((line) => line.trimEnd()).join('\n').trimEnd();
}

function stripWhitespace(text: string) {
    return text.replace(/\s+/g, '');
}
