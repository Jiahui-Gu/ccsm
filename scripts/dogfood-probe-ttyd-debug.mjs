// Diagnostic probe — captures Electron <webview> console + load events
// for the ttyd-hosted xterm. Drives the same flow as
// dogfood-probe-happy-path.mjs (boot → click new session → wait for
// webview mount), but also subscribes to the main process stdout AND
// uses electronApp.evaluate() to install a `web-contents-created` hook
// that forwards every webview's console / did-fail-load / did-finish-load
// back to this probe via stdout.
//
// Output:
//   docs/screenshots/ttyd-webview-debug/console.log  — full transcript
//   docs/screenshots/ttyd-webview-debug/04-after-15s.png — screenshot

import { _electron as electron } from 'playwright';
import { rmSync, mkdirSync, createWriteStream } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

const userData = path.resolve('.dogfood-userdata-ttyd-debug');
rmSync(userData, { recursive: true, force: true });
mkdirSync(userData, { recursive: true });

const outDir = path.resolve('docs/screenshots/ttyd-webview-debug');
mkdirSync(outDir, { recursive: true });
const logPath = path.join(outDir, 'console.log');
const logStream = createWriteStream(logPath, { flags: 'w' });
const log = (...parts) => {
  const line = parts.join(' ');
  console.log(line);
  logStream.write(line + '\n');
};

const realClaudeConfigDir = path.join(homedir(), '.claude');

const electronApp = await electron.launch({
  args: ['.', `--user-data-dir=${userData}`],
  env: {
    ...process.env,
    ELECTRON_DISABLE_GPU: '1',
    NODE_ENV: 'production',
    CCSM_PROD_BUNDLE: '1',
    CCSM_CLAUDE_CONFIG_DIR: realClaudeConfigDir,
    CLAUDE_CONFIG_DIR: realClaudeConfigDir,
    CCSM_DEBUG_WEBVIEW: '1',
  },
  timeout: 60000,
});

// Capture the Electron main process stdout/stderr so the
// CCSM_DEBUG_WEBVIEW=1 hook output (which writes to the *main* process
// console.log) actually lands in our log file.
const mainProc = electronApp.process();
mainProc.stdout?.on('data', (b) => log('[main stdout]', b.toString().trimEnd()));
mainProc.stderr?.on('data', (b) => log('[main stderr]', b.toString().trimEnd()));

// Belt-and-suspenders: install the hook ALSO from inside main via
// evaluate(), in case the env-gated branch isn't running for some reason
// (e.g. dist out of sync).
await electronApp.evaluate(({ app }) => {
  const fired = (tag, ...rest) => process.stdout.write(`[evaluate-hook ${tag}] ${rest.join(' ')}\n`);
  fired('installed');
  app.on('web-contents-created', (_event, contents) => {
    const t = contents.getType();
    fired('web-contents-created', `type=${t}`);
    if (t !== 'webview') return;
    contents.on('console-message', (_e, level, message, line, source) => {
      fired('console', `[${level}] ${source}:${line} ${message}`);
    });
    contents.on('did-fail-load', (_e, code, desc, url) => {
      fired('did-fail-load', `code=${code} desc=${desc} url=${url}`);
    });
    contents.on('did-finish-load', () => {
      fired('did-finish-load', contents.getURL());
    });
    contents.on('did-start-loading', () => fired('did-start-loading', ''));
    contents.on('dom-ready', () => fired('dom-ready', contents.getURL()));
    contents.on('render-process-gone', (_e, details) => {
      fired('render-process-gone', `reason=${details.reason} exit=${details.exitCode}`);
    });
  });
});

const win = await electronApp.firstWindow();
win.on('console', (msg) => log('[renderer console]', msg.type(), msg.text()));
win.on('pageerror', (err) => log('[renderer pageerror]', String(err)));

await win.waitForLoadState('domcontentloaded');
await new Promise((r) => setTimeout(r, 4500));
log('[probe] booted');

// Click "New session"
const firstRun = await win.locator('[data-testid="first-run-empty"]').count();
if (firstRun > 0) {
  await win.locator('[data-testid="first-run-empty"] button').first().click();
} else {
  await win.locator('button:has-text("New session"), button:has-text("Start")').first().click();
}
log('[probe] clicked new session');

// Wait for webview to mount.
await win.waitForSelector('webview[title^="ttyd session"]', { timeout: 20000 });
const src = await win.evaluate(() => document.querySelector('webview[title^="ttyd session"]')?.getAttribute('src'));
log('[probe] webview mounted, src=', src);

// Sit for 15s and capture all events.
await new Promise((r) => setTimeout(r, 15000));
await win.screenshot({ path: path.join(outDir, '04-after-15s.png'), fullPage: true });

// Probe the webview directly via executeJavaScript (works for any webContents).
try {
  const results = await electronApp.evaluate(async ({ webContents }) => {
    const all = webContents.getAllWebContents();
    const out = [];
    for (const wc of all) {
      const info = {
        id: wc.id,
        type: wc.getType(),
        url: wc.getURL(),
        title: wc.getTitle(),
        isLoading: wc.isLoading(),
        isCrashed: wc.isCrashed?.() ?? null,
      };
      if (wc.getType() === 'webview') {
        try {
          const inner = await wc.executeJavaScript(`
            (function() {
              const term = document.querySelector('.terminal');
              const xterm = document.querySelector('.xterm');
              const canvases = Array.from(document.querySelectorAll('canvas')).map(c => ({ w: c.width, h: c.height }));
              const ws = window.__lastWs ? window.__lastWs.readyState : 'no-ws-tracked';
              return {
                bodyHTML: document.body ? document.body.innerHTML.slice(0, 800) : '(no body)',
                hasTerm: !!term,
                hasXterm: !!xterm,
                canvasCount: canvases.length,
                canvases,
                title: document.title,
                readyState: document.readyState,
                location: location.href,
                consoleErrorsTracked: window.__errs || [],
              };
            })()
          `);
          info.inner = inner;
        } catch (e) {
          info.innerError = String(e);
        }
      }
      out.push(info);
    }
    return out;
  });
  log('[probe] webContents dump:\n' + JSON.stringify(results, null, 2));
} catch (e) {
  log('[probe] webContents dump failed:', String(e));
}

await new Promise((r) => setTimeout(r, 1000));
log('[probe] done');
await electronApp.close();
process.exit(0);
