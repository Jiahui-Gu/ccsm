// scripts/probe-render-small-ui-bundle-278.mjs
//
// Visual probe for the small-UI bundle (#278 + #279 + #280).
//
//   #278 — CommandPalette: theme switcher row label uses the resolved theme,
//          not the raw persisted preference. When persisted is `system` and
//          the OS is dark, the BEFORE label says "Switch theme -> dark"
//          (already dark, no-op feel); AFTER says "Switch theme -> light".
//          (Stagger entrance is animation-only, hard to capture as PNG —
//          covered by code review and the prefers-reduced-motion guard.)
//   #279 — NotificationsPane: redundant inner "On"/"Off" labels next to
//          checkboxes are removed. The switch state already conveys it.
//   #280 — SettingsDialog tabs: drop the dual-cue (filled hover background +
//          accent rail) on the active tab. Keep only the accent rail; active
//          tab still distinct via text color + font-medium.
//
// Output: PNG pairs under `dogfood-logs/small-ui-bundle-278/` plus a README
// with the before/after diff table. Pure-CSS surface, no app boot — same
// pattern as scripts/probe-render-import-dialog-243.mjs.
//
// HOME is sandboxed so the headless browser can never read user skill files
// (per feedback_probe_skill_injection.md).

import { chromium } from 'playwright';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const sandboxHome = await mkdtemp(join(tmpdir(), 'probe-small-ui-bundle-278-'));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
process.env.CLAUDE_HOME = sandboxHome;

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'dogfood-logs', 'small-ui-bundle-278');
await mkdir(OUT_DIR, { recursive: true });

// Token snapshot copied from src/styles/global.css (dark @theme), so the
// rendered surface tracks the live app palette.
const TOKENS_CSS = `
  :root {
    --color-bg-app: oklch(0.16 0.003 240);
    --color-bg-panel: oklch(0.18 0.003 240);
    --color-bg-elevated: oklch(0.22 0.003 240);
    --color-bg-hover: oklch(0.295 0.003 240);
    --color-fg-primary: oklch(0.93 0 0);
    --color-fg-secondary: oklch(0.80 0 0);
    --color-fg-tertiary: oklch(0.72 0 0);
    --color-fg-disabled: oklch(0.55 0 0);
    --color-border-subtle: oklch(0.28 0 0);
    --color-border-default: oklch(0.34 0 0);
    --color-accent: oklch(0.74 0.13 215);
    --text-chrome: 12px;
    --text-meta: 11px;
  }
  html, body { margin: 0; padding: 0; background: var(--color-bg-app);
    color: var(--color-fg-primary);
    font-family: ui-sans-serif, -apple-system, system-ui, Segoe UI, Roboto, sans-serif;
    -webkit-font-smoothing: antialiased; }
  .frame { padding: 16px; width: 560px; }
  .label { font-size: var(--text-chrome); }
`;

// ---------- #278 CommandPalette theme row label ---------------------------

function paletteRow({ kind }) {
  // The "Switch theme -> X" row, persisted=system, OS=dark.
  // BEFORE: cycles by persisted value ("system -> dark"). AFTER: derives
  // next from the resolved theme (already dark, so next = light).
  const next = kind === 'before' ? 'dark' : 'light';
  return `
    <div style="background:var(--color-bg-panel); border:1px solid var(--color-border-default);
                border-radius:6px; padding:6px 0; width:520px;">
      <div style="display:flex; align-items:center; gap:10px; height:32px; padding:0 12px; margin:0 4px;
                  border-radius:3px; background:var(--color-bg-hover); color:var(--color-fg-primary);
                  font-size:var(--text-chrome);">
        <span style="display:inline-flex; width:16px; justify-content:center;">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
               style="color:var(--color-fg-tertiary);">
            <path d="M12 2v2"/><path d="M12 20v2"/><path d="M4.93 4.93l1.41 1.41"/>
            <path d="M17.66 17.66l1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/>
            <path d="M4.93 19.07l1.41-1.41"/><path d="M17.66 6.34l1.41-1.41"/>
            <circle cx="12" cy="12" r="4"/>
          </svg>
        </span>
        <span style="flex:1;">Switch theme &rarr; ${next}</span>
      </div>
      <div style="padding:6px 14px 2px; font-size:var(--text-meta); color:var(--color-fg-tertiary);">
        Persisted preference: <code style="color:var(--color-fg-secondary);">system</code> &middot;
        OS prefers: <code style="color:var(--color-fg-secondary);">dark</code> &middot;
        Currently rendered: <code style="color:var(--color-fg-secondary);">dark</code>
      </div>
    </div>`;
}

// ---------- #279 NotificationsPane toggle row -----------------------------

function notifyRow({ kind }) {
  // BEFORE: trailing "On"/"Off" text label sits next to the checkbox.
  // AFTER: just the checkbox; Field title (top) labels the row.
  const trailing =
    kind === 'before'
      ? `<span style="font-size:var(--text-chrome); color:var(--color-fg-secondary); margin-left:8px;">On</span>`
      : '';
  return `
    <div style="margin-bottom:18px;">
      <div style="font-size:var(--text-chrome); font-weight:500; color:var(--color-fg-primary); margin-bottom:4px;">
        Notify on permission request
      </div>
      <div style="font-size:var(--text-meta); color:var(--color-fg-tertiary); margin-bottom:6px;">
        Surface a system notification when the agent asks for tool permission.
      </div>
      <label style="display:inline-flex; align-items:center; cursor:pointer;">
        <input type="checkbox" checked
               style="width:16px; height:16px; accent-color:var(--color-accent);" />
        ${trailing}
      </label>
    </div>
    <div style="margin-bottom:18px;">
      <div style="font-size:var(--text-chrome); font-weight:500; color:var(--color-fg-primary); margin-bottom:4px;">
        Notify when turn completes
      </div>
      <div style="font-size:var(--text-meta); color:var(--color-fg-tertiary); margin-bottom:6px;">
        Surface a notification when the agent finishes a turn.
      </div>
      <label style="display:inline-flex; align-items:center; cursor:pointer;">
        <input type="checkbox"
               style="width:16px; height:16px; accent-color:var(--color-accent);" />
        ${kind === 'before'
          ? `<span style="font-size:var(--text-chrome); color:var(--color-fg-secondary); margin-left:8px;">Off</span>`
          : ''}
      </label>
    </div>`;
}

