// scripts/probe-render-import-dialog-243.mjs
//
// Visual probe for audit ID2/ID3 (#243) — ImportDialog brand consistency.
//
//   ID2: checkbox accent color was `accent-fg-primary` (near-white) instead
//        of brand cyan `accent-accent` used by every other checkbox in the
//        app (see SettingsDialog.tsx). Switched to `accent-accent`.
//   ID3: select-all + per-bucket select-group/deselect-group bare buttons
//        had no visible focus ring. Added `.focus-ring` utility from
//        global.css per the focus-ring kit pattern.
//
// Output: PNG pairs under `dogfood-logs/import-dialog-243/`. Mirrors the
// static-HTML pattern from `probe-render-focus-ring-u2.mjs` (#240) — pure
// CSS surface, no app boot required for stable pixel-perfect screenshots.
//
// HOME is sanitized so the headless browser doesn't pick up user skill
// files (per `feedback_probe_skill_injection.md`).

import { chromium } from 'playwright';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const sandboxHome = await mkdtemp(join(tmpdir(), 'probe-import-dialog-243-'));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
process.env.CLAUDE_HOME = sandboxHome;

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'dogfood-logs', 'import-dialog-243');
await mkdir(OUT_DIR, { recursive: true });

// Token values copied verbatim from `src/styles/global.css` (dark @theme),
// matching the live app render.
const TOKENS_CSS = `
  :root {
    --color-bg-app: oklch(0.16 0.003 240);
    --color-bg-panel: oklch(0.18 0.003 240);
    --color-bg-hover: oklch(0.295 0.003 240);
    --color-fg-primary: oklch(0.93 0 0);
    --color-fg-secondary: oklch(0.80 0 0);
    --color-fg-tertiary: oklch(0.72 0 0);
    --color-border-subtle: oklch(0.28 0 0);
    --color-accent: oklch(0.74 0.13 215);
    --text-chrome: 12px;
    --text-chrome-lh: 16px;
    --text-mono-sm: 11px;
  }
  html, body {
    margin: 0; padding: 0;
    background: var(--color-bg-app);
    color: var(--color-fg-primary);
    font-family: ui-monospace, Menlo, Consolas, monospace;
    -webkit-font-smoothing: antialiased;
  }
  .frame { padding: 20px; width: 600px; }
  .row {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 8px 12px;
    border-top: 1px solid var(--color-border-subtle);
    background: oklch(0.295 0.003 240 / 0.5);
  }
  .title { font-size: var(--text-chrome); color: var(--color-fg-primary); }
  .meta {
    font-size: var(--text-mono-sm); color: var(--color-fg-tertiary);
    margin-top: 2px;
  }

  /* BEFORE: checkbox uses fg-primary (near-white) — looks like generic UA */
  input.before { accent-color: var(--color-fg-primary); }
  /* AFTER: checkbox uses brand cyan accent, matching SettingsDialog */
  input.after  { accent-color: var(--color-accent); }
  input[type=checkbox] { margin-top: 2px; width: 13px; height: 13px; }

  /* Bucket header row + select-group / select-all bare button */
  .bucket-head {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 8px;
    background: oklch(0.295 0.003 240 / 0.3);
    border-bottom: 1px solid var(--color-border-subtle);
  }
  .label {
    flex: 1;
    font-size: var(--text-chrome); color: var(--color-fg-secondary);
  }
  .toolbar {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 8px;
  }
  .bare-btn {
    background: transparent; border: 0; padding: 2px 4px;
    font-family: inherit;
    font-size: var(--text-chrome); color: var(--color-fg-tertiary);
    cursor: pointer;
  }
  /* AFTER: focus-ring utility (1px inset accent), exact copy of
     .focus-ring:focus-visible from global.css. */
  .bare-btn.after-focused {
    outline: 1px solid var(--color-accent);
    outline-offset: -1px;
  }
  /* BEFORE: no focus indicator — matches user-agent default suppressed */
  .bare-btn.before-focused { outline: none; }

  .panel {
    border: 1px solid var(--color-border-subtle);
    border-radius: 2px;
    overflow: hidden;
  }
`;

