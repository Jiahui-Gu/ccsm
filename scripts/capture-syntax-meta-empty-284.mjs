// Screenshot capture for the bundled #284/#285/#286 PR.
// Renders standalone HTML approximating the production styling for:
//   - #284 CodeBlock syntax tokens, in light + dark
//   - #285 MetaLabel primitive inside a popover-style surface
//   - #286 ChatStream EmptyState with the new CTA hint
// Output → dogfood-logs/syntax-meta-empty-284/.
//
// We use static HTML rather than mounting the real React app because the
// existing dogfood harness boots Electron + a full session lifecycle, and
// these fixes are pure visual changes — the screenshots only need to show
// the colors/spacing land where intended.
//
// Run: node scripts/capture-syntax-meta-empty-284.mjs
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'dogfood-logs', 'syntax-meta-empty-284');
fs.mkdirSync(outDir, { recursive: true });

const DARK_VARS = `
  --bg-app: oklch(0.16 0.003 240);
  --bg-panel: oklch(0.18 0.003 240);
  --bg-elev: oklch(0.26 0.003 240);
  --bg-hover: oklch(0.295 0.003 240);
  --border-subtle: oklch(0.28 0 0);
  --border-default: oklch(0.34 0 0);
  --fg-primary: oklch(0.93 0 0);
  --fg-secondary: oklch(0.80 0 0);
  --fg-tertiary: oklch(0.72 0 0);
  --fg-disabled: oklch(0.60 0 0);
  --syn-keyword: oklch(0.72 0.13 260);
  --syn-string: oklch(0.72 0.15 145);
  --syn-number: oklch(0.72 0.12 65);
  --syn-comment: oklch(0.55 0 0);
  --syn-function: oklch(0.78 0.12 220);
  --syn-punct: oklch(0.65 0 0);
  --syn-tag: oklch(0.72 0.15 20);
  --syn-var: oklch(0.82 0 0);
`;
const LIGHT_VARS = `
  --bg-app: oklch(0.985 0.002 240);
  --bg-panel: oklch(0.995 0.001 240);
  --bg-elev: oklch(0.975 0.003 240);
  --bg-hover: oklch(0.935 0.004 240);
  --border-subtle: oklch(0.90 0.003 240);
  --border-default: oklch(0.82 0.004 240);
  --fg-primary: oklch(0.22 0.01 240);
  --fg-secondary: oklch(0.36 0.008 240);
  --fg-tertiary: oklch(0.48 0.006 240);
  --fg-disabled: oklch(0.62 0.004 240);
  --syn-keyword: oklch(0.45 0.16 260);
  --syn-string: oklch(0.42 0.14 145);
  --syn-number: oklch(0.50 0.14 50);
  --syn-comment: oklch(0.55 0.01 240);
  --syn-function: oklch(0.50 0.14 220);
  --syn-punct: oklch(0.50 0.005 240);
  --syn-tag: oklch(0.48 0.18 25);
  --syn-var: oklch(0.32 0.01 240);
`;

const BASE_CSS = `
  html, body { margin:0; padding:0; background:var(--bg-app); color:var(--fg-primary);
    font-family: 'Inter', -apple-system, system-ui, sans-serif; }
  .frame { padding: 28px; max-width: 720px; }
  .label { font-size: 11px; color: var(--fg-tertiary); text-transform: uppercase;
    letter-spacing: 0.04em; margin-bottom: 10px; font-weight: 500; }
  pre { margin: 0; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace;
    font-size: 13px; line-height: 1.55; padding: 14px 16px; background: var(--bg-elev);
    border: 1px solid var(--border-subtle); border-radius: 8px; white-space: pre; }
  .kw { color: var(--syn-keyword); }
  .str { color: var(--syn-string); }
  .num { color: var(--syn-number); }
  .com { color: var(--syn-comment); font-style: italic; }
  .fn  { color: var(--syn-function); }
  .pun { color: var(--syn-punct); }
  .tag { color: var(--syn-tag); }
  .var { color: var(--syn-var); }
`;

