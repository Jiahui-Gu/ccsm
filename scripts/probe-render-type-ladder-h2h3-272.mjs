// scripts/probe-render-type-ladder-h2h3-272.mjs
//
// Visual probe for #272 (Wave 2 P0 W2-08) — h2 and h3 in AssistantBlock prose
// both render at `text-heading 16px font-semibold`, differing only by 0.5px
// of bottom margin. After #256 added a 5th `text-display` tier on top, the
// h2/h3 collision became the tightest joint in the ladder.
//
// Decision (recorded in PR body):
//   * h2 stays text-heading 16px font-semibold (the second-tier body context).
//   * h3 drops weight to font-medium (500). Lighter weight differentiates
//     without shrinking the type away from h4 territory.
//   * Fallback (if weight-only is too subtle on screen): h3 = text-body 15px
//     font-semibold.
//
// This probe renders three columns:
//   BEFORE       — h2 + h3 both 16px / 600 (current main).
//   AFTER (A)    — h2 600, h3 500. Weight-only differentiation.   <- chosen
//   AFTER (B)    — h2 16/600, h3 15/600. Size differentiation (fallback).
//
// HOME is sanitized (per `feedback_probe_skill_injection.md`). Default
// (dark) theme only — light mode is a separate caveat (#218).
//
// Pattern mirrors `scripts/probe-render-text-display-256.mjs`.

import { chromium } from 'playwright';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const sandboxHome = await mkdtemp(join(tmpdir(), 'probe-h2h3-272-'));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
process.env.CLAUDE_HOME = sandboxHome;

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'dogfood-logs', 'type-ladder-h2h3-272');
await mkdir(OUT_DIR, { recursive: true });

// Token values copied verbatim from `src/styles/global.css` so pixels match
// the live app. Only the subset this probe exercises.
const TOKENS_CSS = `
  :root {
    --color-bg-app: oklch(0.16 0.003 240);
    --color-bg-panel: oklch(0.18 0.003 240);
    --color-bg-elevated: oklch(0.26 0.003 240);
    --color-fg-primary: oklch(0.93 0 0);
    --color-fg-secondary: oklch(0.80 0 0);
    --color-fg-tertiary: oklch(0.72 0 0);
    --color-border-subtle: oklch(0.28 0 0);

    --text-meta: 11px;
    --text-meta-lh: 14px;
    --text-body: 15px;
    --text-body-lh: 24px;
    --text-heading: 16px;
    --text-heading-lh: 22px;
    --text-display: 21px;
    --text-display-lh: 28px;
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

  /* AssistantBlock prose mock — mirrors src/components/chat/blocks/AssistantBlock.tsx */
  .assistant {
    background: var(--color-bg-panel);
    border: 1px solid var(--color-border-subtle);
    border-radius: 8px;
    padding: 16px 18px;
    color: var(--color-fg-primary);
    font-size: var(--text-body);
    line-height: var(--text-body-lh);
  }
  .assistant p {
    margin: 0 0 8px;
    font-size: var(--text-body); line-height: var(--text-body-lh);
  }
  .assistant p:last-child { margin-bottom: 0; }
  .assistant h1 {
    font-size: var(--text-display); line-height: var(--text-display-lh);
    font-weight: 600; margin: 12px 0 8px;
  }
  .assistant h2 {
    font-size: var(--text-heading); line-height: var(--text-heading-lh);
    font-weight: 600; margin: 12px 0 6px;
  }

  /* h3 variants */
  .assistant h3.before {
    font-size: var(--text-heading); line-height: var(--text-heading-lh);
    font-weight: 600; margin: 8px 0 4px;
  }
  .assistant h3.after-weight {
    font-size: var(--text-heading); line-height: var(--text-heading-lh);
    font-weight: 500; margin: 8px 0 4px;
  }
  .assistant h3.after-size {
    font-size: var(--text-body); line-height: var(--text-body-lh);
    font-weight: 600; margin: 8px 0 4px;
  }
`;

function assistantHtml({ h3Class, label }) {
  return `
    <div class="case-tag">AssistantBlock prose — ${label}</div>
    <div class="assistant">
      <h1>Section heading (h1, text-display 21/600)</h1>
      <p>Body copy at <code>text-body</code> (15/24). The full ladder should
      step clearly: body &lt; h3 &lt; h2 &lt; h1.</p>
      <h2>Subsection heading (h2, text-heading 16/600)</h2>
      <p>More body copy. Ideally the eye groups what's under each h2 as a
      coherent block, with h3 reading as a softer rung beneath.</p>
      <h3 class="${h3Class}">Sub-subsection heading (h3)</h3>
      <p>Trailing body paragraph to anchor the bottom of the scale.</p>
      <h3 class="${h3Class}">Another h3 right after</h3>
      <p>Two h3s back-to-back is the worst case for h2/h3 collision: a reader
      should still feel the demotion from h2.</p>
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
  ['h3-before',          pageHtml('h3 before',        assistantHtml({ h3Class: 'before',        label: 'BEFORE — h3 = 16px / 600 (collides with h2)' }))],
  ['h3-after-weight',    pageHtml('h3 after weight',  assistantHtml({ h3Class: 'after-weight',  label: 'AFTER (chosen) — h3 = 16px / 500 (weight differentiation)' }))],
  ['h3-after-size',      pageHtml('h3 after size',    assistantHtml({ h3Class: 'after-size',    label: 'AFTER (fallback) — h3 = 15px / 600 (size differentiation)' }))],
];

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    viewport: { width: 760, height: 600 },
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

const readme = `# h2 / h3 type-ladder differentiation (#272, Wave 2 P0 W2-08) — visual diff

Generated by \`scripts/probe-render-type-ladder-h2h3-272.mjs\`.

After #256 added \`text-display\` (21px) for prose h1, h2 and h3 still both
render at \`text-heading\` 16px \`font-semibold\`, differing only by a half
pixel of bottom margin. They visually collide inside chat prose.

| Variant | Screenshot | h2 | h3 |
| --- | --- | --- | --- |
| BEFORE (current main) | ![](h3-before.png) | 16px / 600 | 16px / 600 |
| AFTER — chosen (weight) | ![](h3-after-weight.png) | 16px / 600 | 16px / **500** |
| AFTER — fallback (size) | ![](h3-after-size.png) | 16px / 600 | **15px** / 600 |

**Decision: weight differentiation (h3 = font-medium 500).**

Reasoning: shrinking h3 to text-body (15px) makes it almost indistinguishable
from a bold body paragraph; introducing a new "subhead" tier (e.g. 15.5px)
just to wedge h3 in adds a 6th step the rest of the system doesn't need.
Dropping h3 from semibold (600) to medium (500) keeps h3 at heading size but
reads visibly lighter than h2, which is exactly what the rung should
communicate ("still a heading, but a level down").

If the weight-only signal turns out too subtle once the change lands in the
running app (Inter at 16px is forgiving on weight), the fallback is to flip
h3 to \`text-body\` (15px) \`font-semibold\` — same component, one-line
change.

Default (dark) theme only — per #218 caveat, light-mode visuals can be
verified separately if token-driven values render unexpectedly there.
`;
await writeFile(resolve(OUT_DIR, 'README.md'), readme);
console.log(`wrote ${resolve(OUT_DIR, 'README.md')}`);
