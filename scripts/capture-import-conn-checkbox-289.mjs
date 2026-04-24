// One-off screenshot capture for the bundled UI fixes #289 (ImportDialog
// action ghost buttons), #290 (ConnectionPane hover copy), #292 (Radix
// per-row checkbox in ImportDialog).
//
// Mirrors the static-HTML pattern from capture-codeblock-copy-276.mjs:
// approximate the production styles in plain HTML/CSS and screenshot the
// before/after of each fix. Output → dogfood-logs/import-conn-checkbox-289/.
//
// Run: node scripts/capture-import-conn-checkbox-289.mjs
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'dogfood-logs', 'import-conn-checkbox-289');
fs.mkdirSync(outDir, { recursive: true });

const COPY_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
const CHECK_SVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const CHEVRON_DOWN = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

const baseStyle = `
  :root {
    --bg: oklch(0.18 0.005 240);
    --bg-elev: oklch(0.22 0.005 240);
    --bg-hover: oklch(0.28 0.005 240);
    --border: oklch(0.32 0.005 240);
    --border-strong: oklch(0.42 0.005 240);
    --fg: oklch(0.92 0 0);
    --fg-secondary: oklch(0.78 0 0);
    --fg-tertiary: oklch(0.58 0 0);
    --accent: oklch(0.62 0.14 215);
    --accent-fg: oklch(0.98 0 0);
    --success: oklch(0.74 0.15 145);
  }
  html, body { margin:0; padding:0; background:var(--bg); color:var(--fg);
    font-family: 'Inter', -apple-system, system-ui, sans-serif; }
  .frame { padding: 28px; max-width: 720px; }
  .label { font-size: 11px; color: oklch(0.6 0 0); text-transform: uppercase;
    letter-spacing: 0.04em; margin-bottom: 8px; }
  .panel { background: var(--bg-elev); border:1px solid var(--border);
    border-radius: 8px; padding: 16px; }
  .row { display:flex; align-items:center; justify-content:space-between;
    margin-bottom: 8px; }
  .mono { font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; }
  .text-chrome { font-size: 12px; }
  .text-meta { font-size: 11px; }
  .text-fg-tertiary { color: var(--fg-tertiary); }
  .text-fg-secondary { color: var(--fg-secondary); }
  .text-fg-primary { color: var(--fg); }
`;

// === #289 — ImportDialog action ghost buttons ===
function importDialogHtml({ after }) {
  const linkBtn = (label) => after
    ? `<button class="ghost-btn">${label}</button>`
    : `<button class="link-btn">${label}</button>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyle}
    .link-btn { background: transparent; border:0; padding:0; cursor:pointer;
      font-family:'JetBrains Mono',monospace; font-size:12px; color:var(--fg-tertiary);
      text-decoration: none; }
    .link-btn:hover { color: var(--fg-secondary); }
    .ghost-btn { display:inline-flex; align-items:center; justify-content:center;
      height:24px; padding:0 8px; font-size:11px; gap:6px;
      background: transparent; color: var(--fg-secondary); border:1px solid transparent;
      border-radius: 6px; cursor:pointer; transition: background-color 150ms cubic-bezier(0.32,0.72,0,1), color 150ms; }
    .ghost-btn:hover { background: var(--bg-hover); color: var(--fg); }
    .bucket-header { display:flex; align-items:center; gap:8px; padding: 6px 8px;
      background: oklch(0.24 0.005 240); }
    .bucket-title { flex:1; font-family:'JetBrains Mono',monospace; font-size:12px;
      color: var(--fg-secondary); }
  </style></head><body><div class="frame">
    <div class="label">ImportDialog actions — ${after ? 'after (Button ghost xs)' : 'before (raw link buttons)'}</div>
    <div class="panel">
      <div class="row">
        ${linkBtn('Select all (12)')}
        <span class="mono text-chrome text-fg-tertiary">3 selected</span>
      </div>
      <div class="bucket-header">
        <span class="text-fg-tertiary">${CHEVRON_DOWN}</span>
        <span class="bucket-title">Today · 4</span>
        ${linkBtn('Select group')}
      </div>
    </div>
  </div></body></html>`;
}

