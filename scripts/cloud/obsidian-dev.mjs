#!/usr/bin/env node
// Runs the plugin in a real, headless Obsidian (cloud sessions; see
// scripts/cloud/install-obsidian.sh) and drives it over CDP.
//
//   node scripts/cloud/obsidian-dev.mjs start [--no-build] [--keep-vault]
//   node scripts/cloud/obsidian-dev.mjs reload [--no-build]
//   node scripts/cloud/obsidian-dev.mjs open <vault path>
//   node scripts/cloud/obsidian-dev.mjs screenshot [out.png]
//   node scripts/cloud/obsidian-dev.mjs eval '<js expression>'
//   node scripts/cloud/obsidian-dev.mjs stop
//
// start: build, copy test-vault/ to $PDFPLUS_VAULT (default /tmp/pdfplus-vault)
// with a generated sample.pdf and the build, start Obsidian with its own config
// dir (the real ~/.config/obsidian is never touched), trust the vault, wait for
// the plugin, open sample.pdf and take a screenshot.
// reload: rebuild, copy the build into the vault and re-enable the plugin.
//
// Custom scripts can attach with playwright-core:
//   chromium.connectOverCDP('http://127.0.0.1:9222')
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VAULT = process.env.PDFPLUS_VAULT ?? '/tmp/pdfplus-vault';
const STATE = process.env.PDFPLUS_OBSIDIAN_STATE ?? '/tmp/pdfplus-obsidian';
const PORT = process.env.OBSIDIAN_CDP_PORT ?? '9222';
const CDP = `http://127.0.0.1:${PORT}`;
const VAULT_ID = 'pdfplustestvault';
const PLUGIN_DIR = join(VAULT, '.obsidian/plugins/pdf-plus');
const PID_FILE = join(STATE, 'pid');
const LOG_FILE = join(STATE, 'obsidian.log');
const DEFAULT_SHOT = join(STATE, 'screenshot.png');

