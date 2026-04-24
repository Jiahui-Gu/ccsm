// scripts/probe-render-text-display-256.mjs
//
// Visual probe for #256 (audit AB2) — adds a 5th `text-display` tier to the
// semantic type scale and applies it to:
//
//   1. AssistantBlock markdown h1 — was riding `text-lg` (17px), barely 1px
//      above `text-heading` (16px), so the 4-step ladder collapsed inside
//      assistant prose.
//   2. Tutorial step heading — was `text-2xl` (24px), one-off Tailwind
//      escape from the semantic scale; now joins the ladder at 21px.
//
// Output: PNG pairs under `dogfood-logs/text-display-256/`. The PR body
// references these via the markdown screenshot table per project rule
// (`feedback_visual_fix_screenshots.md`).
//
// Pattern mirrors `scripts/probe-render-tokens-u3.mjs`: static HTML that
// reuses the EXACT token values from `src/styles/global.css`. No agent
// boot required — these are pure CSS / class-rename changes and a static
// probe gives stable pixel screenshots.
//
// HOME is sanitized so the headless browser process never inherits user
// skill files (per `feedback_probe_skill_injection.md`). Default (dark)
// theme only — light mode is a separate caveat (#218).

import { chromium } from 'playwright';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const sandboxHome = await mkdtemp(join(tmpdir(), 'probe-text-display-'));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
process.env.CLAUDE_HOME = sandboxHome;

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'dogfood-logs', 'text-display-256');
await mkdir(OUT_DIR, { recursive: true });

// Inline the subset of dark-mode tokens this probe exercises. Values copied
// verbatim from `src/styles/global.css` so pixels match the live app.
const TOKENS_CSS = `
  :root {
    --color-bg-app: oklch(0.16 0.003 240);
    --color-bg-panel: oklch(0.18 0.003 240);
    --color-bg-elevated: oklch(0.26 0.003 240);
    --color-fg-primary: oklch(0.93 0 0);
    --color-fg-secondary: oklch(0.80 0 0);
    --color-fg-tertiary: oklch(0.72 0 0);
    --color-border-subtle: oklch(0.28 0 0);
    --color-accent: oklch(0.74 0.13 215);

    --text-meta: 11px;
    --text-meta-lh: 14px;
    --text-chrome: 13px;
    --text-chrome-lh: 18px;
    --text-body: 15px;
    --text-body-lh: 24px;
    --text-heading: 16px;
    --text-heading-lh: 22px;
    /* NEW in #256 — display tier (markdown h1 / Tutorial step heading) */
    --text-display: 21px;
    --text-display-lh: 28px;
    /* Legacy tailwind size used by the BEFORE column for AssistantBlock h1 */
    --text-lg: 17px;
    --text-lg-lh: 24px;
    /* Legacy tailwind size used by the BEFORE column for Tutorial heading */
    --text-2xl: 24px;
  }
  html, body {
    margin: 0; padding: 0;
    background: var(--color-bg-app);
    color: var(--color-fg-primary);
    font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .frame { padding: 24px; width: 720px; }
  .case-tag {
    font-size: var(--text-meta); line-height: var(--text-meta-lh);
    text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--color-fg-tertiary); margin-bottom: 8px;
  }

  /* ── AssistantBlock prose mock ──
     Mirrors the prose markup from src/components/chat/blocks/AssistantBlock.tsx:
       p     -> text-body / leading-[24px]
       h1    -> BEFORE: text-lg ; AFTER: text-display
       h2/h3 -> text-heading
  */
  .assistant {
    background: var(--color-bg-panel);
    border: 1px solid var(--color-border-subtle);
    border-radius: 8px;
    padding: 16px 18px;
    color: var(--color-fg-primary);
    font-size: var(--text-body);
    line-height: var(--text-body-lh);
  }
  .assistant p { margin: 8px 0; font-size: var(--text-body); line-height: var(--text-body-lh); }
  .assistant h1.before { font-size: var(--text-lg); line-height: var(--text-lg-lh); font-weight: 600; margin: 12px 0 8px; }
  .assistant h1.after  { font-size: var(--text-display); line-height: var(--text-display-lh); font-weight: 600; margin: 12px 0 8px; }
  .assistant h2 { font-size: var(--text-heading); line-height: var(--text-heading-lh); font-weight: 600; margin: 12px 0 6px; }
  .assistant h3 { font-size: var(--text-heading); line-height: var(--text-heading-lh); font-weight: 600; margin: 8px 0 4px; }

  /* ── Tutorial step mock ──
     Mirrors src/components/Tutorial.tsx step layout (counter chip + h1 + body).
  */
  .tutorial {
    background: var(--color-bg-panel);
    border: 1px solid var(--color-border-subtle);
    border-radius: 12px;
    padding: 28px 32px;
    width: 520px;
  }
  .tutorial .counter {
    font-size: var(--text-meta); line-height: var(--text-meta-lh);
    color: var(--color-fg-tertiary);
    text-transform: uppercase; letter-spacing: 0.08em;
    margin-bottom: 8px;
  }
  .tutorial h1.before { font-size: var(--text-2xl); line-height: 1.15; font-weight: 600; color: var(--color-fg-primary); margin: 0; }
  .tutorial h1.after  { font-size: var(--text-display); line-height: 1.15; font-weight: 600; color: var(--color-fg-primary); margin: 0; }
  .tutorial p {
    margin: 12px 0 0;
    font-size: var(--text-body); line-height: 1.6;
    color: var(--color-fg-secondary);
  }
`;

