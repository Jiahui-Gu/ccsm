// scripts/probe-render-banner-switch-tutorial-287.mjs
//
// Visual probe for the bundle PR (#287 #288 #293). Generates BEFORE/AFTER
// PNGs for:
//   - #287: TopBanner double-border when stacked (two banners visible).
//   - #288: Settings notification toggles rendered as raw checkboxes vs the
//           new <Switch> primitive.
//   - #293: Tutorial visual cards using raw oklch() literals vs design
//           tokens.
//
// Mirrors the static-HTML approach used by `probe-render-banners.mjs` —
// the live app needs IPC + agent state to surface these UIs, which is
// impractical for a screenshot probe. Class names + token values are
// inlined to match `src/styles/global.css`.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'dogfood-logs', 'banner-switch-tutorial-287');
await mkdir(OUT_DIR, { recursive: true });

const TOKENS_CSS = `
  :root {
    --color-bg-app: oklch(0.18 0.003 240);
    --color-bg-elevated: oklch(0.22 0.003 240);
    --color-fg-primary: oklch(0.93 0 0);
    --color-fg-secondary: oklch(0.78 0 0);
    --color-fg-tertiary: oklch(0.58 0 0);
    --color-border-subtle: oklch(0.28 0 0);
    --color-border-strong: oklch(0.44 0 0);
    --color-accent: oklch(0.74 0.13 215);
    --color-state-running: oklch(0.78 0.13 155);
    --color-state-waiting: oklch(0.78 0.10 75);
  }
  html, body { margin: 0; padding: 0; background: var(--color-bg-app);
    color: var(--color-fg-primary);
    font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased; }
  .frame { width: 920px; }
  .stack-frame { width: 520px; }
  .meta { font-size: 11px; line-height: 14px; }
  .semi { font-weight: 600; }
  .mono { font-family: 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace; }
  .grow { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .truncate { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .opacity-90 { opacity: 0.9; }
  .actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .icon { flex-shrink: 0; }

  /* ── #287: banner row ──────────────────────────────────────────── */
  .banner-row { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
    border-bottom: 1px solid var(--color-border-subtle); }
  .err  { background: oklch(0.30 0.11 25);  color: oklch(0.95 0.06 25); }
  .warn { background: oklch(0.32 0.08 75);  color: oklch(0.94 0.06 90); }
  .btn { flex-shrink: 0; height: 28px; padding: 0 10px; border-radius: 4px;
    font-size: 11px; font-weight: 500; display: inline-flex; align-items: center;
    gap: 6px; background: rgba(0,0,0,0.10); color: inherit; border: 0; cursor: pointer; }
  .btn.primary { background: rgba(0,0,0,0.25); }
  .btn.icon-sq { width: 28px; padding: 0; justify-content: center; }
  .stack-after [data-top-banner]:not(:last-child) > .banner-row { border-bottom-width: 0; }

  /* ── #288: settings field ──────────────────────────────────────── */
  .settings-card { padding: 24px; background: var(--color-bg-app); }
  .settings-row { display: flex; align-items: center; justify-content: space-between;
    padding: 12px 0; border-bottom: 1px solid var(--color-border-subtle); }
  .settings-label { font-size: 12px; color: var(--color-fg-primary); font-weight: 500; }
  .settings-hint { font-size: 11px; color: var(--color-fg-tertiary); margin-top: 2px; }
  /* old: native checkbox */
  .raw-cb { width: 16px; height: 16px; accent-color: var(--color-accent); cursor: pointer; }
  /* new: switch primitive */
  .sw { position: relative; display: inline-flex; align-items: center; height: 16px;
    width: 28px; border-radius: 9999px; background: var(--color-border-strong);
    cursor: pointer; transition: background 150ms; border: 0; padding: 0; }
  .sw[data-state="checked"] { background: var(--color-accent); }
  .sw .thumb { position: absolute; left: 2px; height: 12px; width: 12px;
    background: white; border-radius: 9999px; transition: transform 150ms ease-out;
    box-shadow: 0 1px 2px rgba(0,0,0,0.3); }
  .sw[data-state="checked"] .thumb { transform: translateX(12px); }

  /* ── #293: tutorial card ───────────────────────────────────────── */
  .tut-card { position: relative; width: 100%; max-width: 384px; aspect-ratio: 4/3;
    border-radius: 12px; border: 1px solid var(--color-border-subtle);
    background: color-mix(in oklch, var(--color-bg-elevated), transparent 40%);
    backdrop-filter: blur(6px); padding: 16px; }
  .tut-card.before { box-shadow: 0 24px 48px -12px oklch(0 0 0 / 0.5); }
  .tut-card.after { box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); }
  .tut-card-inner { display: flex; height: 100%; align-items: center; justify-content: center; }
  .welcome-square { display: flex; height: 64px; width: 64px; align-items: center;
    justify-content: center; border-radius: 16px; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.3); }
  .welcome-square.before { background-image: linear-gradient(to bottom right, oklch(0.72 0.14 215), oklch(0.55 0.18 265)); }
  .welcome-square.after  { background: var(--color-accent); }
  .row-list { display: flex; flex-direction: column; gap: 8px; }
  .row-item { display: flex; align-items: center; gap: 8px; border-radius: 6px;
    padding: 8px 12px; background: color-mix(in oklch, var(--color-bg-app), transparent 40%);
    border: 1px solid var(--color-border-subtle); }
  .dot { display: inline-block; height: 6px; width: 6px; border-radius: 9999px; }
  .dot.before-running { background: oklch(0.78 0.16 145); }
  .dot.before-waiting { background: oklch(0.78 0.16 70); }
  .dot.after-running  { background: var(--color-state-running); }
  .dot.after-waiting  { background: var(--color-state-waiting); }
  .dot.idle { background: var(--color-fg-tertiary); }

  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .panel { padding: 16px; }
`;