function checkboxListHtml({ kind }) {
  const items = [
    { title: 'feature/payment-refactor', meta: '~/projects/checkout · 2026-04-21 14:32' },
    { title: 'fix(a11y): focus restore on close', meta: '~/projects/agentory-next · 2026-04-22 09:11' },
    { title: 'docs: update API guide', meta: '~/projects/docs-site · 2026-04-23 16:48' },
  ];
  const cls = kind === 'before' ? 'before' : 'after';
  const checkedAttr = (i) => (i < 2 ? 'checked' : '');
  return `
    <div class="panel">
      <div class="bucket-head">
        <span class="label">~/projects/checkout · 3</span>
        <button class="bare-btn">deselect group</button>
      </div>
      ${items
        .map(
          (it, i) => `
        <div class="row">
          <input type="checkbox" class="${cls}" ${checkedAttr(i)} />
          <div>
            <div class="title">${it.title}</div>
            <div class="meta">${it.meta}</div>
          </div>
        </div>
      `,
        )
        .join('')}
    </div>
  `;
}

function toolbarHtml({ kind }) {
  const focusCls = kind === 'before' ? 'before-focused' : 'after-focused';
  const groupFocusCls = kind === 'before' ? 'before-focused' : 'after-focused';
  return `
    <div class="toolbar">
      <button class="bare-btn ${focusCls}">deselect all (12)</button>
      <span class="label" style="flex:0; color:var(--color-fg-tertiary)">3 selected</span>
    </div>
    <div class="panel">
      <div class="bucket-head">
        <span class="label">~/projects/checkout · 3</span>
        <button class="bare-btn ${groupFocusCls}">deselect group</button>
      </div>
      <div class="row">
        <input type="checkbox" class="${kind}" checked />
        <div>
          <div class="title">feature/payment-refactor</div>
          <div class="meta">~/projects/checkout · 2026-04-21 14:32</div>
        </div>
      </div>
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
  // ID2 — checkbox accent color
  ['checkbox-before', pageHtml('checkbox accent (before)', checkboxListHtml({ kind: 'before' }))],
  ['checkbox-after', pageHtml('checkbox accent (after)', checkboxListHtml({ kind: 'after' }))],
  // ID3 — bare-button focus ring (select-all + select-group)
  ['focus-before', pageHtml('bare button focus (before)', toolbarHtml({ kind: 'before' }))],
  ['focus-after', pageHtml('bare button focus (after)', toolbarHtml({ kind: 'after' }))],
];

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    viewport: { width: 640, height: 360 },
    deviceScaleFactor: 2,
  });
  for (const [name, html] of cases) {
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    const target = await page.locator('.frame').first();
    const out = resolve(OUT_DIR, `${name}.png`);
    await target.screenshot({ path: out });
    console.log(`wrote ${out}`);
    await page.close();
  }
} finally {
  await browser.close();
}

const readme = `# ImportDialog brand consistency (#243) — visual diff

Generated by \`scripts/probe-render-import-dialog-243.mjs\`.

| Surface | Before | After |
| --- | --- | --- |
| Checkbox accent color (ID2) | ![](checkbox-before.png) | ![](checkbox-after.png) |
| Bare-button focus ring (ID3) | ![](focus-before.png) | ![](focus-after.png) |

**ID2 (checkbox):** before used \`accent-fg-primary\` (near-white) which looks
like a generic browser checkbox; after uses the brand cyan \`accent-accent\`,
matching every other checkbox in the app (\`SettingsDialog.tsx\`).

**ID3 (bare buttons):** the select-all and per-bucket select-group/deselect-group
buttons had no visible focus indicator. After adds the existing \`.focus-ring\`
utility from \`global.css\` (1px inset accent outline), matching the focus-ring
kit pattern from #240.
`;
await writeFile(resolve(OUT_DIR, 'README.md'), readme);
console.log(`wrote ${resolve(OUT_DIR, 'README.md')}`);
