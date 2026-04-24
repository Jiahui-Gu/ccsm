// scripts/probe-render-diff-per-file-collapse-302.mjs
//
// Visual probe for DiffView per-file collapse (#302). Captures BEFORE/AFTER
// PNG pairs of a 5-file diff scenario:
//   - BEFORE: pre-#302 layout (each file is a flat block with a header bar
//     and ALL hunks expanded — unscannable; user has to scroll past every
//     line of every file to find anything).
//   - AFTER:  post-#302 layout (one wrapper, 5 collapsed file chips with
//     chevron + path + +N/-M counts; user clicks the file they care about).
//
// Output: PNG pairs under `dogfood-logs/diff-per-file-collapse-302/`. PR
// body references these via the markdown screenshot table per project rule
// (`feedback_visual_fix_screenshots.md`).
//
// Design note: this probe mounts a static HTML approximation of the rendered
// DOM rather than booting the full electron app. Full-app DiffView lives
// inside a tool block which only fires from a real CLI tool call; mocking
// that path inside a screenshot probe is impractical. The HTML below mirrors
// the class names + token colors from `src/styles/global.css` so the visual
// matches what users see.

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'dogfood-logs', 'diff-per-file-collapse-302');
await mkdir(OUT_DIR, { recursive: true });

const TOKENS_CSS = `
  :root {
    --color-bg-app: oklch(0.18 0.003 240);
    --color-bg-elevated: oklch(0.22 0.003 240);
    --color-bg-panel: oklch(0.20 0.003 240);
    --color-fg-primary: oklch(0.96 0 0);
    --color-fg-secondary: oklch(0.84 0 0);
    --color-fg-tertiary: oklch(0.62 0 0);
    --color-border-subtle: oklch(0.28 0 0);
    --color-state-running: oklch(0.78 0.16 145);
    --color-state-error: oklch(0.66 0.20 25);
    --color-state-error-fg: oklch(0.85 0.10 25);
  }
  html, body { margin: 0; padding: 0; background: var(--color-bg-app);
    color: var(--color-fg-secondary);
    font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased; }
  .frame { width: 880px; padding: 24px; }
  .label { font: 600 12px/16px 'Inter', sans-serif; color: var(--color-fg-tertiary);
    text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px; }

  .diff-wrapper { margin-top: 4px; margin-left: 24px; border: 1px solid var(--color-border-subtle);
    border-radius: 2px; overflow: hidden; background: var(--color-bg-panel); }

  /* BEFORE: pre-#302 file header — flat, no chevron, no counts */
  .file-head-old { padding: 4px 12px; background: oklch(from var(--color-bg-elevated) l c h / 0.6);
    border-bottom: 1px solid var(--color-border-subtle); color: var(--color-fg-tertiary);
    font: 13px/18px ui-monospace, 'JetBrains Mono', monospace; }

  /* AFTER: post-#302 file chip header — chevron + path + counts, full button */
  .file-head { display: flex; align-items: center; gap: 8px; padding: 4px 12px;
    background: oklch(from var(--color-bg-elevated) l c h / 0.6);
    color: var(--color-fg-tertiary); cursor: pointer; width: 100%;
    border: 0; text-align: left; }
  .file-head + .file-head { border-top: 1px solid var(--color-border-subtle); }
  .chevron { width: 12px; display: inline-flex; }
  .chevron svg { transition: transform 0.2s ease; }
  .chevron.open svg { transform: rotate(90deg); }
  .file-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; font: 13px/18px ui-monospace, 'JetBrains Mono', monospace; }
  .counts { font: 11px/14px ui-monospace, 'JetBrains Mono', monospace; font-variant-numeric: tabular-nums; }
  .added { color: var(--color-state-running); }
  .removed { color: var(--color-state-error); }
  .sep { color: var(--color-fg-tertiary); }

  .hunks { font: 11px/16px ui-monospace, 'JetBrains Mono', monospace; }
  .row { display: grid; grid-template-columns: 12px 1fr; }
  .row.added { background: oklch(0.55 0.18 145 / 0.08); color: var(--color-fg-secondary); }
  .row.removed { background: oklch(0.55 0.18 27 / 0.10); color: var(--color-state-error-fg); }
  .gutter { padding-left: 4px; user-select: none; }
  .gutter.add { color: var(--color-state-running); }
  .gutter.rem { color: var(--color-state-error); }
  .line { padding-right: 8px; }
  .actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px;
    padding: 4px 8px; background: oklch(from var(--color-bg-elevated) l c h / 0.5);
    border-top: 1px solid var(--color-border-subtle); }
  .btn { padding: 1px 8px; border: 1px solid var(--color-border-subtle); border-radius: 2px;
    background: transparent; color: var(--color-fg-tertiary);
    font: 11px/14px ui-monospace, 'JetBrains Mono', monospace; }
  .file-section + .file-section { border-top: 1px solid var(--color-border-subtle); }
`;

