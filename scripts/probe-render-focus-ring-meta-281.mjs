// scripts/probe-render-focus-ring-meta-281.mjs
//
// Visual probe for the focus-ring + meta bundle PR (#281 #283 #291 #297).
// Captures before/after screenshots for the two surfaces with visible diff:
//
//   #283 ShortcutOverlay — typography (text-meta on labels + kbd chips)
//   #291 QuestionBlock Submit + ChatStream jump-to-latest — added .focus-ring
//
// #281 (Button primary halo token) and #297 (locale key removal) have no
// meaningful visual change, so they're not in the table.
//
// Output: PNG pairs under `dogfood-logs/focus-ring-meta-281/`. Mirrors the
// pattern from `scripts/probe-render-focus-ring-u2.mjs` — static HTML, dark
// tokens inlined verbatim from `src/styles/global.css`.
//
// HOME is sanitized so the headless browser never inherits user skill files
// (per `feedback_probe_skill_injection.md`).

import { chromium } from 'playwright';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const sandboxHome = await mkdtemp(join(tmpdir(), 'probe-focus-ring-meta-'));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
process.env.CLAUDE_HOME = sandboxHome;

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'dogfood-logs', 'focus-ring-meta-281');
await mkdir(OUT_DIR, { recursive: true });

const TOKENS_CSS = `
  :root {
    --color-bg-app: oklch(0.16 0.003 240);
    --color-bg-panel: oklch(0.18 0.003 240);
    --color-bg-elevated: oklch(0.26 0.003 240);
    --color-bg-hover: oklch(0.295 0.003 240);
    --color-fg-primary: oklch(0.93 0 0);
    --color-fg-secondary: oklch(0.80 0 0);
    --color-fg-tertiary: oklch(0.72 0 0);
    --color-border-subtle: oklch(0.28 0 0);
    --color-border-default: oklch(0.34 0 0);
    --color-border-strong: oklch(0.44 0 0);
    --color-state-waiting: oklch(0.78 0.10 75);
    --color-accent: oklch(0.74 0.13 215);
    --color-accent-fg: oklch(0.18 0 0);
    --color-focus-ring: oklch(0.72 0.14 215 / 0.30);
    --text-meta: 11px;
    --text-meta-lh: 14px;
    --text-chrome: 13px;
    --text-chrome-lh: 18px;
    --text-body: 15px;
    --text-body-lh: 24px;
    --text-heading: 16px;
  }
  html, body {
    margin: 0; padding: 0;
    background: var(--color-bg-app);
    color: var(--color-fg-primary);
    font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .frame { padding: 24px; width: 600px; }

  /* ── ShortcutOverlay (#283) ── */
  .so-dialog {
    background: var(--color-bg-elevated);
    border: 1px solid var(--color-border-default);
    border-radius: 8px; padding: 20px;
  }
  .so-title { font-size: var(--text-heading); font-weight: 600; margin: 0 0 4px; }
  .so-desc {
    font-size: var(--text-chrome); line-height: var(--text-chrome-lh);
    color: var(--color-fg-tertiary); margin: 0 0 16px;
  }
  .so-section { margin-top: 18px; }
  .so-section:first-of-type { margin-top: 4px; }
  /* AFTER: text-meta on group header (after fix uses var(--text-meta)) */
  .so-h3.after {
    font-size: var(--text-meta); line-height: var(--text-meta-lh);
    font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--color-fg-tertiary); margin: 0 0 8px;
  }
  /* BEFORE: hand-rolled text-[12px] */
  .so-h3.before {
    font-size: 12px; line-height: 16px;
    font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--color-fg-tertiary); margin: 0 0 8px;
  }
  .so-row {
    display: flex; align-items: flex-start;
    border-top: 1px solid var(--color-border-subtle);
    padding: 6px 0;
  }
  .so-row:first-child { border-top: 0; }
  .so-keys { width: 180px; display: inline-flex; align-items: center; gap: 4px; }
  .so-action { font-size: var(--text-chrome); color: var(--color-fg-secondary); }
  .so-kbd {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 22px; height: 22px; padding: 0 6px;
    border-radius: 4px; border: 1px solid var(--color-border-default);
    background: var(--color-bg-elevated);
    font-family: ui-monospace, 'JetBrains Mono', Menlo, Consolas, monospace;
    color: var(--color-fg-primary); line-height: 1;
    box-shadow: inset 0 -1px 0 0 oklch(0 0 0 / 0.25);
  }
  .so-kbd.after { font-size: var(--text-meta); }
  .so-kbd.before { font-size: 12px; }
  .so-plus.after { color: var(--color-fg-tertiary); font-size: var(--text-meta); }
  .so-plus.before { color: var(--color-fg-tertiary); font-size: 12px; }

  /* ── QuestionBlock submit (#291) ── */
  .qb-frame {
    position: relative;
    background: oklch(0.78 0.10 75 / 0.06);
    border: 1px solid oklch(0.78 0.10 75 / 0.40);
    border-radius: 8px; padding: 14px 16px;
  }
  .qb-frame::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
    background: var(--color-state-waiting); border-radius: 8px 0 0 8px;
  }
  .qb-title { font-size: var(--text-heading); font-weight: 600; margin-bottom: 12px; }
  .qb-q { font-size: var(--text-body); margin: 12px 0 8px; }
  .qb-actions { display: flex; justify-content: flex-end; margin-top: 12px; }
  .qb-submit {
    height: 28px; padding: 0 12px;
    border-radius: 6px;
    border: 1px solid oklch(0.55 0.14 215);
    background: linear-gradient(to bottom, oklch(0.82 0.14 215), oklch(0.62 0.14 215));
    color: var(--color-accent-fg); font-weight: 500; font-size: var(--text-chrome);
    box-shadow: inset 0 1px 0 0 oklch(1 0 0 / 0.28), 0 1px 0 0 oklch(0 0 0 / 0.18);
  }
  /* BEFORE: keyboard focus invisible — Button's primary halo only */
  .qb-submit.before-focused {
    outline: none;
  }
  /* AFTER: token halo + 1px inset accent outline (.focus-ring utility) */
  .qb-submit.after-focused {
    outline: 1px solid var(--color-accent);
    outline-offset: -1px;
    box-shadow:
      inset 0 1px 0 0 oklch(1 0 0 / 0.28),
      0 1px 0 0 oklch(0 0 0 / 0.18),
      0 0 0 3px var(--color-focus-ring);
  }

  /* ── ChatStream jump-to-latest (#291) ── */
  .cs-stage {
    position: relative; width: 100%; height: 80px;
    background: var(--color-bg-panel);
    border: 1px solid var(--color-border-subtle);
    border-radius: 8px;
  }
  .cs-jump {
    position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%);
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 12px; border-radius: 999px;
    background: var(--color-bg-elevated);
    border: 1px solid var(--color-border-strong);
    color: var(--color-fg-primary); font-size: var(--text-chrome);
    box-shadow: 0 4px 6px -1px oklch(0 0 0 / 0.1);
  }
  .cs-jump.before-focused { outline: none; }
  .cs-jump.after-focused {
    outline: 1px solid var(--color-accent);
    outline-offset: -1px;
  }
  .cs-arrow { width: 14px; height: 14px; stroke: currentColor; fill: none;
    stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

  .case-tag {
    font-size: var(--text-meta); line-height: var(--text-meta-lh);
    text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--color-fg-tertiary); margin-bottom: 8px;
  }
`;

