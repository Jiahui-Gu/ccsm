// scripts/probe-render-tokens-u3.mjs
//
// Visual probe for Wave U3 (#255) — token cleanup. Captures before/after
// screenshots for the three audit items:
//
//   A. text-meta sweep    — TopBanner body line + ShortcutOverlay header /
//                           kbd chip text size now use the canonical 11px
//                           token instead of the bespoke `text-[11px]`.
//   B. Toast buttons      — Toast action + dismiss buttons now ride the
//                           shared <Button> primitive (secondary + ghost).
//   C. Drag-overlay       — SidebarS5 drag overlay reads its drop shadow
//                           from `--shadow-drag-overlay` instead of the
//                           inline `shadow-[…]` tuple. Visual is unchanged
//                           in dark mode but the token gives the LIGHT
//                           theme a separately-tuned, less-punchy version.
//
// Output: PNG pairs under `dogfood-logs/tokens-u3-255/`. The PR body
// references these via the markdown screenshot table per project rule
// (`feedback_visual_fix_screenshots.md`).
//
// Pattern mirrors `scripts/probe-render-focus-ring-u2.mjs`: static HTML
// approximations of each surface that reuse the EXACT token values from
// `src/styles/global.css`. No agent boot required — these are pure CSS /
// markup changes and a static probe gives stable pixel screenshots.
//
// HOME is sanitized below so the headless browser process never inherits
// user skill files (per `feedback_probe_skill_injection.md`).

import { chromium } from 'playwright';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

// Sanitize HOME so the headless browser process doesn't pick up any
// skill manifests / user state from ~/.claude.
const sandboxHome = await mkdtemp(join(tmpdir(), 'probe-tokens-u3-'));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
process.env.CLAUDE_HOME = sandboxHome;

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'dogfood-logs', 'tokens-u3-255');

await mkdir(OUT_DIR, { recursive: true });

