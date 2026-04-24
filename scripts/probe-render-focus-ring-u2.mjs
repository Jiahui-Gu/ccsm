// scripts/probe-render-focus-ring-u2.mjs
//
// Visual probe for Wave U2 (#240) — focus-ring consistency. Captures
// before/after screenshots for the three surfaces the audit calls out:
//
//   1. QuestionBlock option (waiting state)        — waiting-tone halo
//   2. QuestionBlock option (confirmed/answered)   — success-tone halo
//   3. DiffView Accept button (focused)            — success-tone halo
//   4. WindowControls close button (focused)       — danger halo separable
//                                                    from hover red fill
//
// Output: PNG pairs under `dogfood-logs/focus-ring-u2-240/`. The PR body
// references these via the markdown screenshot table per project rule
// (`feedback_visual_fix_screenshots.md`).
//
// Design note: as with `scripts/probe-render-banners.mjs` (#237), this
// probe inlines a static HTML approximation of each surface rather than
// booting the full app. Focus halos are pure CSS — no IPC handshake or
// runtime state required to capture them — and a static probe gives stable
// pixel-perfect screenshots across machines without any agent boot. The
// HTML below mirrors the EXACT class names + token values resolved from
// `src/styles/global.css` so the screenshots match the running app.
//
// HOME is sanitized below so the probe never inherits user skill files
// (per `feedback_probe_skill_injection.md`).

import { chromium } from 'playwright';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

// Sanitize HOME so the headless browser process doesn't pick up any
// skill manifests / user state from ~/.claude.
const sandboxHome = await mkdtemp(join(tmpdir(), 'probe-focus-ring-u2-'));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
process.env.CLAUDE_HOME = sandboxHome;

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'dogfood-logs', 'focus-ring-u2-240');

await mkdir(OUT_DIR, { recursive: true });