const iconAlertOctagon = `
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon">
    <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/>
    <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
const iconAlertTriangle = `
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon">
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
    <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

// ─── #287 banner stack ──────────────────────────────────────────────
const banner1 = `
  <div data-top-banner>
    <div class="banner-row warn">
      ${iconAlertTriangle}
      <div class="grow"><span class="meta semi">Claude CLI not configured</span></div>
      <div class="actions"><button class="btn">Set up</button></div>
    </div>
  </div>`;
const banner2 = `
  <div data-top-banner>
    <div class="banner-row err">
      ${iconAlertOctagon}
      <div class="grow"><span class="meta semi">Failed to start Claude</span>
        <span class="meta mono opacity-90 truncate">spawn ENOENT</span></div>
      <div class="actions">
        <button class="btn primary">Retry</button>
        <button class="btn">Reconfigure</button>
      </div>
      <button class="btn icon-sq" aria-label="Dismiss">×</button>
    </div>
  </div>`;

const stackBefore = `<div class="stack-frame">${banner1}${banner2}</div>`;
const stackAfter = `<div class="stack-frame stack-after">${banner1}${banner2}</div>`;

// ─── #288 settings toggles ──────────────────────────────────────────
function settingsRow(label, hint, control) {
  return `
    <div class="settings-row">
      <div>
        <div class="settings-label">${label}</div>
        ${hint ? `<div class="settings-hint">${hint}</div>` : ''}
      </div>
      ${control}
    </div>`;
}
const cb = (checked) =>
  `<input type="checkbox" class="raw-cb" ${checked ? 'checked' : ''} aria-label="toggle">`;
const sw = (checked) =>
  `<button class="sw" data-state="${checked ? 'checked' : 'unchecked'}" role="switch" aria-checked="${checked}"><span class="thumb"></span></button>`;

const settingsToggles = (control) => `
  <div class="settings-card frame">
    ${settingsRow('Enable notifications', null, control(true))}
    ${settingsRow('System permission granted', 'macOS will ask the first time.', control(true))}
    ${settingsRow('Permission requests', 'When the agent needs your approval.', control(true))}
    ${settingsRow('Turn done', 'When the agent finishes a turn.', control(false))}
    ${settingsRow('Sound', 'Play the system notification sound.', control(true))}
    ${settingsRow('Automatic update checks', 'Check for updates on launch.', control(true))}
  </div>`;

// ─── #293 tutorial cards ────────────────────────────────────────────
const welcomeCard = (mode) => `
  <div class="tut-card ${mode}">
    <div class="tut-card-inner">
      <div class="welcome-square ${mode}">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white"
          stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </div>
    </div>
  </div>`;
