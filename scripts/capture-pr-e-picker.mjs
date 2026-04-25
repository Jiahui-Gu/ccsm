// Static HTML mockup → before/after screenshots for the PR-E command palette.
//
// Mirrors the production SlashCommandPicker layout/classes so reviewers can
// visually compare:
//   - BEFORE: 4-section listbox (built-in / user / project / plugin),
//     plain substring filter, no Skills/Agents.
//   - AFTER:  6-section listbox (+ Skills, + Agents), Fuse.js fuzzy
//     filter ("/thnk" → "/think").
//
// We render static markup rather than booting the real renderer because the
// app's preload bridge requires a dozen-odd nested IPC stubs that are
// orthogonal to what the screenshot is meant to communicate. The production
// component is exercised separately by the unit tests in
// tests/slash-commands-registry.test.ts and tests/slash-command-picker.test.tsx.
//
// Run: node scripts/capture-pr-e-picker.mjs
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'dogfood-logs', 'pr-e');
fs.mkdirSync(outDir, { recursive: true });

const COMMON_HEAD = `<style>
  :root {
    --bg-app: oklch(0.16 0.005 240);
    --bg-panel: oklch(0.20 0.005 240);
    --bg-elev: oklch(0.22 0.005 240);
    --bg-hover: oklch(0.27 0.005 240);
    --border-default: oklch(0.32 0.005 240);
    --border-subtle: oklch(0.26 0.005 240);
    --fg-primary: oklch(0.94 0 0);
    --fg-secondary: oklch(0.78 0 0);
    --fg-tertiary: oklch(0.58 0 0);
    --fg-disabled: oklch(0.46 0 0);
    --accent: oklch(0.74 0.13 250);
  }
  html, body { margin:0; padding:0; background:var(--bg-app); color:var(--fg-primary);
    font-family: 'Inter', -apple-system, system-ui, sans-serif; font-size: 13px; }
  .frame { padding: 32px; }
  .composer-wrap { position: relative; width: 760px; }
  .picker {
    background: var(--bg-elev);
    border: 1px solid var(--border-default);
    border-radius: 8px;
    box-shadow: 0 12px 36px oklch(0 0 0 / 0.4), inset 0 1px 0 0 oklch(1 0 0 / 0.04);
    overflow: hidden;
  }
  .listbox { max-height: 360px; overflow-y: auto; padding: 4px 0; }
  .group-label {
    display: block;
    padding: 6px 12px 4px;
    color: var(--fg-tertiary);
    font: 11px/1 'JetBrains Mono', ui-monospace, Consolas, monospace;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .row {
    display: flex; align-items: center; gap: 10px;
    height: 32px; padding: 0 12px;
    border-left: 2px solid transparent;
    color: var(--fg-secondary);
    font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace;
    font-size: 13px;
  }
  .row.active {
    background: var(--bg-hover);
    color: var(--fg-primary);
    border-left-color: var(--accent);
    box-shadow: inset 0 1px 0 0 oklch(1 0 0 / 0.05);
  }
  .row .icon { width: 14px; height: 14px; color: var(--fg-tertiary); flex-shrink: 0; }
  .row.active .icon { color: var(--accent); }
  .row .name { color: var(--fg-primary); flex-shrink: 0; }
  .row .desc { color: var(--fg-tertiary); flex: 1 1 auto; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .arg-hint {
    margin-left: auto; flex-shrink: 0;
    padding: 1px 6px;
    border: 1px solid var(--border-subtle);
    border-radius: 3px;
    font: 10px/1 'JetBrains Mono', ui-monospace, monospace;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--fg-tertiary);
  }
  .footer {
    display: flex; align-items: center; gap: 16px;
    padding: 6px 12px;
    border-top: 1px solid var(--border-subtle);
    background: oklch(0.18 0.005 240 / 0.6);
    color: var(--fg-tertiary);
    font: 11px/1 'JetBrains Mono', ui-monospace, monospace;
  }
  kbd {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    color: var(--fg-secondary);
  }
  .composer {
    margin-top: 6px;
    background: var(--bg-elev);
    border: 1px solid var(--border-default);
    border-radius: 8px;
    padding: 8px 12px;
    color: var(--fg-primary);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 13px;
    height: 56px;
  }
  .caption {
    color: var(--fg-tertiary);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 12px;
  }
  .badge {
    display: inline-block;
    margin-left: 8px;
    padding: 1px 6px;
    border: 1px solid var(--border-subtle);
    border-radius: 3px;
    font: 10px/1 'JetBrains Mono', ui-monospace, monospace;
    color: var(--fg-tertiary);
  }
</style>`;