// Inline the subset of dark-mode tokens this probe exercises. Values are
// copied verbatim from `src/styles/global.css` (the dark @theme block) so
// the screenshots match what users see in the live app.
const TOKENS_CSS = `
  :root {
    --color-bg-app: oklch(0.16 0.003 240);
    --color-bg-sidebar: oklch(0.225 0.003 240);
    --color-bg-panel: oklch(0.18 0.003 240);
    --color-bg-elevated: oklch(0.26 0.003 240);
    --color-bg-hover: oklch(0.295 0.003 240);
    --color-bg-active: oklch(0.33 0.004 240);
    --color-fg-primary: oklch(0.93 0 0);
    --color-fg-secondary: oklch(0.80 0 0);
    --color-fg-tertiary: oklch(0.72 0 0);
    --color-border-subtle: oklch(0.28 0 0);
    --color-border-default: oklch(0.34 0 0);
    --color-border-strong: oklch(0.44 0 0);
    --color-state-waiting: oklch(0.78 0.10 75);
    --color-state-error: oklch(0.65 0.20 25);
    --color-state-error-fg: oklch(0.97 0 0);
    --color-state-error-soft: oklch(0.65 0.20 25 / 0.14);
    --color-accent: oklch(0.74 0.13 215);
    --color-accent-fg: oklch(0.18 0 0);
    --surface-highlight: oklch(1 0 0 / 0.04);
    --shadow-drag-overlay:
      0 12px 32px -8px oklch(0 0 0 / 0.5),
      0 0 0 1px oklch(1 0 0 / 0.08);
    --text-meta: 11px;
    --text-meta-lh: 14px;
    --text-chrome: 13px;
    --text-chrome-lh: 18px;
    --text-body: 15px;
    --text-heading: 16px;
  }
  html, body {
    margin: 0; padding: 0;
    background: var(--color-bg-app);
    color: var(--color-fg-primary);
    font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .frame { padding: 24px; width: 720px; }

  /* ── A. TopBanner body / ShortcutOverlay header ── */
  .banner {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; border-bottom: 1px solid var(--color-border-subtle);
    background: oklch(0.30 0.05 240); color: oklch(0.94 0.02 240);
    border-radius: 4px;
  }
  .banner .col { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .banner .title { font-size: var(--text-meta); line-height: var(--text-meta-lh); font-weight: 600; }
  .banner .body-bespoke { font-size: 11px; line-height: 14px; opacity: 0.9; font-family: ui-monospace, Menlo, Consolas, monospace; }
  .banner .body-token { font-size: var(--text-meta); line-height: var(--text-meta-lh); opacity: 0.9; font-family: ui-monospace, Menlo, Consolas, monospace; }

  .shortcut-section { padding: 16px; background: var(--color-bg-panel); border: 1px solid var(--color-border-subtle); border-radius: 8px; }
  .shortcut-h-bespoke {
    font-size: 11px; line-height: 14px;
    font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--color-fg-tertiary); margin: 0 0 8px;
  }
  .shortcut-h-token {
    font-size: var(--text-meta); line-height: var(--text-meta-lh);
    font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--color-fg-tertiary); margin: 0 0 8px;
  }
  .kbd-row { display: flex; gap: 6px; align-items: center; }
  .kbd-bespoke, .kbd-token {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 22px; height: 22px; padding: 0 6px;
    border-radius: 3px; border: 1px solid var(--color-border-default);
    background: var(--color-bg-elevated); color: var(--color-fg-primary);
    font-family: ui-monospace, Menlo, Consolas, monospace; line-height: 1;
    box-shadow: inset 0 -1px 0 0 oklch(0 0 0 / 0.25);
  }
  .kbd-bespoke { font-size: 11px; }
  .kbd-token { font-size: var(--text-meta); }

  /* ── B. Toast — bespoke buttons vs. shared Button primitive ── */
  .toast {
    pointer-events: auto; position: relative;
    border-radius: 6px; border: 1px solid var(--color-border-default);
    padding: 10px 12px;
    background: var(--color-bg-elevated);
    box-shadow:
      inset 0 1px 0 0 var(--surface-highlight),
      0 1px 2px oklch(0 0 0 / 0.3),
      0 4px 16px oklch(0 0 0 / 0.2);
    width: 320px;
  }
  .toast .row { display: flex; align-items: flex-start; gap: 8px; }
  .toast .glyph { margin-top: 3px; width: 8px; height: 8px; border-radius: 50%; background: var(--color-state-waiting); flex-shrink: 0; }
  .toast .col { min-width: 0; flex: 1; }
  .toast .t-title { font-size: var(--text-chrome); line-height: 1.15; font-weight: 500; color: var(--color-fg-primary); }
  .toast .t-body  { margin-top: 2px; font-size: var(--text-meta); line-height: var(--text-meta-lh); color: var(--color-fg-tertiary); }
  .toast .actions { margin-top: 8px; display: flex; align-items: center; gap: 8px; }

  /* BEFORE: bespoke buttons — text-meta + bg-bg-app + border-default */
  .toast-btn-before-action {
    font-size: var(--text-meta); line-height: 1; font-weight: 500;
    padding: 4px 8px; border-radius: 3px;
    background: var(--color-bg-app); border: 1px solid var(--color-border-default);
    color: var(--color-fg-primary);
    cursor: pointer; font-family: inherit;
  }
  .toast-btn-before-dismiss {
    font-size: var(--text-meta); line-height: 1;
    padding: 4px 8px; border-radius: 3px;
    background: transparent; border: 0;
    color: var(--color-fg-tertiary);
    cursor: pointer; font-family: inherit;
  }

  /* AFTER: <Button variant="secondary" size="xs"> + <Button variant="ghost" size="xs"> */
  .btn {
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 6px; user-select: none; white-space: nowrap;
    height: 24px; padding: 0 8px; gap: 6px;
    font-size: var(--text-meta); line-height: 1;
    font-family: inherit;
    transition: background-color 150ms cubic-bezier(0.32, 0.72, 0, 1),
                border-color 150ms cubic-bezier(0.32, 0.72, 0, 1),
                color 150ms cubic-bezier(0.32, 0.72, 0, 1);
    cursor: pointer;
  }
  .btn-secondary {
    background: var(--color-bg-elevated);
    color: var(--color-fg-secondary);
    border: 1px solid var(--color-border-default);
    box-shadow: inset 0 1px 0 0 oklch(1 0 0 / 0.06);
  }
  .btn-ghost {
    background: transparent;
    color: var(--color-fg-secondary);
    border: 1px solid transparent;
  }

  /* ── C. Drag overlay ── */
  .sidebar-mock {
    width: 280px; height: 240px; padding: 12px;
    background: var(--color-bg-sidebar); border-radius: 8px;
    border: 1px solid var(--color-border-subtle);
    position: relative; overflow: hidden;
  }
  .row {
    display: flex; align-items: center; gap: 10px;
    height: 36px; padding: 0 8px 0 12px; border-radius: 3px;
    color: var(--color-fg-primary); font-size: var(--text-chrome);
  }
  .row.dim { opacity: 0.55; }
  .row .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--color-state-waiting); flex-shrink: 0; }
  .drag-tile {
    position: absolute; left: 36px; top: 86px;
    display: flex; align-items: center; gap: 10px;
    width: 240px; height: 36px; padding: 0 8px 0 12px;
    border-radius: 3px;
    background: var(--color-bg-active); color: var(--color-fg-primary);
    font-size: var(--text-chrome); font-weight: 500;
  }
  /* BEFORE: inline shadow tuple (verbatim from previous Sidebar.tsx). */
  .drag-tile.before {
    box-shadow:
      0 12px 32px -8px rgba(0,0,0,0.5),
      0 0 0 1px oklch(1 0 0 / 0.08);
  }
  /* AFTER: token-driven shadow. */
  .drag-tile.after { box-shadow: var(--shadow-drag-overlay); }

  .stack { display: flex; flex-direction: column; gap: 14px; }
  .case-tag {
    font-size: var(--text-meta); line-height: var(--text-meta-lh);
    text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--color-fg-tertiary); margin-bottom: 4px;
  }
`;