const FILES = [
  { path: '/src/components/chat/DiffView.tsx',
    removed: ["import { useState } from 'react';", "  const lang = languageFromPath(diff.filePath);"],
    added:   ["import { useState, useMemo } from 'react';", "  const lang = languageFromPath(spec.filePath);", "  const counts = useMemo(() => countChanges(spec), [spec]);"] },
  { path: '/src/i18n/locales/en.ts',
    removed: ["    diffRejected: 'rejected',"],
    added:   ["    diffRejected: 'rejected',", "    diffFileToggleAria: 'Toggle file: {{path}}',", "    diffCountsAria: '{{added}} added, {{removed}} removed',"] },
  { path: '/src/i18n/locales/zh.ts',
    removed: ["    diffRejected: '已拒绝',"],
    added:   ["    diffRejected: '已拒绝',", "    diffFileToggleAria: '展开/收起文件: {{path}}',"] },
  { path: '/src/utils/diff.ts',
    removed: ["// Tiny line-level diff renderer for Edit/Write/MultiEdit tool calls."],
    added:   ["// Tiny line-level diff renderer for Edit/Write/MultiEdit tool calls.", "// Now consumed by DiffView in either single-spec or array form (#302)."] },
  { path: '/tests/diff-view-per-file-collapse.test.tsx',
    removed: [],
    added:   ["import { render, screen, fireEvent, within } from '@testing-library/react';", "import { DiffView } from '../src/components/chat/DiffView';", "// 4 RTL cases: 5-file collapsed default, 2-file expanded, single-file legacy, +N/-M chip"] },
];

function chevronSVG() {
  // Lucide ChevronRight, 11px, stroke 1.75
  return `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
}

function renderFileSectionAfter(file, expanded) {
  const added = file.added.length;
  const removed = file.removed.length;
  const head = `
    <button class="file-head" aria-expanded="${expanded}" aria-label="Toggle file: ${file.path}">
      <span class="chevron ${expanded ? 'open' : ''}">${chevronSVG()}</span>
      <span class="file-path" title="${file.path}">${file.path}</span>
      <span class="counts"><span class="added">+${added}</span><span class="sep"> / </span><span class="removed">-${removed}</span></span>
    </button>`;
  if (!expanded) return `<div class="file-section">${head}</div>`;
  const body = `
    <div class="hunks">
      ${file.removed.map((l) => `<div class="row removed"><span class="gutter rem">-</span><span class="line">${escapeHtml(l)}</span></div>`).join('')}
      ${file.added.map((l) => `<div class="row added"><span class="gutter add">+</span><span class="line">${escapeHtml(l)}</span></div>`).join('')}
      <div class="actions"><button class="btn">Reject</button><button class="btn">Accept</button></div>
    </div>`;
  return `<div class="file-section">${head}${body}</div>`;
}

function renderBefore(files) {
  // Pre-#302: each file is its own DiffView wrapper, header is a flat label,
  // body is always rendered. No way to collapse without scrolling.
  return files.map((file) => `
    <div class="diff-wrapper">
      <div class="file-head-old">${file.path}</div>
      <div class="hunks">
        ${file.removed.map((l) => `<div class="row removed"><span class="gutter rem">-</span><span class="line">${escapeHtml(l)}</span></div>`).join('')}
        ${file.added.map((l) => `<div class="row added"><span class="gutter add">+</span><span class="line">${escapeHtml(l)}</span></div>`).join('')}
        <div class="actions"><button class="btn">Reject</button><button class="btn">Accept</button></div>
      </div>
    </div>`).join('');
}

function renderAfter(files, { allCollapsed }) {
  // Post-#302: single wrapper, N file sections, all collapsed by default
  // when files.length > 3.
  return `<div class="diff-wrapper">${files.map((f) => renderFileSectionAfter(f, !allCollapsed)).join('')}</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function page(label, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${TOKENS_CSS}</style></head>
    <body><div class="frame"><div class="label">${label}</div>${body}</div></body></html>`;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 928, height: 800 } });

async function shoot(name, html) {
  const p = await ctx.newPage();
  await p.setContent(html, { waitUntil: 'load' });
  // Auto-fit viewport to body height for tall captures.
  const h = await p.evaluate(() => document.body.scrollHeight);
  await p.setViewportSize({ width: 928, height: Math.max(400, h + 20) });
  const out = resolve(OUT_DIR, name);
  await p.screenshot({ path: out, fullPage: true });
  await p.close();
  console.log(`[wrote] ${out}`);
}

await shoot('before-5-file-diff-all-expanded.png',
  page('BEFORE — pre-#302 (5-file diff, every line forced visible)', renderBefore(FILES)));

await shoot('after-5-file-diff-collapsed.png',
  page('AFTER — #302 (5-file diff, all collapsed; click chevron to reveal)',
    renderAfter(FILES, { allCollapsed: true })));

await shoot('after-5-file-diff-one-expanded.png',
  page('AFTER — #302 (5-file diff, first file expanded after click)',
    `<div class="diff-wrapper">${
      [renderFileSectionAfter(FILES[0], true), ...FILES.slice(1).map((f) => renderFileSectionAfter(f, false))].join('')
    }</div>`));

await browser.close();
console.log(`[probe-render-diff-per-file-collapse-302] done -> ${OUT_DIR}`);
