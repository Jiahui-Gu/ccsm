// scripts/probe-render-cli-missing-focus-ring-260.mjs
//
// Visual probe for Task #260 — focus-ring consistency on the
// ClaudeCliMissingDialog footer link ("Minimize to banner") and tab strip.
// Audit (CMD3 / CMD4) flagged that these two surfaces relied on color-only
// focus indicators (`focus-visible:text-fg-primary`) with no halo, breaking
// parity with the canonical `.focus-ring` utility used by SettingsDialog
// tabs and the rest of the app.
//
// We capture before/after screenshots for both surfaces. As with #237 / #240
// probes, the page is a static HTML approximation that mirrors the EXACT
// class names + token values resolved from `src/styles/global.css` so the
// pixels match the running app without requiring a full Electron boot.
//
// HOME is sanitized so the headless browser never inherits user skill files
// (per `feedback_probe_skill_injection.md`).

import { chromium } from 'playwright';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const sandboxHome = await mkdtemp(join(tmpdir(), 'probe-cli-missing-focus-260-'));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
process.env.CLAUDE_HOME = sandboxHome;

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'dogfood-logs', 'cli-missing-dialog-260');
await mkdir(OUT_DIR, { recursive: true });

// Token values copied verbatim from src/styles/global.css (dark @theme).
const TOKENS_CSS = `
  :root {
    --color-bg-app: oklch(0.16 0.003 240);
    --color-bg-panel: oklch(0.18 0.003 240);
    --color-fg-primary: oklch(0.93 0 0);
    --color-fg-secondary: oklch(0.80 0 0);
    --color-fg-tertiary: oklch(0.72 0 0);
    --color-border-subtle: oklch(0.28 0 0);
    --color-accent: oklch(0.74 0.13 215);
    --text-meta: 11px;
    --text-meta-lh: 14px;
    --text-chrome: 13px;
    --text-chrome-lh: 18px;
  }
  html, body {
    margin: 0; padding: 0;
    background: var(--color-bg-app);
    color: var(--color-fg-primary);
    font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .frame { padding: 24px; width: 560px; background: var(--color-bg-panel); border-radius: 8px; }

  /* Tab strip — matches Tabs() in ClaudeCliMissingDialog.tsx */
  .tablist {
    display: flex; align-items: center; gap: 4px;
    padding: 0 20px; border-bottom: 1px solid var(--color-border-subtle);
  }
  .tab-btn {
    position: relative; height: 32px; padding: 0 12px;
    font-size: var(--text-chrome); line-height: var(--text-chrome-lh);
    background: transparent; border: 0; cursor: pointer;
    color: var(--color-fg-tertiary);
    transition: color 150ms ease-out;
    border-radius: 2px;
  }
  .tab-btn.active { color: var(--color-fg-primary); }
  .tab-btn .underline {
    position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;
    background: var(--color-accent);
  }
  /* BEFORE — focus indicator was color only (focus-visible:text-fg-primary). */
  .tab-btn.before-focused { color: var(--color-fg-primary); outline: none; }
  /* AFTER — adds .focus-ring (1px inset accent). */
  .tab-btn.after-focused {
    color: var(--color-fg-primary);
    outline: 1px solid var(--color-accent);
    outline-offset: -1px;
  }

  /* Footer with "Minimize to banner" link — matches dialog footer. */
  .footer {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 12px 20px; border-top: 1px solid var(--color-border-subtle);
  }
  .min-btn {
    font-size: var(--text-meta); line-height: var(--text-meta-lh);
    color: var(--color-fg-tertiary);
    background: transparent; border: 0; cursor: pointer;
    padding: 0 4px; margin: 0 -4px;
    border-radius: 2px;
    transition: color 150ms ease-out;
  }
  /* BEFORE — color-only focus. */
  .min-btn.before-focused { color: var(--color-fg-primary); outline: none; }
  /* AFTER — color + .focus-ring halo. */
  .min-btn.after-focused {
    color: var(--color-fg-primary);
    outline: 1px solid var(--color-accent);
    outline-offset: -1px;
  }

  /* Primary action button mock so the footer composition matches the live UI. */
  .primary-btn {
    height: 28px; padding: 0 12px;
    background: var(--color-accent); color: oklch(0.18 0.003 240);
    border-radius: 4px; font-size: var(--text-chrome); font-weight: 500;
  }

  /* Filler so the screenshots show enough of the dialog body for context. */
  .body-filler {
    padding: 16px 20px; min-height: 80px;
    color: var(--color-fg-secondary);
    font-size: var(--text-meta);
  }
`;

function tabsHtml({ focusedClass }) {
  return `
    <div class="tablist">
      <button class="tab-btn active">Install<span class="underline"></span></button>
      <button class="tab-btn ${focusedClass}">I have it</button>
    </div>
    <div class="body-filler">Tab panel body…</div>
    <div class="footer">
      <button class="min-btn">Minimize to banner</button>
      <button class="primary-btn">Retry detect</button>
    </div>
  `;
}

function footerHtml({ focusedClass }) {
  return `
    <div class="tablist">
      <button class="tab-btn active">Install<span class="underline"></span></button>
      <button class="tab-btn">I have it</button>
    </div>
    <div class="body-filler">Tab panel body…</div>
    <div class="footer">
      <button class="min-btn ${focusedClass}">Minimize to banner</button>
      <button class="primary-btn">Retry detect</button>
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
  ['tab-strip-before', pageHtml('tab strip (before)', tabsHtml({ focusedClass: 'before-focused' }))],
  ['tab-strip-after',  pageHtml('tab strip (after)',  tabsHtml({ focusedClass: 'after-focused'  }))],
  ['minimize-link-before', pageHtml('minimize link (before)', footerHtml({ focusedClass: 'before-focused' }))],
  ['minimize-link-after',  pageHtml('minimize link (after)',  footerHtml({ focusedClass: 'after-focused'  }))],
];

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    viewport: { width: 640, height: 280 },
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

const readme = `# ClaudeCliMissingDialog focus-ring (#260) — visual diff

Generated by \`scripts/probe-render-cli-missing-focus-ring-260.mjs\`.

| Surface | Before | After |
| --- | --- | --- |
| Tab strip (focused, inactive tab) | ![](tab-strip-before.png) | ![](tab-strip-after.png) |
| "Minimize to banner" footer link (focused) | ![](minimize-link-before.png) | ![](minimize-link-after.png) |

Audit CMD3 / CMD4 flagged that both surfaces relied on color-only focus
indicators (\`focus-visible:text-fg-primary\`), inconsistent with the
\`.focus-ring\` utility used by SettingsDialog tabs and the rest of the app.
Keyboard users had no halo to anchor focus on — a faint text-color shift on
small chrome elements is essentially invisible, and the inactive tab in
particular sits next to identical untinted siblings.

Fix: add the canonical \`.focus-ring\` utility (1px inset accent) on both
the tab buttons and the footer link, matching the SettingsDialog tab
pattern (\`'outline-none focus-ring'\`).
`;
await writeFile(resolve(OUT_DIR, 'README.md'), readme);
console.log(`wrote ${resolve(OUT_DIR, 'README.md')}`);
