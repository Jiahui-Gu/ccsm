// Static capture of the SidebarResizer focus state for #263 PR evidence.
// Renders a minimal HTML stub mirroring `.pane-resize-handle` styles + the
// new `.focus-ring` overlay, then snapshots the unfocused vs focused state.
// Output: dogfood-logs/sidebar-resizer-263/{before,after}.png
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'dogfood-logs', 'sidebar-resizer-263');
fs.mkdirSync(outDir, { recursive: true });

const html = `<!doctype html>
<html><head><style>
  :root { --color-accent: oklch(0.72 0.14 215); --color-bg: #fafafa; --color-sidebar: #f1f1ef; }
  body { margin: 0; font-family: system-ui; background: var(--color-bg); }
  .row { display: flex; height: 320px; border-bottom: 1px solid #ccc; }
  .sidebar { width: 240px; background: var(--color-sidebar); padding: 16px; color: #555; font-size: 13px; }
  .main { flex: 1; padding: 16px; color: #777; font-size: 13px; }
  .label { padding: 6px 10px; background: #fff; border-bottom: 1px solid #ddd; font-size: 12px; color: #444; font-family: ui-monospace, monospace; }
  /* mirror .pane-resize-handle from src/styles/global.css */
  .pane-resize-handle {
    position: relative; flex: 0 0 4px; width: 4px; cursor: col-resize;
    outline: none; z-index: 10; user-select: none; touch-action: none;
    transition: background-color 150ms cubic-bezier(0.32, 0.72, 0, 1);
  }
  .pane-resize-handle::after {
    content: ""; position: absolute; top: 0; bottom: 0;
    left: calc(50% - 0.5px); width: 1px; background: #999; opacity: 0;
    transition: opacity 180ms cubic-bezier(0.32, 0.72, 0, 1);
    pointer-events: none;
  }
  .pane-resize-handle.focused::after { opacity: 1; background: var(--color-accent); }
  .focus-ring.focused { outline: 1px solid var(--color-accent); outline-offset: -1px; }
</style></head><body>
  <div class="label">BEFORE (#263) — resizer is mouse-only, no visible focus, not tab-reachable</div>
  <div class="row">
    <div class="sidebar">Sidebar<br/><br/>(no tabIndex on handle)</div>
    <div class="pane-resize-handle" tabindex="-1" id="before"></div>
    <div class="main">Main pane</div>
  </div>
  <div class="label">AFTER (#263) — role=separator + tabIndex=0 + .focus-ring; arrow-key resizable</div>
  <div class="row">
    <div class="sidebar">Sidebar<br/><br/>(handle focused below)</div>
    <div class="pane-resize-handle focus-ring focused" tabindex="0" id="after" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" aria-valuemin="200" aria-valuemax="480" aria-valuenow="260"></div>
    <div class="main">Main pane</div>
  </div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 720 } });
await page.setContent(html);

// Combined before/after.
await page.screenshot({ path: path.join(outDir, 'before-after.png'), fullPage: true });

// Crop to "before" only.
const beforeBox = await page.locator('.row').first().boundingBox();
await page.screenshot({ path: path.join(outDir, 'before.png'), clip: beforeBox });

// Crop to "after" only.
const afterBox = await page.locator('.row').nth(1).boundingBox();
await page.screenshot({ path: path.join(outDir, 'after.png'), clip: afterBox });

await browser.close();
console.log('Wrote screenshots to', outDir);