function shortcutOverlayHtml({ klass }) {
  // Mirrors the real ShortcutOverlay table layout (group title, two rows of kbd chips).
  return `
    <div class="so-dialog">
      <h2 class="so-title">Keyboard shortcuts</h2>
      <p class="so-desc">All available keyboard shortcuts in CCSM.</p>
      <section class="so-section">
        <h3 class="so-h3 ${klass}">Navigation</h3>
        <div>
          <div class="so-row">
            <span class="so-keys">
              <span class="so-kbd ${klass}">Ctrl</span>
              <span class="so-plus ${klass}">+</span>
              <span class="so-kbd ${klass}">F</span>
            </span>
            <span class="so-action">Search command palette</span>
          </div>
          <div class="so-row">
            <span class="so-keys">
              <span class="so-kbd ${klass}">Ctrl</span>
              <span class="so-plus ${klass}">+</span>
              <span class="so-kbd ${klass}">,</span>
            </span>
            <span class="so-action">Open settings</span>
          </div>
          <div class="so-row">
            <span class="so-keys">
              <span class="so-kbd ${klass}">?</span>
            </span>
            <span class="so-action">Show this overlay</span>
          </div>
        </div>
      </section>
    </div>
  `;
}

function questionSubmitHtml({ klass }) {
  return `
    <div class="qb-frame">
      <div class="qb-title">User input requested</div>
      <div class="qb-q">Should I deploy to production?</div>
      <div class="qb-actions">
        <button class="qb-submit ${klass}">Submit</button>
      </div>
    </div>
  `;
}

function jumpToLatestHtml({ klass }) {
  const arrow = `<svg class="cs-arrow" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>`;
  return `
    <div class="cs-stage">
      <button class="cs-jump ${klass}">${arrow}<span>Jump to latest</span></button>
    </div>
  `;
}

function pageHtml(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
  <style>${TOKENS_CSS}</style></head><body><div class="frame">${body}</div></body></html>`;
}

const cases = [
  ['shortcut-overlay-before', pageHtml('shortcut overlay (before)', shortcutOverlayHtml({ klass: 'before' }))],
  ['shortcut-overlay-after', pageHtml('shortcut overlay (after)', shortcutOverlayHtml({ klass: 'after' }))],
  ['question-submit-before', pageHtml('question submit focus (before)', questionSubmitHtml({ klass: 'before-focused' }))],
  ['question-submit-after', pageHtml('question submit focus (after)', questionSubmitHtml({ klass: 'after-focused' }))],
  ['jump-to-latest-before', pageHtml('jump-to-latest focus (before)', jumpToLatestHtml({ klass: 'before-focused' }))],
  ['jump-to-latest-after', pageHtml('jump-to-latest focus (after)', jumpToLatestHtml({ klass: 'after-focused' }))],
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

const readme = `# Focus-ring + meta bundle (#281 #283 #291 #297) — visual diff

Generated by \`scripts/probe-render-focus-ring-meta-281.mjs\`.

| Surface | Before | After |
| --- | --- | --- |
| ShortcutOverlay (typography — #283) | ![](shortcut-overlay-before.png) | ![](shortcut-overlay-after.png) |
| QuestionBlock Submit (focus ring — #291) | ![](question-submit-before.png) | ![](question-submit-after.png) |
| ChatStream jump-to-latest (focus ring — #291) | ![](jump-to-latest-before.png) | ![](jump-to-latest-after.png) |

#281 (Button primary halo → \`var(--color-focus-ring)\` token) and #297
(locale key removal) have no meaningful visual change in dark mode and are
not screenshotted.
`;
await writeFile(resolve(OUT_DIR, 'README.md'), readme);
console.log(`wrote ${resolve(OUT_DIR, 'README.md')}`);