const sessionsCard = (mode) => {
  const r = mode === 'before' ? 'before-running' : 'after-running';
  const w = mode === 'before' ? 'before-waiting' : 'after-waiting';
  return `
    <div class="tut-card ${mode}">
      <div class="row-list">
        <div class="row-item"><span class="dot ${r}"></span><span class="meta mono">Refactor auth middleware</span></div>
        <div class="row-item"><span class="dot ${w}"></span><span class="meta mono">Investigate flaky test</span></div>
        <div class="row-item"><span class="dot idle"></span><span class="meta mono">Sketch landing page copy</span></div>
      </div>
    </div>`;
};
const tutorialPanel = (mode) => `
  <div class="panel">
    <div class="pair">
      ${welcomeCard(mode)}
      ${sessionsCard(mode)}
    </div>
  </div>`;

function pageHtml(title, body, viewport = 'frame') {
  return `<!doctype html>
    <html><head><meta charset="utf-8"><title>${title}</title>
    <style>${TOKENS_CSS}</style></head>
    <body><div class="${viewport}">${body}</div></body></html>`;
}

const cases = [
  ['banner-stack-before', pageHtml('banner stack before', stackBefore, 'stack-frame')],
  ['banner-stack-after',  pageHtml('banner stack after',  stackAfter,  'stack-frame')],
  ['settings-toggles-before', pageHtml('settings before', settingsToggles(cb), 'frame')],
  ['settings-toggles-after',  pageHtml('settings after',  settingsToggles(sw), 'frame')],
  ['tutorial-before', pageHtml('tutorial before', tutorialPanel('before'), 'frame')],
  ['tutorial-after',  pageHtml('tutorial after',  tutorialPanel('after'),  'frame')],
];

const browser = await chromium.launch();
try {
  for (const [name, html] of cases) {
    const isSettings = name.startsWith('settings');
    const isTutorial = name.startsWith('tutorial');
    const ctx = await browser.newContext({
      viewport: {
        width: isSettings ? 960 : isTutorial ? 960 : 560,
        height: isSettings ? 480 : isTutorial ? 380 : 160,
      },
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    const sel = isSettings ? '.frame' : isTutorial ? '.panel' : '.stack-frame';
    const target = page.locator(sel).first();
    const out = resolve(OUT_DIR, `${name}.png`);
    await target.screenshot({ path: out });
    console.log(`wrote ${out}`);
    await ctx.close();
  }
} finally {
  await browser.close();
}

const readme = `# Banner stack + Switch + Tutorial tokens (#287 #288 #293)

Generated by \`scripts/probe-render-banner-switch-tutorial-287.mjs\`.

## #287 — TopBanner stack double-border

Two banners stacked (CLI missing + agent init failed). Before: each banner
draws its own \`border-b\`, producing a doubled hairline between them. After:
the \`<TopBannerStack>\` wrapper nullifies \`border-b\` on every non-last
banner, leaving a single separator below the whole stack.

| Before | After |
| --- | --- |
| ![](banner-stack-before.png) | ![](banner-stack-after.png) |

## #288 — Settings Switch primitive

Notification + auto-update toggles previously rendered as native
\`<input type="checkbox">\`, which cannot be styled consistently and is
announced as "checkbox" by screen readers. After: Radix-based \`<Switch>\`
primitive with track + thumb, announced as "switch".

| Before | After |
| --- | --- |
| ![](settings-toggles-before.png) | ![](settings-toggles-after.png) |

## #293 — Tutorial raw oklch -> tokens

Tutorial visuals previously hard-coded raw \`oklch()\` color literals (welcome
gradient, session-row state dots, drop shadow). After: replaced with semantic
tokens (\`bg-accent\`, \`bg-state-running\`, \`bg-state-waiting\`, \`shadow-xl\`)
so light-theme overrides flow through automatically.

| Before | After |
| --- | --- |
| ![](tutorial-before.png) | ![](tutorial-after.png) |
`;
await writeFile(resolve(OUT_DIR, 'README.md'), readme);
console.log(`wrote ${resolve(OUT_DIR, 'README.md')}`);