function syntaxHtml(mode) {
  const vars = mode === 'light' ? LIGHT_VARS : DARK_VARS;
  return `<!doctype html><html><head><meta charset="utf-8"><style>:root{${vars}} ${BASE_CSS}</style></head>
<body><div class="frame">
  <div class="label">CodeBlock syntax tokens — ${mode}</div>
  <pre><span class="com">// Sum two numbers and log the result.</span>
<span class="kw">const</span> <span class="fn">sum</span> = (<span class="var">a</span>, <span class="var">b</span>)<span class="pun"> =&gt; </span><span class="var">a</span> + <span class="var">b</span>;
<span class="kw">if</span> (<span class="fn">sum</span>(<span class="num">2</span>, <span class="num">3</span>) === <span class="num">5</span>) {
  console.<span class="fn">log</span>(<span class="str">"ok"</span>);
}
<span class="kw">export</span> { <span class="fn">sum</span> };</pre>
</div></body></html>`;
}

function popoverHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>:root{${DARK_VARS}} ${BASE_CSS}
    .pop { width: 360px; border: 1px solid var(--border-default);
      border-radius: 8px; background: var(--bg-elev); overflow: hidden;
      box-shadow: 0 1px 2px oklch(0 0 0 / 0.3), 0 4px 16px oklch(0 0 0 / 0.2),
                  inset 0 1px 0 0 oklch(1 0 0 / 0.04); }
    .pop-input { margin: 8px; height: 28px; padding: 0 8px;
      background: var(--bg-panel); border: 1px solid var(--border-subtle);
      border-radius: 4px; color: var(--fg-primary); font-family: 'JetBrains Mono', monospace;
      font-size: 12px; display: flex; align-items: center; }
    .meta-label {
      display: block; padding: 6px 12px 4px; font-family: 'JetBrains Mono', monospace;
      font-size: 11px; line-height: 15px; text-transform: uppercase;
      letter-spacing: 0.04em; color: var(--fg-tertiary); user-select: none;
    }
    .row { display: flex; align-items: center; height: 28px;
      padding: 0 12px; margin: 0 4px; border-radius: 4px;
      font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--fg-secondary); }
    .row.active { background: var(--bg-hover); color: var(--fg-primary); }
  </style></head>
  <body><div class="frame">
    <div class="label">CwdPopover with &lt;MetaLabel size="sm"&gt; for "Recent" header</div>
    <div class="pop">
      <div class="pop-input">~/projects/agentory-next</div>
      <div class="meta-label">Recent</div>
      <div class="row active">~/projects/agentory-next</div>
      <div class="row">~/projects/ccsm</div>
      <div class="row">~/work/internal-tools</div>
    </div>
  </div></body></html>`;
}

function emptyHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>:root{${DARK_VARS}} ${BASE_CSS}
    .panel { width: 720px; height: 360px; background: var(--bg-panel);
      border: 1px solid var(--border-subtle); border-radius: 8px;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 8px; }
    .ready { font-family: 'JetBrains Mono', monospace; font-size: 13px; color: var(--fg-tertiary); }
    .hint { font-family: 'JetBrains Mono', monospace; font-size: 10px;
      color: var(--fg-disabled); display: inline-flex; align-items: center; gap: 6px; }
    kbd { border: 1px solid var(--border-subtle); background: var(--bg-elev);
      border-radius: 4px; padding: 2px 6px; color: var(--fg-tertiary); line-height: 1; }
  </style></head>
  <body><div class="frame">
    <div class="label">ChatStream empty state — with new CTA hint</div>
    <div class="panel">
      <div class="ready">Ready when you are.</div>
      <div class="hint"><span>Type a message and press</span><kbd>Enter</kbd></div>
    </div>
  </div></body></html>`;
}

async function shoot(html, file, viewport = { width: 800, height: 320 }) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: path.join(outDir, file), fullPage: false });
  await browser.close();
  console.log('captured', file);
}

await shoot(syntaxHtml('dark'), '01-syntax-dark.png', { width: 800, height: 220 });
await shoot(syntaxHtml('light'), '02-syntax-light.png', { width: 800, height: 220 });
await shoot(popoverHtml(), '03-meta-label-popover.png', { width: 480, height: 280 });
await shoot(emptyHtml(), '04-empty-state-cta.png', { width: 800, height: 440 });
console.log('done →', outDir);