const [cmd, ...args] = process.argv.slice(2);
const flag = (name) => args.includes(name);
const positional = args.filter((a) => !a.startsWith('--'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpUp() {
    try {
        return (await fetch(`${CDP}/json/version`)).ok;
    } catch {
        return false;
    }
}

function build() {
    execFileSync('npm', ['run', 'build'], { cwd: REPO, stdio: ['ignore', 'inherit', 'inherit'] });
}

function copyBuild() {
    mkdirSync(PLUGIN_DIR, { recursive: true });
    for (const f of ['main.js', 'styles.css', 'manifest.json']) {
        cpSync(join(REPO, f), join(PLUGIN_DIR, f));
    }
}

function prepareVault() {
    rmSync(VAULT, { recursive: true, force: true });
    cpSync(join(REPO, 'test-vault'), VAULT, { recursive: true });
    const sample = join(VAULT, 'sample.pdf');
    if (!existsSync(sample)) {
        execFileSync('node', [join(REPO, 'scripts/cloud/make-sample-pdf.mjs'), sample], { cwd: REPO, stdio: 'inherit' });
    }
}

async function connect() {
    const browser = await chromium.connectOverCDP(CDP);
    for (let i = 0; i < 60; i++) {
        const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().endsWith('/index.html'));
        if (page) return { browser, page };
        await sleep(500);
    }
    throw new Error('Obsidian window not found');
}

async function waitFor(page, fn, what, timeout = 30000) {
    try {
        await page.waitForFunction(fn, null, { timeout });
    } catch {
        throw new Error(`Timed out waiting for ${what} (log: ${LOG_FILE})`);
    }
}

async function start() {
    if (await cdpUp()) throw new Error('Obsidian is already running; use "reload" or "stop" first');
    if (!flag('--no-build')) build();
    if (!flag('--keep-vault') || !existsSync(VAULT)) prepareVault();
    copyBuild();

    // Separate config dir: Electron derives userData from XDG_CONFIG_HOME.
    const config = join(STATE, 'config');
    mkdirSync(join(config, 'obsidian'), { recursive: true });
    writeFileSync(join(config, 'obsidian/obsidian.json'), JSON.stringify({
        vaults: { [VAULT_ID]: { path: VAULT, ts: Date.now(), open: true } },
        updateDisabled: true,
    }));

    const log = openSync(LOG_FILE, 'w');
    const child = spawn(join(REPO, 'scripts/cloud/obsidian-headless.sh'), [], {
        detached: true,
        stdio: ['ignore', log, log],
        env: { ...process.env, XDG_CONFIG_HOME: config, OBSIDIAN_CDP_PORT: PORT },
    });
    child.unref();
    writeFileSync(PID_FILE, String(child.pid));

    for (let i = 0; !(await cdpUp()); i++) {
        if (i > 120) throw new Error('Obsidian did not open the CDP port within 60 s');
        await sleep(500);
    }
    const { browser, page } = await connect();
    await waitFor(page, () => window.app?.workspace?.layoutReady, 'the workspace');

    // First open of a vault with community plugins asks whether to trust it.
    const trust = page.getByText('Trust author and enable plugins');
    try {
        await trust.waitFor({ timeout: 5000 });
        await trust.click();
    } catch {
        await page.evaluate(async () => {
            if (!app.plugins.isEnabled()) await app.plugins.setEnable(true);
        });
    }
    await waitFor(page, () => window.pdfPlus, 'the plugin (window.pdfPlus)');

    await page.evaluate(() => window.require('electron').remote?.getCurrentWindow().setSize(1600, 1000));
    await openFile(page, 'sample.pdf');
    await page.screenshot({ path: DEFAULT_SHOT });
    await browser.close();
    console.log(`Obsidian running (CDP ${CDP}), vault ${VAULT}, screenshot ${DEFAULT_SHOT}`);
}

async function openFile(page, path) {
    await page.evaluate((p) => app.workspace.openLinkText(p, '', false), path);
    if (path.endsWith('.pdf')) {
        await waitFor(page, () => document.querySelector('.workspace-leaf.mod-active .pdfViewer .page .textLayer'), 'the PDF to render');
    }
    await sleep(500);
}

async function reload() {
    if (!(await cdpUp())) throw new Error('Obsidian is not running; use "start"');
    if (!flag('--no-build')) build();
    copyBuild();
    const { browser, page } = await connect();
    await page.evaluate(async () => {
        await app.plugins.disablePlugin('pdf-plus');
        await app.plugins.enablePlugin('pdf-plus');
    });
    await waitFor(page, () => window.pdfPlus && app.plugins.plugins['pdf-plus']?._loaded, 'the plugin');
    await browser.close();
    console.log('Plugin reloaded');
}

async function withPage(fn) {
    if (!(await cdpUp())) throw new Error('Obsidian is not running; use "start"');
    const { browser, page } = await connect();
    try {
        return await fn(page);
    } finally {
        await browser.close();
    }
}

function stop() {
    if (existsSync(PID_FILE)) {
        const pid = Number(readFileSync(PID_FILE, 'utf8'));
        try {
            process.kill(-pid, 'SIGTERM'); // whole process group: xvfb-run, Xvfb, Obsidian
        } catch { /* already gone */ }
        rmSync(PID_FILE);
    }
    console.log('Obsidian stopped');
}

const commands = {
    start,
    reload,
    stop,
    open: () => withPage(async (page) => {
        if (!positional[0]) throw new Error('usage: open <vault path>');
        await openFile(page, positional[0]);
    }),
    screenshot: () => withPage(async (page) => {
        const out = positional[0] ?? DEFAULT_SHOT;
        await page.screenshot({ path: out });
        console.log(out);
    }),
    eval: () => withPage(async (page) => {
        if (!positional[0]) throw new Error('usage: eval \'<js expression>\'');
        const result = await page.evaluate((src) => Promise.resolve((0, eval)(src)), positional[0]);
        console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    }),
};

if (!commands[cmd]) {
    console.error('usage: obsidian-dev.mjs start|reload|open|screenshot|eval|stop (see header comment)');
    process.exit(1);
}
mkdirSync(STATE, { recursive: true });
try {
    await commands[cmd]();
} catch (e) {
    console.error(String(e?.message ?? e));
    process.exit(1);
}
