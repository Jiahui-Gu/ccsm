// One-off screenshot capture for task #276 (CodeBlock copy button).
// Renders a static HTML page approximating the production CodeBlock styles
// and captures three states: idle (no button), hover (button visible),
// post-click (Copied state). Output → dogfood-logs/codeblock-copy-276/.
//
// Run: node scripts/capture-codeblock-copy-276.mjs
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'dogfood-logs', 'codeblock-copy-276');
fs.mkdirSync(outDir, { recursive: true });

// Minimal HTML stand-in. Mirrors the actual CodeBlock layout/classes:
// `group relative` parent, absolute-positioned button top-right, opacity-0
// → group-hover:opacity-100, lucide Copy/Check SVG glyphs inline.
const COPY_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
const CHECK_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

const SAMPLE = `const sum = (a, b) => a + b;\nconsole.log(sum(2, 3));`;

function html({ hover, copied }) {
  const btnOpacity = hover || copied ? 1 : 0;
  const btnColor = copied ? 'oklch(0.74 0.15 145)' : 'oklch(0.78 0 0)';
  const glyph = copied ? CHECK_SVG : COPY_SVG;
  const label = copied ? 'Copied' : 'Copy code';
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root {
    --bg: oklch(0.18 0.005 240);
    --bg-elev: oklch(0.22 0.005 240);
    --bg-hover: oklch(0.28 0.005 240);
    --border: oklch(0.32 0.005 240);
    --fg: oklch(0.92 0 0);
  }
  html, body { margin:0; padding:0; background:var(--bg); color:var(--fg);
    font-family: 'Inter', -apple-system, system-ui, sans-serif; }
  .frame { padding: 28px; max-width: 640px; }
  .label { font-size: 11px; color: oklch(0.6 0 0); text-transform: uppercase;
    letter-spacing: 0.04em; margin-bottom: 8px; }
  .codeblock-wrap { position: relative; background: var(--bg-elev);
    border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px;
    box-shadow: inset 0 1px 0 0 oklch(1 0 0 / 0.04); }
  pre { margin: 0; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace;
    font-size: 13px; line-height: 1.55; color: var(--fg); padding-right: 32px;
    white-space: pre; }
  .tok-kw { color: oklch(0.72 0.13 260); }
  .tok-fn { color: oklch(0.78 0.12 220); }
  .tok-num { color: oklch(0.72 0.12 65); }
  .tok-punct { color: oklch(0.65 0 0); }
  .copy-btn { position: absolute; top: 6px; right: 6px;
    width: 24px; height: 24px; display: inline-grid; place-items: center;
    border-radius: 6px; border: 1px solid transparent;
    background: ${hover && !copied ? 'var(--bg-hover)' : 'transparent'};
    box-shadow: ${hover && !copied ? 'inset 0 1px 0 0 oklch(1 0 0 / 0.05)' : 'none'};
    color: ${btnColor}; opacity: ${btnOpacity};
    transition: opacity 150ms cubic-bezier(0.32,0.72,0,1);
  }
  .tooltip { position: absolute; top: 8px; right: 38px;
    background: oklch(0.26 0.005 240); border: 1px solid var(--border);
    color: oklch(0.85 0 0); font-size: 11px; padding: 4px 8px; border-radius: 6px;
    box-shadow: 0 2px 8px oklch(0 0 0 / 0.35); display: ${hover || copied ? 'block' : 'none'}; }
</style></head>
<body><div class="frame">
  <div class="label">CodeBlock — ${copied ? 'after click' : hover ? 'hover' : 'idle'}</div>
  <div class="codeblock-wrap">
    <pre><span class="tok-kw">const</span> <span class="tok-fn">sum</span> <span class="tok-punct">=</span> (a<span class="tok-punct">,</span> b) <span class="tok-punct">=&gt;</span> a <span class="tok-punct">+</span> b<span class="tok-punct">;</span>
console<span class="tok-punct">.</span><span class="tok-fn">log</span>(<span class="tok-fn">sum</span>(<span class="tok-num">2</span><span class="tok-punct">,</span> <span class="tok-num">3</span>))<span class="tok-punct">;</span></pre>
    <button class="copy-btn" aria-label="${label}">${glyph}</button>
    <div class="tooltip">${label}</div>
  </div>
</div></body></html>`;
}

async function shoot(state, file) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 720, height: 220 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.setContent(html(state), { waitUntil: 'load' });
  await page.screenshot({ path: path.join(outDir, file), fullPage: false });
  await browser.close();
  console.log('captured', file);
}

await shoot({ hover: false, copied: false }, '01-idle.png');
await shoot({ hover: true, copied: false }, '02-hover.png');
await shoot({ hover: false, copied: true }, '03-copied.png');
console.log('done →', outDir);