// ─── Surfaces ───────────────────────────────────────────────────────────────

function topBannerHtml({ bodyClass }) {
  return `
    <div class="stack">
      <div class="case-tag">TopBanner — info variant</div>
      <div class="banner">
        <div class="col">
          <span class="title">Claude CLI not detected</span>
          <span class="${bodyClass}">searched: /usr/local/bin, ~/.npm-global/bin</span>
        </div>
      </div>
    </div>
  `;
}

function shortcutHtml({ headerClass, kbdClass }) {
  return `
    <div class="stack">
      <div class="case-tag">ShortcutOverlay — section header + kbd chip</div>
      <div class="shortcut-section">
        <h3 class="${headerClass}">Navigation</h3>
        <div class="kbd-row">
          <span class="${kbdClass}">Ctrl</span>
          <span style="color: var(--color-fg-tertiary); font-size: var(--text-meta)">+</span>
          <span class="${kbdClass}">Shift</span>
          <span style="color: var(--color-fg-tertiary); font-size: var(--text-meta)">+</span>
          <span class="${kbdClass}">N</span>
        </div>
      </div>
    </div>
  `;
}

function toastHtml({ before }) {
  const actions = before
    ? `
        <button class="toast-btn-before-action">Restart</button>
        <button class="toast-btn-before-dismiss">Dismiss</button>
      `
    : `
        <button class="btn btn-secondary">Restart</button>
        <button class="btn btn-ghost">Dismiss</button>
      `;
  return `
    <div class="stack">
      <div class="case-tag">Toast — action + dismiss buttons</div>
      <div class="toast">
        <div class="row">
          <span class="glyph"></span>
          <div class="col">
            <div class="t-title">Update downloaded</div>
            <div class="t-body">Restart to apply v0.5.0.</div>
            <div class="actions">${actions}</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function dragOverlayHtml({ tileClass }) {
  return `
    <div class="stack">
      <div class="case-tag">SidebarS5 — drag overlay shadow</div>
      <div class="sidebar-mock">
        <div class="row dim"><span class="dot" style="background: var(--color-fg-tertiary)"></span>worker-a-ipc</div>
        <div class="row dim"><span class="dot" style="background: var(--color-fg-tertiary)"></span>fix/popover-mutex</div>
        <div class="row dim"><span class="dot" style="background: var(--color-fg-tertiary)"></span>style/sidebar</div>
        <div class="row dim"><span class="dot" style="background: var(--color-fg-tertiary)"></span>feat/banner-trio</div>
        <div class="drag-tile ${tileClass}">
          <span class="dot"></span>refactor/tokens-u3
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
  // A. TopBanner body line
  ['topbanner-before', pageHtml('topbanner body (before)',
    topBannerHtml({ bodyClass: 'body-bespoke' }))],
  ['topbanner-after',  pageHtml('topbanner body (after)',
    topBannerHtml({ bodyClass: 'body-token' }))],

  // A. ShortcutOverlay header + kbd chip
  ['shortcut-before', pageHtml('shortcut header (before)',
    shortcutHtml({ headerClass: 'shortcut-h-bespoke', kbdClass: 'kbd-bespoke' }))],
  ['shortcut-after',  pageHtml('shortcut header (after)',
    shortcutHtml({ headerClass: 'shortcut-h-token',   kbdClass: 'kbd-token' }))],

  // B. Toast buttons
  ['toast-before', pageHtml('toast buttons (before)', toastHtml({ before: true }))],
  ['toast-after',  pageHtml('toast buttons (after)',  toastHtml({ before: false }))],

  // C. Drag overlay
  ['drag-before', pageHtml('drag overlay (before)', dragOverlayHtml({ tileClass: 'before' }))],
  ['drag-after',  pageHtml('drag overlay (after)',  dragOverlayHtml({ tileClass: 'after' }))],
];

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    viewport: { width: 760, height: 360 },
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