// Lucide-style minimal SVG icons (outline, 14px, stroke-1.75)
const ICON_ERASER = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21"/><path d="m5.082 11.09 8.828 8.828"/></svg>`;
const ICON_MIN = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" x2="21" y1="10" y2="3"/><line x1="3" x2="10" y1="21" y2="14"/></svg>`;
const ICON_BLANK = `<svg class="icon" viewBox="0 0 24 24"></svg>`;

function row({ name, desc, argHint, active = false, icon = ICON_BLANK }) {
  return `<div class="row ${active ? 'active' : ''}">
    ${icon}
    <span class="name">${name}</span>
    ${desc ? `<span class="desc">${desc}</span>` : ''}
    ${argHint ? `<span class="arg-hint">${argHint}</span>` : ''}
  </div>`;
}

function group(label, rows) {
  return `<div class="group">
    <div class="group-label">${label}</div>
    ${rows.join('\n')}
  </div>`;
}

function pickerShell({ caption, query, listInner }) {
  return `<!doctype html><html><head><meta charset="utf-8">${COMMON_HEAD}</head>
<body><div class="frame">
  <div class="caption">${caption}</div>
  <div class="composer-wrap">
    <div class="picker">
      <div class="listbox">${listInner}</div>
      <div class="footer">
        <span><kbd>↑↓</kbd> navigate</span>
        <span><kbd>Enter</kbd> select</span>
        <span><kbd>Tab</kbd> complete</span>
        <span><kbd>Esc</kbd> close</span>
      </div>
    </div>
    <div class="composer">${query}<span style="opacity:.6">|</span></div>
  </div>
</div></body></html>`;
}

// ─────────────── BEFORE: 4 sections, plain substring filter ───────────────
const BEFORE_HTML = pickerShell({
  caption: 'BEFORE — slash picker (4 sections, substring filter)',
  query: '/',
  listInner: [
    group('Built-in', [
      row({ name: '/clear', desc: 'Start a new conversation and clear context', icon: ICON_ERASER, active: true }),
      row({ name: '/compact', desc: 'Summarize conversation to free context', icon: ICON_MIN }),
    ]),
    group('User commands', [
      row({ name: '/run-worker', desc: 'Run a worker for a PR' }),
      row({ name: '/think', desc: 'Toggle extended thinking mode' }),
    ]),
    group('Project commands', [
      row({ name: '/deploy', desc: 'Deploy this project', argHint: '<env>' }),
    ]),
    group('Plugin commands', [
      row({ name: '/superpowers:brainstorm', desc: 'Brainstorm a feature' }),
    ]),
  ].join('\n'),
});

// ─────────────── AFTER: 6 sections (+Skills, +Agents) ───────────────
const AFTER_HTML = pickerShell({
  caption: 'AFTER — command palette (6 sections, Fuse.js fuzzy filter)',
  query: '/',
  listInner: [
    group('Built-in', [
      row({ name: '/clear', desc: 'Start a new conversation and clear context', icon: ICON_ERASER, active: true }),
      row({ name: '/compact', desc: 'Summarize conversation to free context', icon: ICON_MIN }),
    ]),
    group('User commands', [
      row({ name: '/run-worker', desc: 'Run a worker for a PR' }),
      row({ name: '/think', desc: 'Toggle extended thinking mode' }),
    ]),
    group('Project commands', [
      row({ name: '/deploy', desc: 'Deploy this project', argHint: '<env>' }),
    ]),
    group('Plugin commands', [
      row({ name: '/superpowers:brainstorm', desc: 'Brainstorm a feature' }),
    ]),
    group('Skills', [
      row({ name: '/review', desc: 'Review a pull request' }),
    ]),
    group('Agents', [
      row({ name: '/planner', desc: 'Long-form planning agent' }),
    ]),
  ].join('\n'),
});

// ─────────────── AFTER FUZZY: typo "/thnk" still surfaces /think ───────────────
const FUZZY_HTML = pickerShell({
  caption: 'AFTER — fuzzy match: query "/thnk" still surfaces /think',
  query: '/thnk',
  listInner: [
    group('User commands', [
      row({ name: '/think', desc: 'Toggle extended thinking mode', active: true }),
    ]),
  ].join('\n'),
});

async function shoot(html, file, height) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 880, height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: file, fullPage: true });
  await browser.close();
  console.log('  wrote', path.relative(root, file));
}

console.log('Capturing PR-E picker before/after screenshots...');
await shoot(BEFORE_HTML, path.join(outDir, 'before-4-sections.png'), 480);
await shoot(AFTER_HTML, path.join(outDir, 'after-6-sections.png'), 600);
await shoot(FUZZY_HTML, path.join(outDir, 'after-fuzzy.png'), 280);
console.log('Done.');