function assistantHtml({ headingClass }) {
  return `
    <div class="case-tag">AssistantBlock prose — h1 / h2 / h3 / body ladder</div>
    <div class="assistant">
      <h1 class="${headingClass}">Section heading (h1)</h1>
      <p>Assistant body copy at <code>text-body</code> (15px / 24px). The ladder
      should step clearly from this surface up through h3 / h2 / h1 — that is
      what gives long answers visual scannability.</p>
      <h2>Subsection (h2)</h2>
      <p>More body copy. Notice how the gap between body and h2 narrows when
      h1 is only one px above h2 — the eye reads the whole tree as flat.</p>
      <h3>Sub-subsection (h3)</h3>
      <p>Trailing paragraph at body size to show the bottom of the scale.</p>
    </div>
  `;
}

function tutorialHtml({ headingClass }) {
  return `
    <div class="case-tag">Tutorial step heading</div>
    <div class="tutorial">
      <div class="counter">Step 2 of 4</div>
      <h1 class="${headingClass}">Group your sessions by task, not repo</h1>
      <p>Drag any session into a group. A group is a workday context (a bug,
      a feature, a meeting prep) — not a repository. One group can span many
      repos; one repo can appear in many groups.</p>
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
  ['assistant-h1-before', pageHtml('assistant h1 (before)',
    assistantHtml({ headingClass: 'before' }))],
  ['assistant-h1-after',  pageHtml('assistant h1 (after)',
    assistantHtml({ headingClass: 'after' }))],
  ['tutorial-heading-before', pageHtml('tutorial heading (before)',
    tutorialHtml({ headingClass: 'before' }))],
  ['tutorial-heading-after',  pageHtml('tutorial heading (after)',
    tutorialHtml({ headingClass: 'after' }))],
];

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    viewport: { width: 760, height: 480 },
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

const readme = `# text-display tier (#256, audit AB2) — visual diff

Generated by \`scripts/probe-render-text-display-256.mjs\`.

Adds a 5th \`text-display\` tier (21px / 28px line-height) above the
existing 4-step semantic ladder (\`text-meta\` 11 / \`text-chrome\` 13 /
\`text-body\` 15 / \`text-heading\` 16). Applied to AssistantBlock markdown
h1 (was \`text-lg\` 17px) and Tutorial step heading (was \`text-2xl\` 24px).

| Surface | Before | After |
| --- | --- | --- |
| AssistantBlock prose h1 (text-lg 17px -> text-display 21px) | ![](assistant-h1-before.png) | ![](assistant-h1-after.png) |
| Tutorial step heading (text-2xl 24px -> text-display 21px) | ![](tutorial-heading-before.png) | ![](tutorial-heading-after.png) |

**Why 21px / 28px line-height?** \`text-heading\` is 16/22 — a 17px h1
(BEFORE) is only +1px, so the eye reads h1 and h2 as the same tier. 21px
is a clean major-third up from 16, lands on the 4px grid, and stays
inside Inter's hinting comfort zone — it draws the eye without shouting
the way 24-26px does inside compact chat panels. Tutorial drops 3px from
its previous 24px but joins the semantic scale instead of a one-off
Tailwind escape.

Default (dark) theme only — per #218 caveat, light-mode visuals can be
verified separately if the token-driven values render unexpectedly there.
`;
await writeFile(resolve(OUT_DIR, 'README.md'), readme);
console.log(`wrote ${resolve(OUT_DIR, 'README.md')}`);