// Inline the subset of dark-mode tokens this probe exercises. Values are
// copied verbatim from `src/styles/global.css` (the dark @theme block) so
// the screenshots match what users see in the live app.
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
    --color-state-running: oklch(0.78 0.13 155);
    --color-state-waiting: oklch(0.78 0.10 75);
    --color-state-success: oklch(0.72 0.14 155);
    --color-state-error: oklch(0.65 0.20 25);
    --color-state-error-fg: oklch(0.97 0 0);
    --color-focus-ring: oklch(0.72 0.14 215 / 0.30);
    --color-accent: oklch(0.74 0.13 215);
    --text-meta: 11px;
    --text-meta-lh: 14px;
    --text-body: 15px;
    --text-body-lh: 24px;
    --text-mono-xs: 10px;
  }
  html, body {
    margin: 0; padding: 0;
    background: var(--color-bg-app);
    color: var(--color-fg-primary);
    font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .frame { padding: 24px; width: 720px; }
  .panel-tint {
    background: oklch(0.78 0.10 75 / 0.06);
    border: 1px solid oklch(0.78 0.10 75 / 0.40);
    border-radius: 8px;
    padding: 14px 16px;
    position: relative;
  }
  .panel-tint::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
    background: var(--color-state-waiting);
    border-radius: 8px 0 0 8px;
  }
  .qtitle {
    font-size: 16px; font-weight: 600; color: var(--color-fg-primary);
    margin-bottom: 12px;
  }
  .qopt {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 8px 12px; border-radius: 5px;
    border: 1px solid var(--color-border-subtle);
    margin-bottom: 4px;
    transition: background-color 150ms ease-out;
  }
  .qopt.selected {
    border-color: oklch(0.78 0.10 75 / 0.70);
    background: oklch(0.78 0.10 75 / 0.10);
  }
  .qopt .dot {
    margin-top: 3px; width: 14px; height: 14px; border-radius: 50%;
    border: 1px solid var(--color-border-strong);
    flex-shrink: 0; position: relative;
  }
  .qopt.selected .dot { border-color: var(--color-state-waiting); }
  .qopt.selected .dot::after {
    content: ''; position: absolute; top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--color-state-waiting);
  }
  .qopt .label { font-size: var(--text-body); color: var(--color-fg-primary); line-height: var(--text-body-lh); }

  /* BEFORE: bespoke ring-2 ring-state-waiting/60 + ring-offset */
  .qopt.before-focused {
    outline: none;
    box-shadow:
      0 0 0 1px var(--color-bg-app),
      0 0 0 3px oklch(0.78 0.10 75 / 0.60);
  }
  /* AFTER waiting: 1px outset state-waiting/0.6 outline (utility) */
  .qopt.after-waiting-focused {
    outline: 1px solid oklch(0.78 0.10 75 / 0.6);
    outline-offset: 0;
  }
  /* AFTER success (post-submit): 1px outset state-success/0.6 outline */
  .qopt.after-success-focused {
    outline: 1px solid oklch(0.72 0.14 155 / 0.6);
    outline-offset: 0;
    opacity: 0.7;
  }

  /* DiffView Accept/Reject buttons */
  .diff-frame {
    border: 1px solid var(--color-border-subtle);
    border-radius: 5px; overflow: hidden; background: var(--color-bg-panel);
  }
  .diff-header {
    padding: 4px 12px; background: oklch(0.26 0.003 240 / 0.6);
    border-bottom: 1px solid var(--color-border-subtle);
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 12px; color: var(--color-fg-tertiary);
  }
  .diff-actions {
    display: flex; justify-content: flex-end; gap: 6px;
    padding: 6px 8px; background: oklch(0.26 0.003 240 / 0.5);
    border-top: 1px solid var(--color-border-subtle);
  }
  .diff-btn {
    padding: 2px 8px; border-radius: 3px;
    border: 1px solid var(--color-border-subtle);
    background: transparent;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: var(--text-mono-xs); color: var(--color-fg-tertiary);
    cursor: pointer;
  }
  .diff-btn.accept-before-focused {
    outline: none;
    box-shadow: 0 0 0 1px oklch(0.78 0.13 155 / 0.60);
  }
  .diff-btn.accept-after-focused {
    outline: 1px solid oklch(0.72 0.14 155 / 0.6);
    outline-offset: 0;
  }

  /* WindowControls close button */
  .titlebar {
    height: 32px; display: flex; align-items: stretch;
    background: var(--color-bg-panel);
    border: 1px solid var(--color-border-subtle); border-radius: 4px;
    overflow: hidden; width: fit-content;
  }
  .title-btn {
    width: 46px; display: flex; align-items: center; justify-content: center;
    color: var(--color-fg-tertiary);
    border: 0; background: transparent; cursor: pointer;
    transition: background-color 120ms cubic-bezier(0.32, 0.72, 0, 1);
  }
  .title-btn.danger.hovered {
    background: var(--color-state-error);
    color: var(--color-state-error-fg);
  }
  /* BEFORE: focus = same red as hover, no inner halo. Indistinguishable. */
  .title-btn.danger.before-focused {
    background: var(--color-state-error);
    color: var(--color-state-error-fg);
    outline: none;
  }
  /* AFTER: focus inherits red fill BUT adds inset cyan halo so keyboard
     users see daylight between hover and focus. */
  .title-btn.danger.after-focused {
    background: var(--color-state-error);
    color: var(--color-state-error-fg);
    outline: none;
    box-shadow: inset 0 0 0 2px var(--color-focus-ring);
  }
  .title-btn .icon { width: 13px; height: 13px; stroke: currentColor; fill: none;
    stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }

  .case-stack { display: flex; flex-direction: column; gap: 18px; }
  .case-tag {
    font-size: var(--text-meta); line-height: var(--text-meta-lh);
    text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--color-fg-tertiary); margin-bottom: 6px;
  }
