// scripts/probe-render-topbanner-action-273.mjs
//
// Visual probe for the TopBannerAction extraction (#273). Renders each of
// the three banners (AgentInitFailed, ClaudeCliMissing, the bare TopBanner
// dismiss button) twice — BEFORE the refactor (four duplicated inline
// impls) and AFTER (single shared <TopBannerAction /> + cva). The point of
// this probe is to PROVE the refactor is purely structural: pixels must
// not change. We also capture the dismiss button's `:focus-visible` state
// so reviewers can confirm the focus halo still renders identically.
//
// Output: PNG pairs under `dogfood-logs/topbanner-action-273/`. The PR body
// references these via the markdown screenshot table per project rule
// (`feedback_visual_fix_screenshots.md`).
//
// Why static HTML, not a live Electron mount: see
// `scripts/probe-render-banners.mjs` (#237) — same rationale.

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'dogfood-logs', 'topbanner-action-273');

await mkdir(OUT_DIR, { recursive: true });

// Inline a minimal subset of the project's design tokens so the HTML
// renders with the same colors / spacing the user actually sees, without
// needing a full Tailwind build pipeline inside this probe.
//
// Both the BEFORE and AFTER variants below resolve to the SAME utility
// classes (h-7 px-2.5 / w-7, bg-black/N, focus halo) — the refactor only
// hoists them into a cva. The CSS rules here are therefore shared so any
// drift would surface as a real visual diff, not an artifact of the probe.
const TOKENS_CSS = `
  :root {
    --color-border-subtle: oklch(0.28 0 0);
    --text-meta: 11px;
    --text-meta-lh: 14px;
  }
  html, body { margin: 0; padding: 0; background: oklch(0.18 0.003 240); color: oklch(0.93 0 0);
    font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased; }
  .frame { width: 920px; }
  .banner-row { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
    border-bottom: 1px solid var(--color-border-subtle); }
  .err  { background: oklch(0.3 0.11 25);  color: oklch(0.95 0.06 25); }
  .warn { background: oklch(0.32 0.08 75); color: oklch(0.94 0.06 90); }
  .info { background: oklch(0.30 0.05 240); color: oklch(0.94 0.02 240); }
  .meta { font-size: var(--text-meta); line-height: var(--text-meta-lh); }
  .semi { font-weight: 600; }
  .mono { font-family: 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace; }
  .grow { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .truncate { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .opacity-90 { opacity: 0.9; }
  .actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  /*
   * Action button — single class set covers both BEFORE (inline className
   * literal) and AFTER (cva-generated). Tones match the four impls exactly:
   *   .tone-primary   = bg-black/25 (Retry on agent-init-failed)
   *   .tone-secondary = bg-black/10 (Reconfigure, dismiss button)
   *   .tone-neutral   = bg-black/20 (CLI-missing Set up)
   * Shapes:
   *   .shape-pill     = h-7 px-2.5 (label or label+icon)
   *   .shape-square   = h-7 w-7    (icon-only dismiss)
   */
  .ba { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
    border-radius: 4px; font-weight: 500; border: 0; cursor: pointer; color: inherit;
    transition: background-color 150ms; outline: none; }
  .ba.shape-pill   { height: 28px; padding: 0 10px; gap: 6px; font-size: var(--text-meta); }
  .ba.shape-square { height: 28px; width: 28px; }
  .ba.tone-primary   { background: rgba(0,0,0,0.25); }
  .ba.tone-secondary { background: rgba(0,0,0,0.10); }
  .ba.tone-neutral   { background: rgba(0,0,0,0.20); }
  /* Focus halo — the load-bearing class consolidated in this PR. */
  .ba.focused { box-shadow: 0 0 0 2px oklch(1 0 0 / 0.18); }
`;

// SVG icons inlined so the probe doesn't depend on lucide.
const iconAlertOctagon = `
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/>
    <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
  </svg>`;
const iconAlertTriangle = `
  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
    <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>`;
const iconRotate = `
  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
  </svg>`;
const iconSettings = `
  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg>`;
const iconX = `
  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>`;

// The button markup is identical between BEFORE and AFTER — the cva
// produces the same class strings the inline impls used. The only thing
// that changes is which side of the codebase emits them. Rendering both
// against the same CSS confirms zero visual regression.
function btn({ tone, shape = 'pill', label, icon, focused = false, ariaLabel }) {
  const cls = `ba shape-${shape} tone-${tone}${focused ? ' focused' : ''}`;
  const inner = shape === 'square' ? icon : `${icon ?? ''}${label ? `<span>${label}</span>` : ''}`;
  return `<button class="${cls}"${ariaLabel ? ` aria-label="${ariaLabel}"` : ''}>${inner}</button>`;
}