// === #292 — per-row checkbox: native vs Radix-styled ===
function checkboxRowHtml({ after }) {
  const nativeCheck = `<input type="checkbox" checked style="accent-color: var(--accent); margin-top: 2px;">`;
  const radixCheck = `<span style="display:inline-grid; place-items:center; width:14px; height:14px;
    border-radius:3px; background:var(--accent); border:1px solid var(--accent);
    color: var(--bg); margin-top: 2px;">${CHECK_SVG}</span>`;
  const radixUnchecked = `<span style="display:inline-grid; place-items:center; width:14px; height:14px;
    border-radius:3px; border:1px solid var(--border-strong); margin-top: 2px;"></span>`;
  const nativeUnchecked = `<input type="checkbox" style="accent-color: var(--accent); margin-top: 2px;">`;

  const row = (label, cwd, checked) => `
    <li style="display:flex; gap:8px; padding: 8px 12px; border-top:1px solid var(--border);">
      ${after ? (checked ? radixCheck : radixUnchecked) : (checked ? nativeCheck : nativeUnchecked)}
      <div style="min-width:0; flex:1;">
        <div class="mono text-chrome text-fg-primary">${label}</div>
        <div class="mono text-meta text-fg-tertiary">${cwd}</div>
      </div>
    </li>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyle}
    ul { list-style: none; margin: 0; padding: 0; border:1px solid var(--border); border-radius:6px; overflow:hidden; }
  </style></head><body><div class="frame">
    <div class="label">ImportDialog per-row checkbox — ${after ? 'after (Radix Checkbox.Root with brand accent)' : 'before (native input)'}</div>
    <ul>
      ${row('Refactor session router', '~/code/ccsm', true)}
      ${row('Add notification fallback', '~/code/notify', false)}
      ${row('Fix sidebar resizer drift', '~/code/agentory-next', true)}
    </ul>
  </div></body></html>`;
}

// === #290 — ConnectionPane copy buttons ===
function connectionPaneHtml({ state /* 'before' | 'hover' | 'copied' */ }) {
  const showBtn = state !== 'before';
  const copied = state === 'copied';
  const hover = state === 'hover';
  const tooltip = copied ? 'Copied' : 'Copy URL';
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyle}
    .field-label { font-size: 12px; color: var(--fg); font-weight: 500; margin-bottom: 6px; }
    .value-wrap { position: relative; }
    .value { display:block; padding: 6px 32px 6px 8px; border-radius:3px;
      background: var(--bg-elev); border:1px solid var(--border);
      font-family:'JetBrains Mono',monospace; font-size:11px; color: var(--fg-secondary); word-break: break-all; }
    .copy-btn { position:absolute; top:4px; right:4px; width:20px; height:20px;
      display: ${showBtn ? 'inline-grid' : 'none'}; place-items: center;
      border-radius: 6px; border:1px solid transparent;
      background: ${hover ? 'var(--bg-hover)' : 'transparent'};
      color: ${copied ? 'var(--success)' : 'var(--fg-secondary)'}; cursor: pointer; }
    .tt { position:absolute; top:4px; right:32px; padding:3px 7px; border-radius:5px;
      background: oklch(0.26 0.005 240); border:1px solid var(--border);
      color: var(--fg); font-size: 10px;
      display: ${hover || copied ? 'inline-block' : 'none'}; }
  </style></head><body><div class="frame">
    <div class="label">ConnectionPane — ${state === 'before' ? 'before (no copy affordance)' : state === 'hover' ? 'hover (copy revealed)' : 'after click (Copied)'}</div>
    <div class="panel" style="display:flex; flex-direction:column; gap:14px;">
      <div>
        <div class="field-label">Base URL</div>
        <div class="value-wrap">
          <code class="value">https://api.example.com/v1</code>
          <button class="copy-btn">${copied ? CHECK_SVG : COPY_SVG}</button>
          <span class="tt">${tooltip}</span>
        </div>
      </div>
      <div>
        <div class="field-label">Default model</div>
        <div class="value-wrap">
          <code class="value">claude-opus-4-7</code>
          <button class="copy-btn">${copied ? CHECK_SVG : COPY_SVG}</button>
          <span class="tt">${copied ? 'Copied' : 'Copy model'}</span>
        </div>
      </div>
    </div>
  </div></body></html>`;
}

async function shoot(html, file, height = 260) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 760, height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: path.join(outDir, file), fullPage: false });
  await browser.close();
  console.log('captured', file);
}

await shoot(importDialogHtml({ after: false }), '289-import-actions-before.png');
await shoot(importDialogHtml({ after: true  }), '289-import-actions-after.png');
await shoot(checkboxRowHtml({ after: false }), '292-checkbox-before.png', 240);
await shoot(checkboxRowHtml({ after: true  }), '292-checkbox-after.png', 240);
await shoot(connectionPaneHtml({ state: 'before' }), '290-connection-before.png', 280);
await shoot(connectionPaneHtml({ state: 'hover'  }), '290-connection-hover.png',  280);
await shoot(connectionPaneHtml({ state: 'copied' }), '290-connection-copied.png', 280);
console.log('done →', outDir);
