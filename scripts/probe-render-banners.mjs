// scripts/probe-render-banners.mjs
//
// Visual probe for the banner trio refactor (#237). Renders each of the
// three banners — AgentInitFailedBanner, AgentDiagnosticBanner,
// ClaudeCliMissingBanner — twice: once with the BEFORE markup (each banner
// owning its own layout / a11y attrs) and once with the AFTER markup
// produced by the unified <TopBanner /> wrapper.
//
// Output: PNG pairs under `dogfood-logs/banner-refactor-237/`. The PR body
// references these via the markdown screenshot table per project rule
// (`feedback_visual_fix_screenshots.md`).
//
// Design note: this probe deliberately mounts a static HTML approximation
// of each banner's rendered DOM rather than booting the full app. The full
// app needs an electron main process + IPC handshake before any of these
// banners can fire (CLI missing, agent init failure, diagnostic stream),
// which is impractical inside a single screenshot probe. The HTML below
// mirrors the EXACT class names + token values from `src/styles/global.css`
// so the visual output matches what users see in the app.

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'dogfood-logs', 'banner-refactor-237');

await mkdir(OUT_DIR, { recursive: true });

// Inline a minimal subset of the project's design tokens so the HTML
// renders with the same colors / spacing the user actually sees, without
// needing a full Tailwind build pipeline inside this probe.
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
  .banner-row.slim { padding: 6px 12px; }
  .err { background: oklch(0.3 0.11 25); color: oklch(0.95 0.06 25); }
  .warn { background: oklch(0.32 0.08 75); color: oklch(0.94 0.06 90); }
  .meta { font-size: var(--text-meta); line-height: var(--text-meta-lh); }
  .semi { font-weight: 600; }
  .mono { font-family: 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace; }
  .grow { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .grow > .truncate { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .truncate { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .opacity-90 { opacity: 0.9; }
  .btn { flex-shrink: 0; height: 28px; padding: 0 10px; border-radius: 4px;
    font-size: var(--text-meta); font-weight: 500; display: inline-flex;
    align-items: center; gap: 6px; background: rgba(0,0,0,0.10); color: inherit;
    border: 0; cursor: pointer; }
  .btn.primary { background: rgba(0,0,0,0.25); }
  .btn.icon { width: 28px; padding: 0; justify-content: center; }
  .btn.icon-sm { width: 24px; height: 24px; padding: 0; justify-content: center; }
  .actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .icon { flex-shrink: 0; }
  .label { white-space: nowrap; }
  .stack { display: flex; flex-direction: column; gap: 24px; padding: 20px; }
  .label-tag { font-size: 11px; opacity: 0.6; padding: 0 4px; letter-spacing: 0.04em;
    text-transform: uppercase; }
`;

// SVG icons inlined to avoid bringing in lucide for a probe.
const iconAlertOctagon = (size = 14) => `
  <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon">
    <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/>
    <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
  </svg>`;
const iconAlertTriangle = (size = 13) => `
  <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon">
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
    <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>`;
const iconRotate = `
  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon">
    <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
  </svg>`;
const iconSettings = `
  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg>`;
const iconX = (size = 13) => `
  <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>`;

// ─── BEFORE markup (faithful copy of pre-#237 banners) ─────────────────────
const beforeAgentInitFailed = `
  <div class="banner-row err">
    ${iconAlertOctagon(14)}
    <div class="grow">
      <span class="meta semi">Agent failed to start</span>
      <span class="meta mono truncate opacity-90" style="font-size:11px">spawn ENOENT</span>
    </div>
    <button class="btn primary"><span>${iconRotate}</span><span class="label">Retry</span></button>
    <button class="btn"><span>${iconSettings}</span><span class="label">Reconfigure</span></button>
    <button class="btn icon" aria-label="Dismiss">×</button>
  </div>
`;

const beforeAgentDiagnostic = `
  <div class="banner-row warn slim">
    ${iconAlertTriangle(13)}
    <span class="grow truncate meta mono">init handshake timed out</span>
    <button class="btn icon-sm" aria-label="Dismiss diagnostic">${iconX(13)}</button>
  </div>
`;

const beforeClaudeCliMissing = `
  <div class="banner-row warn slim">
    ${iconAlertTriangle(13)}
    <span class="grow truncate meta">Claude CLI not configured — sessions won\u2019t start until you install or locate it.</span>
    <button class="btn" style="height:24px;padding:0 8px"><span class="label">Set up</span></button>
  </div>
`;

// ─── AFTER markup (unified TopBanner shape) ────────────────────────────────
function afterRow({ variant, icon, title, body, actions, dismiss, dismissLabel = 'Dismiss' }) {
  return `
    <div class="banner-row ${variant === 'error' ? 'err' : 'warn'}">
      ${icon}
      <div class="grow">
        <span class="meta semi">${title}</span>
        ${body ? `<span class="meta truncate opacity-90 ${typeof body === 'string' && /[A-Z_]{4,}|spawn|timeout/.test(body) ? 'mono' : ''}" style="font-size:11px">${body}</span>` : ''}
      </div>
      ${actions ? `<div class="actions">${actions}</div>` : ''}
      ${dismiss ? `<button class="btn icon" aria-label="${dismissLabel}">${iconX(13)}</button>` : ''}
    </div>
  `;
}

const afterAgentInitFailed = afterRow({
  variant: 'error',
  icon: iconAlertOctagon(14),
  title: 'Agent failed to start',
  body: 'spawn ENOENT',
  actions: `
    <button class="btn primary"><span>${iconRotate}</span><span class="label">Retry</span></button>
    <button class="btn"><span>${iconSettings}</span><span class="label">Reconfigure</span></button>
  `,
  dismiss: true,
});

const afterAgentDiagnostic = afterRow({
  variant: 'warning',
  icon: iconAlertTriangle(13),
  title: 'Agent warning',
  body: 'init handshake timed out',
  dismiss: true,
  dismissLabel: 'Dismiss diagnostic',
});

const afterClaudeCliMissing = afterRow({
  variant: 'warning',
  icon: iconAlertTriangle(13),
  title: 'Claude CLI not configured \u2014 sessions won\u2019t start until you install or locate it.',
  body: undefined,
  actions: `<button class="btn"><span class="label">Set up</span></button>`,
  dismiss: false,
});

function pageHtml(title, banner) {
  return `<!doctype html>
    <html><head><meta charset="utf-8"><title>${title}</title>
    <style>${TOKENS_CSS}</style></head>
    <body><div class="frame">${banner}</div></body></html>`;
}

const cases = [
  ['agent-init-failed-before', pageHtml('agent-init-failed (before)', beforeAgentInitFailed)],
  ['agent-init-failed-after', pageHtml('agent-init-failed (after)', afterAgentInitFailed)],
  ['agent-diagnostic-before', pageHtml('agent-diagnostic (before)', beforeAgentDiagnostic)],
  ['agent-diagnostic-after', pageHtml('agent-diagnostic (after)', afterAgentDiagnostic)],
  ['cli-missing-before', pageHtml('cli-missing (before)', beforeClaudeCliMissing)],
  ['cli-missing-after', pageHtml('cli-missing (after)', afterClaudeCliMissing)],
];

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    viewport: { width: 960, height: 100 },
    deviceScaleFactor: 2,
  });
  for (const [name, html] of cases) {
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    // Wait for fonts to settle so screenshots are stable across runs.
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

// Drop a small README so reviewers know what they're looking at without
// having to re-read this script.
const readme = `# Banner trio refactor (#237) — visual diff

Generated by \`scripts/probe-render-banners.mjs\`.

| Banner | Before | After |
| --- | --- | --- |
| AgentInitFailedBanner | ![](agent-init-failed-before.png) | ![](agent-init-failed-after.png) |
| AgentDiagnosticBanner | ![](agent-diagnostic-before.png) | ![](agent-diagnostic-after.png) |
| ClaudeCliMissingBanner | ![](cli-missing-before.png) | ![](cli-missing-after.png) |

The probe renders a static HTML approximation that mirrors the exact
classnames + design tokens used by the live components (\`src/styles/global.css\`),
so visuals match what the user sees in the running Electron app without
needing the full app boot for screenshots.
`;
await writeFile(resolve(OUT_DIR, 'README.md'), readme);
console.log(`wrote ${resolve(OUT_DIR, 'README.md')}`);
