// scripts/probe-render-toast-a11y-275.mjs
//
// Visual probe for the Toast a11y rework (#275). Renders BEFORE / AFTER
// pairs of each toast variant so the PR reviewer can see (per
// `feedback_visual_fix_screenshots.md`):
//
//   1. Error variant gains a leading AlertCircle glyph (color-only signal
//      was a P0 a11y problem for color-blind users).
//   2. Info variant gains the Info glyph.
//   3. Every variant gains the explicit close X in the top-right corner
//      (replacing the previous "click the body anywhere" dismiss).
//
// Why static HTML, not a live Electron mount: same rationale as
// `scripts/probe-render-banners.mjs` (#237) — the goal is a faithful
// pixel diff of the surface, not an integration test of the React tree.
// The class strings emitted here mirror the Toast.tsx output exactly.
//
// Output: PNG pairs under `dogfood-logs/toast-a11y-275/` plus a README
// with the markdown screenshot table for the PR body.

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'dogfood-logs', 'toast-a11y-275');

await mkdir(OUT_DIR, { recursive: true });

// Inline a minimal subset of project tokens. Numeric values match the
// Tailwind utilities Toast.tsx uses (rounded-md, py-2.5, pl-3, gap-2,
// text-chrome ≈ 12px, text-meta ≈ 11px). Drift here would be a real
// regression — not an artifact of the probe.
const TOKENS_CSS = `
  :root {
    --bg-page: oklch(0.18 0.003 240);
    --bg-elevated: oklch(0.22 0.003 240);
    --fg-primary: oklch(0.93 0 0);
    --fg-tertiary: oklch(0.65 0 0);
    --border-default: oklch(0.30 0 0);
    --state-error: oklch(0.65 0.18 25);
    --state-running: oklch(0.70 0.13 240);
    --state-waiting: oklch(0.75 0.10 75);
  }
  html, body { margin: 0; padding: 0; background: var(--bg-page); color: var(--fg-primary);
    font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased; }
  .frame { width: 360px; padding: 20px; }
  .toast {
    position: relative;
    background: var(--bg-elevated);
    border: 1px solid var(--border-default);
    border-radius: 6px;
    padding: 10px 32px 10px 12px;  /* pr-8 to clear the X button */
    width: 320px;
    box-shadow: 0 1px 0 0 oklch(1 0 0 / 0.04) inset, 0 4px 12px oklch(0 0 0 / 0.25);
  }
  .toast.before { padding: 10px 12px; }  /* before: no close button, no extra right padding */
  .toast.error   { border-color: oklch(0.65 0.18 25 / 0.4); }
  .toast.waiting { border-color: oklch(0.75 0.10 75 / 0.4); }
  .row { display: flex; align-items: flex-start; gap: 8px; }
  .icon { margin-top: 2px; flex-shrink: 0; }
  .icon.error { color: var(--state-error); }
  .icon.info  { color: var(--state-running); }
  .body { min-width: 0; flex: 1; }
  .title { font-size: 12px; font-weight: 500; line-height: 16px; color: var(--fg-primary); }
  .sub { margin-top: 2px; font-size: 11px; line-height: 14px; color: var(--fg-tertiary); }
  .close {
    position: absolute; top: 6px; right: 6px;
    height: 20px; width: 20px;
    display: inline-flex; align-items: center; justify-content: center;
    background: transparent; border: 0; cursor: pointer;
    color: var(--fg-tertiary); border-radius: 4px;
  }
  .close:hover { color: var(--fg-primary); background: oklch(1 0 0 / 0.05); }
  /* Diamond glyph used by the existing 'waiting' variant (StateGlyph). */
  .diamond { width: 10px; height: 10px; transform: rotate(45deg);
    border: 1.4px solid var(--state-waiting); margin-top: 4px; flex-shrink: 0; }
`;

// SVG icons inlined so the probe doesn't depend on the lucide JS package
// (the actual component imports from 'lucide-react' — these paths are
// copied from lucide@0.469 to match pixel-for-pixel).
const iconAlertCircle = `
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
  </svg>`;
