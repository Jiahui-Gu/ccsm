// scripts/probe-render-skill-badge-318.mjs
//
// Visual probe for Task #318 — "via skill: <name>" provenance badge in
// AssistantBlock. Captures BEFORE (no badge — same as `working` HEAD) and
// AFTER (badge present, with tooltip on hover) for two scenarios:
//   1. user-level skill (`using-superpowers`)
//   2. plugin-namespaced skill (`pua:p7`) → tooltip path uses
//      `~/.claude/plugins/<plugin>/skills/<skill>/SKILL.md`
//
// Output: PNGs under `dogfood-logs/skill-badge-318/`. PR body references
// these per `feedback_visual_fix_screenshots.md`.
//
// Why static HTML rather than booting electron: the dependency tree on
// `working` is currently broken (@radix-ui/react-switch missing in our
// shared node_modules), so `npm run build` fails. The badge styling
// depends only on the design tokens reproduced inline below; exact
// classes mirror AssistantBlock.tsx so the visual matches the live UI.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'dogfood-logs', 'skill-badge-318');
await mkdir(OUT_DIR, { recursive: true });

const TOKENS_CSS = `
  :root {
    --color-bg-app: oklch(0.18 0.003 240);
    --color-bg-elevated: oklch(0.22 0.004 240);
    --color-fg-primary: oklch(0.93 0 0);
    --color-fg-secondary: oklch(0.68 0 0);
    --color-border-subtle: oklch(0.28 0 0);
    --color-border-default: oklch(0.34 0 0);
  }
  html, body { margin: 0; padding: 24px; background: var(--color-bg-app); color: var(--color-fg-primary);
    font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased; font-size: 13px; line-height: 22px; }
  .frame { width: 720px; }
  .turn { display: flex; gap: 12px; padding: 8px 0; }
  .glyph { color: var(--color-fg-secondary); width: 12px; flex-shrink: 0; font-family: ui-monospace, Menlo, monospace; font-weight: 600; line-height: 22px; user-select: none; }
  .body { color: var(--color-fg-primary); min-width: 0; line-height: 22px; }
  .badge { display: inline-flex; align-items: center; gap: 4px; margin-bottom: 4px;
    padding: 1px 6px; border-radius: 4px; border: 1px solid var(--color-border-subtle);
    background: var(--color-bg-elevated); color: var(--color-fg-secondary);
    font-size: 11px; line-height: 14px; font-family: ui-monospace, Menlo, monospace;
    user-select: none; cursor: default; vertical-align: middle; }
  .text { white-space: pre-wrap; }
  .tooltip {
    position: absolute; z-index: 50; padding: 4px 8px; border-radius: 6px;
    border: 1px solid var(--color-border-default); background: var(--color-bg-elevated);
    color: var(--color-fg-secondary); font-size: 11px; line-height: 14px;
    box-shadow: inset 0 1px 0 0 oklch(1 0 0 / 0.04), 0 2px 8px oklch(0 0 0 / 0.35);
    pointer-events: none; user-select: none;
  }
`;

function pageHtml({ withBadge, skillName, skillPath, tooltipVisible }) {
  const badgeHtml = withBadge
    ? `<span class="badge" data-testid="assistant-via-skill-badge">via skill: ${skillName}</span>`
    : '';
  const tooltipHtml = tooltipVisible
    ? `<div class="tooltip" style="left: 36px; top: 14px;">${skillPath}</div>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>${TOKENS_CSS}</style></head>
<body><div class="frame">
  ${tooltipHtml}
  <div class="turn">
    <span class="glyph">●</span>
    <div class="body">
      ${badgeHtml}
      <p class="text">Loaded the skill — here is what we are going to do next: read the design notes, draft the plan, then execute step by step.</p>
    </div>
  </div>
</div></body></html>`;
}

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 220 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  const cases = [
    { label: 'before-1-no-badge', html: pageHtml({ withBadge: false }) },
    { label: 'after-1-user-skill', html: pageHtml({ withBadge: true, skillName: 'using-superpowers', skillPath: '~/.claude/skills/using-superpowers/SKILL.md', tooltipVisible: false }) },
    { label: 'after-2-user-skill-tooltip', html: pageHtml({ withBadge: true, skillName: 'using-superpowers', skillPath: '~/.claude/skills/using-superpowers/SKILL.md', tooltipVisible: true }) },
    { label: 'after-3-plugin-skill', html: pageHtml({ withBadge: true, skillName: 'pua:p7', skillPath: '~/.claude/plugins/pua/skills/p7/SKILL.md', tooltipVisible: false }) },
    { label: 'after-4-plugin-skill-tooltip', html: pageHtml({ withBadge: true, skillName: 'pua:p7', skillPath: '~/.claude/plugins/pua/skills/p7/SKILL.md', tooltipVisible: true }) }
  ];

  for (const c of cases) {
    await page.setContent(c.html);
    await page.waitForLoadState('domcontentloaded');
    const out = resolve(OUT_DIR, `${c.label}.png`);
    await page.screenshot({ path: out, fullPage: true });
    console.log('saved', out);
  }
} finally {
  await browser.close();
}