// ---------- #280 Settings tabs --------------------------------------------

function tabsList({ kind }) {
  // Vertical tablist. Active = Notifications.
  // BEFORE: active gets `bg-bg-hover` filled background AND the accent rail.
  // AFTER: only the accent rail; text weight + color carries selection.
  const tabs = ['Appearance', 'Notifications', 'Connection', 'Updates'];
  return `
    <nav style="width:160px; border-right:1px solid var(--color-border-subtle);
                padding:8px 0; background:var(--color-bg-panel);">
      ${tabs
        .map((label) => {
          const isActive = label === 'Notifications';
          const bg = isActive && kind === 'before' ? 'background:var(--color-bg-hover);' : '';
          const color = isActive
            ? 'color:var(--color-fg-primary); font-weight:500;'
            : 'color:var(--color-fg-secondary);';
          const rail = isActive
            ? `<span style="position:absolute; left:0; top:4px; bottom:4px; width:3px;
                            background:var(--color-accent); border-top-right-radius:2px;
                            border-bottom-right-radius:2px;"></span>`
            : '';
          return `
            <button style="position:relative; display:flex; width:calc(100% - 8px); align-items:center;
                           height:28px; padding:0 12px; margin:0 4px; border:0; border-radius:3px;
                           font-size:var(--text-chrome); text-align:left; ${bg} ${color}
                           cursor:pointer; font-family:inherit;">
              ${rail}
              ${label}
            </button>`;
        })
        .join('')}
    </nav>`;
}

function tabsPanel() {
  return `
    <section style="flex:1; padding:20px; background:var(--color-bg-panel);">
      <div style="font-size:var(--text-chrome); color:var(--color-fg-tertiary);">
        Settings &rsaquo; Notifications panel content&hellip;
      </div>
    </section>`;
}

function tabsHtml({ kind }) {
  return `
    <div style="display:flex; min-height:220px; width:540px;
                border:1px solid var(--color-border-subtle); border-radius:6px; overflow:hidden;">
      ${tabsList({ kind })}
      ${tabsPanel()}
    </div>`;
}

// ---------- page wrapper + cases ------------------------------------------

function pageHtml(title, body) {
  return `<!doctype html>
    <html><head><meta charset="utf-8"><title>${title}</title>
    <style>${TOKENS_CSS}</style></head>
    <body><div class="frame">${body}</div></body></html>`;
}

const cases = [
  ['palette-theme-row-before', pageHtml('palette theme row (before)', paletteRow({ kind: 'before' }))],
  ['palette-theme-row-after', pageHtml('palette theme row (after)', paletteRow({ kind: 'after' }))],
  ['notify-toggles-before', pageHtml('notify toggles (before)', notifyRow({ kind: 'before' }))],
  ['notify-toggles-after', pageHtml('notify toggles (after)', notifyRow({ kind: 'after' }))],
  ['settings-tabs-before', pageHtml('settings tabs (before)', tabsHtml({ kind: 'before' }))],
  ['settings-tabs-after', pageHtml('settings tabs (after)', tabsHtml({ kind: 'after' }))],
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

const readme = `# Small UI bundle (#278 #279 #280) — visual diff

Generated by \`scripts/probe-render-small-ui-bundle-278.mjs\`.

| Surface | Before | After |
| --- | --- | --- |
| #278 CommandPalette theme row label (persisted=system, OS=dark) | ![](palette-theme-row-before.png) | ![](palette-theme-row-after.png) |
| #279 NotificationsPane toggle rows (no inner On/Off label) | ![](notify-toggles-before.png) | ![](notify-toggles-after.png) |
| #280 Settings tab indicator (single accent-rail cue) | ![](settings-tabs-before.png) | ![](settings-tabs-after.png) |

**#278.** Persisted preference cycles through \`dark -> light -> system -> dark\`,
so when the user is on \`system\` and the OS is dark, the BEFORE label reads
"Switch theme -> dark" — confusing because it is already dark. AFTER derives
the next theme from the resolved theme (\`resolveEffectiveTheme\`), so the
label always reflects the actually rendered theme. The row stagger entrance
(\`staggerChildren: 0.015\`) is animation-only and respects
\`prefers-reduced-motion\` via \`useReducedMotion\` from framer-motion; not
captured as a static PNG.

**#279.** The trailing "On" / "Off" word duplicates information the checkbox
state already carries. Removed from \`NotificationsPane.Toggle\`; checkbox
keeps an \`aria-label\` from the field title for screen readers.

**#280.** Active tab no longer combines a filled \`bg-bg-hover\` background
with the accent rail. The rail (and \`text-fg-primary\` + \`font-medium\`) is
sufficient. Quieter pane, single-cue selection.
`;
await writeFile(resolve(OUT_DIR, 'README.md'), readme);
console.log(`wrote ${resolve(OUT_DIR, 'README.md')}`);
