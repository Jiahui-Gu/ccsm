// Static capture of the ToolBlock auto-expand-on-error behavior for #304 PR
// evidence. Renders an HTML stub mirroring the production ToolBlock layout
// (chevron + name + brief + AlertCircle + error frame + body) for both the
// pre-fix (collapsed) and post-fix (auto-expanded) states.
//
// Output: dogfood-logs/tool-auto-expand-304/{before,after,before-after}.png
//
// Why a stub instead of the real React tree? The other dogfood dirs in this
// repo (sidebar-resizer-263, codeblock-copy-276) use the same approach —
// keeps the screenshot deterministic, avoids spinning up Electron + the
// streaming pipeline just to seed one tool block.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const outDir = path.join(root, 'dogfood-logs', 'tool-auto-expand-304');
fs.mkdirSync(outDir, { recursive: true });

// Tokens cribbed from src/styles/global.css + tailwind.config so the stub
// looks like the real block in dark mode (the default for this app).
const html = `<!doctype html>
<html><head><style>
  :root {
    --bg-panel: #0f1115;
    --fg-primary: #e6e6e6;
    --fg-secondary: #b8b8b8;
    --fg-tertiary: #8a8a8a;
    --state-error: oklch(0.62 0.21 25);
    --state-error-soft: oklch(0.32 0.10 25 / 0.4);
    --state-error-text: oklch(0.78 0.18 25);
  }
  body {
    margin: 0;
    background: var(--bg-panel);
    color: var(--fg-primary);
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 13px;
    line-height: 1.5;
  }
  .label {
    padding: 8px 16px;
    background: #1a1d24;
    border-bottom: 1px solid #2a2d34;
    font-size: 11px;
    color: #c0c0c0;
    letter-spacing: 0.02em;
  }
  .stage { padding: 24px 28px; }
  .toolblock {
    position: relative;
    padding: 4px 8px 4px 12px;
    margin: 2px 0;
    border-radius: 2px;
  }
  .toolblock.error {
    border: 1px solid color-mix(in oklch, var(--state-error) 40%, transparent);
    background: var(--state-error-soft);
  }
  .toolblock.error::before {
    content: "";
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 2px;
    background: var(--state-error);
    border-top-left-radius: 2px;
    border-bottom-left-radius: 2px;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 12px;
    width: 100%;
    text-align: left;
    color: var(--fg-tertiary);
    cursor: pointer;
  }
  .chev { display: inline-flex; width: 12px; }
  .chev svg { stroke-width: 1.75; }
  .chev.open svg { transform: rotate(90deg); }
  .alert { color: var(--state-error); display: inline-flex; align-self: center; }
  .name { color: var(--state-error-text); font-weight: 600; }
  .name.ok { color: var(--fg-secondary); font-weight: 400; }
  .brief { color: color-mix(in oklch, var(--state-error-text) 80%, transparent); font-size: 11px; }
  .tag {
    color: color-mix(in oklch, var(--state-error-text) 80%, transparent);
    font-size: 11px;
    margin-left: 4px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .body {
    margin-top: 6px;
    margin-left: 24px;
    padding: 8px 10px;
    background: #0a0c10;
    border-left: 2px solid var(--state-error);
    color: #ffb4b4;
    white-space: pre-wrap;
    border-radius: 0 2px 2px 0;
  }
  .caption {
    margin: 6px 0 0 24px;
    color: #6a6a6a;
    font-size: 11px;
    font-style: italic;
  }
</style></head><body>
  <div class="label">BEFORE (#304) — failed tool block stays collapsed; user must hunt for the chevron to see the error</div>
  <div class="stage">
    <div class="toolblock error">
      <div class="row">
        <span class="chev"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="9 6 15 12 9 18"/></svg></span>
        <span class="alert"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></span>
        <span class="name">Bash</span>
        <span class="brief">(npm run build)</span>
        <span class="tag">failed</span>
      </div>
    </div>
    <div class="caption">error message hidden — click required to surface "permission denied"</div>
  </div>

  <div class="label">AFTER (#304) — failed tool block auto-expands so the error is visible immediately</div>
  <div class="stage">
    <div class="toolblock error">
      <div class="row">
        <span class="chev open"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="9 6 15 12 9 18"/></svg></span>
        <span class="alert"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></span>
        <span class="name">Bash</span>
        <span class="brief">(npm run build)</span>
        <span class="tag">failed</span>
      </div>
      <div class="body">Error: permission denied
  at /usr/local/bin/npm
  exit code 126</div>
    </div>
    <div class="caption">user can still click the chevron to collapse — userToggledRef wins from then on</div>
  </div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 880, height: 540 } });
await page.setContent(html);

await page.screenshot({ path: path.join(outDir, 'before-after.png'), fullPage: true });

const beforeBox = await page.locator('.stage').first().boundingBox();
await page.screenshot({ path: path.join(outDir, 'before.png'), clip: beforeBox });

const afterBox = await page.locator('.stage').nth(1).boundingBox();
await page.screenshot({ path: path.join(outDir, 'after.png'), clip: afterBox });

await browser.close();
console.log('Wrote screenshots to', outDir);
