# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This is a fork of [PDF++](https://github.com/RyotaUshio/obsidian-pdf-plus) (Obsidian plugin, `id: pdf-plus`). The fork adds in-file editing features (text box tool, coordinated writes) on top of upstream.

## Commands

```bash
npm run build      # tsc -noEmit type check + esbuild production bundle -> main.js
npm run dev        # esbuild watch mode, inline sourcemaps
npm run lint       # eslint src/
```

- The lockfile is `pnpm-lock.yaml` (upstream uses pnpm); `npm run …` works as well.
- There are no automated tests. Changes are verified by loading the plugin in Obsidian.
- To try a build, copy `main.js` and `styles.css` into a vault's `.obsidian/plugins/pdf-plus/`, then reload Obsidian (or toggle the plugin). The test vault is `../PDF++Test`.
- In the Obsidian dev console the plugin instance is available as the global `pdfPlus`.

## Runtime environment

- pdf.js is **not bundled**: `pdfjs-dist` is external and only provides types (v5.x). At runtime the plugin uses Obsidian's own pdf.js via `window.pdfjsLib` / `window.pdfjsViewer`, loaded with `loadPdfJs()`. Obsidian currently ships **pdf.js 4.9** (`lib/pdfjs/pdf.min.mjs` inside `/Applications/Obsidian.app/Contents/Resources/obsidian.asar`). Check APIs against that version, not against `node_modules`.
- Private pdf.js internals (annotation editor UI manager, editor layers, `_layerProperties`, …) are untyped; code declares small local interfaces for the parts it uses (see `src/lib/textbox/tool.ts`).
- Imports resolve from `src/` (`baseUrl: ./src`), e.g. `import { PDFPlusLib } from 'lib'`, `from 'utils'`, `from 'typings'`.
- Code style: 4-space indentation in `.ts` (despite `.editorconfig` saying tabs; `main.ts` and `settings.ts` use tabs), semicolons required.

## Architecture

**Entry point** `src/main.ts` (`PDFPlus extends Plugin`): loads settings, creates `DomManager`, patches Obsidian, registers commands/events. `this.lib` (`src/lib/index.ts`, `PDFPlusLib`) is the central API object; its submodules (`commands`, `copyLink`, `highlight`, `workspace`, `composer`, `writer`, …) extend `PDFPlusLibSubmodule` and reach each other through `this.lib`. UI pieces extend `PDFPlusComponent` (an Obsidian `Component` with `plugin`/`lib`/`settings` getters).

**Monkey-patching** (`src/patchers/`, via `monkey-around`): PDF++ has no viewer of its own; it patches Obsidian's built-in PDF view. `patchPDFView` / `patchPDFInternalFromPDFEmbed` are retried until an instance exists (`tryPatchUntilSuccess`), and `pdf-internals.ts` patches the prototypes of `PDFViewerComponent` and `PDFViewerChild`. Most per-viewer features (toolbar, color palette, backlink visualizer, text box tool, double-click word selection) are attached in the patched `PDFViewerChild` load hook and live on the child object (`child.palette`, `child.textbox`, …; typed in `src/typings.d.ts`). Toolbars are rebuilt on DOM updates without unloading the old instance, so toolbar code removes stale elements itself.

**Two kinds of annotations**:
- *Backlink highlights* (the default, upstream's main feature): links in Markdown notes like `[[file.pdf#page=1&selection=…&color=…]]` are indexed and drawn over the text layer (`backlink-visualizer.ts`, `lib/pdf-backlink-index.ts`). Nothing is written to the PDF. A text selection is encoded as text-layer node index + offset (`lib/copy-link.ts` `getTextSelectionRange`); selections whose boundaries are not inside `.textLayerNode` elements can't be encoded, and actions silently do nothing.
- *In-file annotations* (only when setting `enablePDFEdit` is on **and** `author` is non-empty): written with `@cantoo/pdf-lib` (`lib/highlights/write-file/pdf-lib.ts`), outlines, page labels, composer, text boxes.

**All writes to PDF files go through `lib.writer`** (`src/lib/pdf-write-coordinator.ts`): it serializes writes per file, re-reads the current content inside the lock, detects third-party modifications by file stamp and retries, and merges *draft sources* into every write. Use `writer.modify` / `modifyWithPdfLib`; never call `vault.modifyBinary` on a PDF directly. Any write reloads every viewer of that file.

**Text box tool** (`src/lib/textbox/`): uses pdf.js' FreeText annotation editor (which Obsidian ships but doesn't expose). `tool.ts` switches the editor mode and places editors on click; `drafts.ts` (`PDFViewerDrafts`) captures unsaved editors from pdf.js' annotation storage and registers them as a draft source with the writer, so they survive reloads and are included in every write; `rebase.ts` replays drafts onto the current file bytes via a fresh pdf.js document. Font size uses pdf.js' `FREETEXT_SIZE` param, so pdf.js writes it into the annotation itself. Obsidian ships no annotation-editor CSS; the needed styles are in `styles.css`.

**Settings** (`src/settings.ts`): add a field to `PDFPlusSettings`, a default to `DEFAULT_SETTINGS`, and UI in `PDFPlusSettingTab.display()` using the `add*Setting` helpers.

## Workflow in this fork

- Create a GitHub issue (`gh issue create`, repo `Constmax/PDFObsidian-`) before starting on a feature or bug.
- `release` (Python) is upstream's release script; it switches to `main` and bumps versions.

## Upstream development principles (README)

- Always stick to Obsidian's built-in PDF viewer.
- Avoid plugin-dependent artifacts unless they bring a massive benefit and don't leave a mess once the plugin is removed.