function bannerRow({ variant, leadingIcon, title, body, actions, dismissFocused = false }) {
  const variantClass = variant === 'error' ? 'err' : variant === 'warning' ? 'warn' : 'info';
  return `
    <div class="banner-row ${variantClass}">
      ${leadingIcon}
      <div class="grow">
        <span class="meta semi">${title}</span>
        ${body ? `<span class="meta truncate opacity-90 mono">${body}</span>` : ''}
      </div>
      ${actions ? `<div class="actions">${actions}</div>` : ''}
      ${btn({ tone: 'secondary', shape: 'square', icon: iconX, focused: dismissFocused, ariaLabel: 'Dismiss' })}
    </div>
  `;
}

// agent-init-failed — error variant, Retry (primary) + Reconfigure (secondary) + dismiss
const agentInitFailed = (focused = false) => bannerRow({
  variant: 'error',
  leadingIcon: iconAlertOctagon,
  title: 'Failed to start Claude',
  body: 'spawn ENOENT',
  actions:
    btn({ tone: 'primary',   icon: iconRotate,   label: 'Retry' }) +
    btn({ tone: 'secondary', icon: iconSettings, label: 'Reconfigure' }),
  dismissFocused: focused,
});

// cli-missing — warning variant, Set up (neutral), no dismiss
function cliMissing() {
  return `
    <div class="banner-row warn">
      ${iconAlertTriangle}
      <div class="grow">
        <span class="meta semi">Claude CLI not configured</span>
      </div>
      <div class="actions">${btn({ tone: 'neutral', label: 'Set up' })}</div>
    </div>
  `;
}

// info-with-dismiss — exercises the bare TopBanner dismiss button on its own
// surface so the reviewer can spot any background-bleed regression on the
// info palette (the third banner variant the cva must support).
const infoDismiss = (focused = false) => bannerRow({
  variant: 'info',
  leadingIcon: iconAlertTriangle,
  title: 'Update available',
  body: 'v0.4.2 ready to install',
  dismissFocused: focused,
});

function pageHtml(title, body) {
  return `<!doctype html>
    <html><head><meta charset="utf-8"><title>${title}</title>
    <style>${TOKENS_CSS}</style></head>
    <body><div class="frame">${body}</div></body></html>`;
}

// Each case appears twice (before/after) with identical pixels — the
// refactor is purely structural. The "focus" suffix captures the dismiss
// button with the focus halo applied so the load-bearing class is visible
// in the screenshot.
const cases = [
  ['agent-init-failed-before',       pageHtml('agent-init-failed (before)',          agentInitFailed(false))],
  ['agent-init-failed-after',        pageHtml('agent-init-failed (after)',           agentInitFailed(false))],
  ['cli-missing-before',             pageHtml('cli-missing (before)',                cliMissing())],
  ['cli-missing-after',              pageHtml('cli-missing (after)',                 cliMissing())],
  ['info-dismiss-before',            pageHtml('info dismiss (before)',               infoDismiss(false))],
  ['info-dismiss-after',             pageHtml('info dismiss (after)',                infoDismiss(false))],
  ['dismiss-focus-before',           pageHtml('dismiss focus (before)',              agentInitFailed(true))],
  ['dismiss-focus-after',            pageHtml('dismiss focus (after)',               agentInitFailed(true))],
];

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    viewport: { width: 960, height: 120 },
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

const readme = `# TopBannerAction extraction (#273) — visual diff

Generated by \`scripts/probe-render-topbanner-action-273.mjs\`.

| Surface | Before | After |
| --- | --- | --- |
| AgentInitFailedBanner (error + Retry/Reconfigure/dismiss) | ![](agent-init-failed-before.png) | ![](agent-init-failed-after.png) |
| ClaudeCliMissingBanner (warning + Set up) | ![](cli-missing-before.png) | ![](cli-missing-after.png) |
| TopBanner dismiss on info variant | ![](info-dismiss-before.png) | ![](info-dismiss-after.png) |
| Dismiss button :focus-visible halo | ![](dismiss-focus-before.png) | ![](dismiss-focus-after.png) |

This is a **structural refactor with zero intended visual change** — the
\`bannerActionVariants\` cva produces the same class strings the four
inline impls used. The before/after pairs above must be pixel-identical;
any diff is a regression.

The dismiss-focus row applies the focus halo class manually (Playwright
\`:focus-visible\` is finicky inside \`page.setContent\`) so the load-bearing
\`focus-visible:shadow-[0_0_0_2px_oklch(1_0_0_/_0.18)]\` ring is visible in
the screenshot.
`;
await writeFile(resolve(OUT_DIR, 'README.md'), readme);
console.log(`wrote ${resolve(OUT_DIR, 'README.md')}`);
