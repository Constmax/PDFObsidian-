---
name: obsidian-dev
description: Run this plugin in a real headless Obsidian in a Claude Code cloud session and check a change there - start/reload Obsidian with the current build, open PDFs, click through the UI with Playwright, evaluate code against `pdfPlus`/`app`, take screenshots. Use whenever a change should be verified in Obsidian (the repo has no automated tests), or to look at the pdf.js Obsidian actually ships.
---

# Verify changes in a real Obsidian

The SessionStart hook (`.claude/hooks/session-start.sh`) installs a pinned Obsidian to `/opt/obsidian/current` in cloud sessions. `scripts/cloud/obsidian-dev.mjs` runs it headless (Xvfb) and drives it over CDP on `127.0.0.1:9222`. It never touches `~/.config/obsidian`; Obsidian's state lives in `/tmp/pdfplus-obsidian/` (log: `obsidian.log`).

If `/opt/obsidian/current/app/obsidian` is missing (hook didn't run, e.g. a multi-repo session), run `scripts/cloud/install-obsidian.sh`.

## Commands

```bash
D=scripts/cloud/obsidian-dev.mjs
node $D start                 # build, fresh vault, start, trust vault, open sample.pdf, screenshot
node $D start --no-build      # reuse main.js; --keep-vault keeps the vault from the last run
node $D reload                # rebuild, copy build into the vault, re-enable the plugin (~1 s)
node $D open sample.pdf       # open a vault file in the active leaf, wait for the text layer
node $D screenshot out.png    # default: /tmp/pdfplus-obsidian/screenshot.png
node $D eval '<js>'           # evaluated in Obsidian's window; result printed as JSON, promises awaited
node $D stop
```

After `start`/`screenshot`, look at the PNG with the Read tool. Send it to the user (SendUserFile) when it shows the result of their request.

## Vault

`test-vault/` is copied to `/tmp/pdfplus-vault` on every `start` (so edits to PDFs never dirty the repo), plus a generated 3-page `sample.pdf` (`make-sample-pdf.mjs`) and the build. Plugin settings: `test-vault/.obsidian/plugins/pdf-plus/data.json` (PDF editing on, author `Claude`; everything else defaults). To test with other settings or files, add them to `test-vault/` or change them at runtime:

```bash
node $D eval 'pdfPlus.settings.someSetting = true, pdfPlus.saveSettings()'
```

PDFs the plugin writes are in `/tmp/pdfplus-vault`; inspect them with `@cantoo/pdf-lib` or pdf.js from Node.

## Driving the UI

For clicks, typing and waiting, write a small ES module script in the scratchpad and run it from the repo root with `node --input-type=module < script.mjs`. Fed via stdin, `playwright-core` resolves from the repo's `node_modules`; a file outside the repo run with `node script.mjs` would not find it.

```js
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().endsWith('/index.html'));
// e.g. PDF++ commands: await page.evaluate(() => app.commands.executeCommandById('pdf-plus:<id>'));
const box = await page.locator('.workspace-leaf.mod-active .pdfViewer .page').first().boundingBox();
await page.mouse.click(box.x + 100, box.y + 150);
await page.keyboard.type('Hello');
await page.screenshot({ path: '/tmp/pdfplus-obsidian/after.png' });
await browser.close(); // disconnects only; Obsidian keeps running
```

Useful handles in the page: `app` (Obsidian), `pdfPlus` (plugin; `pdfPlus.lib`), the active PDF view's child via `app.workspace.activeLeaf.view.viewer.child` (`child.textbox`, `child.palette`, …), `window.pdfjsLib`. Collect console errors with `page.on('console', …)` before triggering an action.

## Caveats

- This is Obsidian for Linux at the version pinned in `scripts/cloud/install-obsidian.sh`. Say so when reporting results, and mention that the user's desktop version may ship a different pdf.js (`/opt/obsidian/current/src/lib/pdfjs/version.json`).
- The window is 1600×1000. Headless rendering uses software GL; it's fine for layout checks, not for performance measurements.
- Obsidian's update checks fail (blocked by the network policy), which keeps the version pinned. The log noise about dbus and update checks is harmless.