const iconInfo = `
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
  </svg>`;
const iconX = `
  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
  </svg>`;

function toast({ kind, title, body, before }) {
  const cls = `toast ${kind}${before ? ' before' : ''}`;
  let leading = '';
  if (kind === 'error') {
    // BEFORE: reused StateGlyph (a diamond) tinted red — same SHAPE as the
    // waiting variant. Color-blind users could not tell them apart.
    leading = before
      ? `<div class="diamond" style="border-color: var(--state-error);"></div>`
      : `<span class="icon error">${iconAlertCircle}</span>`;
  } else if (kind === 'info') {
    leading = before
      ? `<div class="diamond" style="border-color: var(--state-running);"></div>`
      : `<span class="icon info">${iconInfo}</span>`;
  } else if (kind === 'waiting') {
    // Waiting kept the diamond — it remains a state-machine signal, not an
    // a11y problem (it never collides with another shape inside the toast).
    leading = `<div class="diamond"></div>`;
  }
  const closeBtn = before ? '' : `<button class="close" aria-label="Dismiss">${iconX}</button>`;
  return `
    <div class="${cls}">
      <div class="row">
        ${leading}
        <div class="body">
          <div class="title">${title}</div>
          ${body ? `<div class="sub">${body}</div>` : ''}
        </div>
      </div>
      ${closeBtn}
    </div>
  `;
}

function pageHtml(title, body) {
  return `<!doctype html>
    <html><head><meta charset="utf-8"><title>${title}</title>
    <style>${TOKENS_CSS}</style></head>
    <body><div class="frame">${body}</div></body></html>`;
}

const cases = [
  ['error-before', pageHtml('error (before)',
    toast({ kind: 'error', title: 'Failed to send', body: 'Network unreachable', before: true }))],
  ['error-after', pageHtml('error (after)',
    toast({ kind: 'error', title: 'Failed to send', body: 'Network unreachable', before: false }))],
  ['info-before', pageHtml('info (before)',
    toast({ kind: 'info', title: 'Settings saved', before: true }))],
  ['info-after', pageHtml('info (after)',
    toast({ kind: 'info', title: 'Settings saved', before: false }))],
  ['waiting-before', pageHtml('waiting (before)',
    toast({ kind: 'waiting', title: 'Session waiting on input', before: true }))],
  ['waiting-after', pageHtml('waiting (after)',
    toast({ kind: 'waiting', title: 'Session waiting on input', before: false }))],
];

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 140 },
    deviceScaleFactor: 2,
  });
  for (const [name, html] of cases) {
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    const target = page.locator('.frame').first();
    const out = resolve(OUT_DIR, `${name}.png`);
    await target.screenshot({ path: out });
    console.log(`wrote ${out}`);
    await page.close();
  }
} finally {
  await browser.close();
}

const readme = `# Toast a11y rework (#275) — visual diff

Generated by \`scripts/probe-render-toast-a11y-275.mjs\`.

| Variant | Before | After |
| --- | --- | --- |
| Error (color-only diamond → AlertCircle glyph + close X) | ![](error-before.png) | ![](error-after.png) |
| Info (diamond → Info glyph + close X) | ![](info-before.png) | ![](info-after.png) |
| Waiting (kept diamond, gained close X) | ![](waiting-before.png) | ![](waiting-after.png) |

**What changed visually**

- Error and info variants now use distinctive lucide glyphs (AlertCircle, Info)
  in addition to color, satisfying WCAG 1.4.1 (Use of Color).
- Every toast now shows an explicit close X in the top-right. Dismiss is
  restricted to that button (or the Esc key) so a stray click on the toast
  body — or on a link/action button inside it — no longer hides the toast.
- The waiting variant kept the diamond (StateGlyph) because it doubles as
  the global "agent is waiting" state-machine signal elsewhere in the UI;
  collapsing it to a generic icon would erase that meaning.
`;
await writeFile(resolve(OUT_DIR, 'README.md'), readme);
console.log(`wrote ${resolve(OUT_DIR, 'README.md')}`);