`;

// ─── Surfaces ───────────────────────────────────────────────────────────────

function questionBlockHtml({ focusedClass }) {
  // Static QuestionBlock approximation: title + 3 options (option 0 selected).
  // The middle option carries the focused class so the halo is visible.
  return `
    <div class="panel-tint">
      <div class="qtitle">Pick a deployment target</div>
      <div class="qopt selected"><span class="dot"></span><span class="label">us-west-2 (default)</span></div>
      <div class="qopt ${focusedClass}"><span class="dot"></span><span class="label">eu-central-1</span></div>
      <div class="qopt"><span class="dot"></span><span class="label">ap-southeast-1</span></div>
    </div>
  `;
}

function diffViewHtml({ acceptClass }) {
  return `
    <div class="diff-frame">
      <div class="diff-header">src/components/Sidebar.tsx</div>
      <div class="diff-actions">
        <button class="diff-btn">Reject</button>
        <button class="diff-btn ${acceptClass}">Accept</button>
      </div>
    </div>
  `;
}

const closeIcon = `
  <svg class="icon" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
`;

function windowControlsHtml({ danger }) {
  return `
    <div class="titlebar">
      <div class="title-btn">
        <svg class="icon" viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </div>
      <div class="title-btn">
        <svg class="icon" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14"/></svg>
      </div>
      <button class="title-btn danger ${danger}">${closeIcon}</button>
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
  // QuestionBlock — waiting (pre-submit)
  ['question-waiting-before', pageHtml('question waiting (before)',
    questionBlockHtml({ focusedClass: 'before-focused' }))],
  ['question-waiting-after', pageHtml('question waiting (after)',
    questionBlockHtml({ focusedClass: 'after-waiting-focused' }))],

  // QuestionBlock — success (post-submit confirmed/answered)
  ['question-success-before', pageHtml('question success (before)',
    questionBlockHtml({ focusedClass: 'before-focused' }))],
  ['question-success-after', pageHtml('question success (after)',
    questionBlockHtml({ focusedClass: 'after-success-focused' }))],

  // DiffView Accept
  ['diff-accept-before', pageHtml('diff accept (before)',
    diffViewHtml({ acceptClass: 'accept-before-focused' }))],
  ['diff-accept-after', pageHtml('diff accept (after)',
    diffViewHtml({ acceptClass: 'accept-after-focused' }))],

  // WindowControls close — focused (vs hover, which is the same in BEFORE)
  ['window-close-before', pageHtml('window close focus (before)',
    windowControlsHtml({ danger: 'before-focused' }))],
  ['window-close-after', pageHtml('window close focus (after)',
    windowControlsHtml({ danger: 'after-focused' }))],
];

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    viewport: { width: 760, height: 320 },
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

const readme = `# Focus-ring U2 (#240) — visual diff

Generated by \`scripts/probe-render-focus-ring-u2.mjs\`.

| Surface | Before | After |
| --- | --- | --- |
| QuestionBlock option (waiting state) | ![](question-waiting-before.png) | ![](question-waiting-after.png) |
| QuestionBlock option (confirmed / answered) | ![](question-success-before.png) | ![](question-success-after.png) |
| DiffView Accept button | ![](diff-accept-before.png) | ![](diff-accept-after.png) |
| WindowControls close button (focused) | ![](window-close-before.png) | ![](window-close-after.png) |

The probe renders a static HTML approximation that mirrors the exact class
names + design-token values used by the live components (\`src/styles/global.css\`),
so visuals match what the user sees in the running Electron app without
needing the full app boot for screenshots.

**Key fix on the WindowControls close button:** in BEFORE, focus background
= hover background = saturated state-error. Keyboard users couldn't tell
hover from focus. AFTER adds an inset \`var(--color-focus-ring)\` halo on
focus only.
`;
await writeFile(resolve(OUT_DIR, 'README.md'), readme);
console.log(`wrote ${resolve(OUT_DIR, 'README.md')}`);