const readme = `# Tokens U3 (#255) — visual diff

Generated by \`scripts/probe-render-tokens-u3.mjs\`.

| Surface | Before | After |
| --- | --- | --- |
| TopBanner body line (text-[11px] -> text-meta) | ![](topbanner-before.png) | ![](topbanner-after.png) |
| ShortcutOverlay header + kbd chip (text-[11px] -> text-meta) | ![](shortcut-before.png) | ![](shortcut-after.png) |
| Toast action + dismiss buttons (bespoke -> Button primitive) | ![](toast-before.png) | ![](toast-after.png) |
| SidebarS5 drag overlay shadow (inline -> --shadow-drag-overlay) | ![](drag-before.png) | ![](drag-after.png) |

The probe renders a static HTML approximation that mirrors the exact class
names + design-token values used by the live components (\`src/styles/global.css\`),
so visuals match what users see in the running Electron app without
needing the full app boot.

**A. text-meta sweep:** the bespoke \`text-[11px]\` tuples were already at
the canonical 11px size, so the rendered glyphs are pixel-identical. The
win is single-source-of-truth: appearance-slider scaling and any future
type-tier nudge land on these surfaces automatically.

**B. Toast buttons:** AFTER picks up the Apple-tier hover/active/focus
treatment from the shared Button primitive (inset highlight, spring tap,
focus halo) instead of the hand-rolled hover-only styling.

**C. Drag-overlay shadow:** dark-mode visual is unchanged (the token holds
the same values that were inline). The win is the LIGHT-mode override
in \`src/styles/global.css\` — a warmer, lower-alpha shadow tuned for the
near-white sidebar so the dragged tile reads as lift rather than a hole.
`;
await writeFile(resolve(OUT_DIR, 'README.md'), readme);
console.log(`wrote ${resolve(OUT_DIR, 'README.md')}`);
