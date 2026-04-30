// Capture before/after screenshots for the popover-clipped fix.
// Renders two static HTML pages (broken vs fixed) and screenshots them.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const BEFORE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:system-ui;background:#1a1a1a;color:#ddd;height:100vh;display:flex}
.sidebar{width:260px;height:100vh;background:rgba(30,30,40,0.85);backdrop-filter:blur(20px);overflow:hidden;border-right:1px solid #333;padding:12px;box-sizing:border-box;position:relative}
.main{flex:1;padding:20px;background:linear-gradient(135deg,#222,#444)}
.row{display:flex;gap:8px;align-items:center}
.cluster{display:flex;flex:1}
.new-btn{flex:1;height:32px;background:#3a3a4a;color:#fff;border:1px solid #555;border-radius:4px 0 0 4px;padding:0 8px;cursor:pointer}
.chev{width:28px;height:32px;background:#3a3a4a;color:#fff;border:1px solid #555;border-left:0;border-radius:0 4px 4px 0;cursor:pointer}
.search{width:32px;height:32px;background:#3a3a4a;border:1px solid #555;border-radius:4px;color:#fff}
.popover{position:fixed;min-width:320px;background:#2a2a3a;border:1px solid #666;border-radius:6px;padding:14px;color:#eee;box-shadow:0 8px 24px rgba(0,0,0,0.6);font-size:13px}
.popover input{width:100%;padding:6px;background:#1e1e2a;border:1px solid #444;color:#fff;border-radius:3px;box-sizing:border-box;margin-bottom:8px}
.popover .item{padding:6px 8px;border-radius:3px;color:#bbb;font-family:monospace;font-size:12px}
.popover .item:hover{background:#3a3a4a}
.label{font-size:11px;color:#888;margin-bottom:6px;text-transform:uppercase}
</style></head><body>
<div class="sidebar">
<div class="row">
<div class="cluster">
<button class="new-btn">+ New session</button>
<button class="chev" id="chev">v</button>
</div>
<button class="search">S</button>
</div>
<!-- BROKEN: popover is a child of .sidebar (backdrop-filter creates containing block) -->
<div class="popover" style="top:54px;left:20px"><div class="label">Recent</div><input placeholder="search cwd"><div class="item">C:/Users/me/projects/foo</div><div class="item">C:/Users/me/projects/bar-baz</div><div class="item">D:/work/long-path-here</div></div>
</div>
<div class="main"><h2 style="margin-top:0">Main content</h2><p>The popover above is clipped on the right edge by sidebar's overflow:hidden. backdrop-filter:blur on the sidebar creates a containing block that traps position:fixed descendants.</p></div>
</body></html>`;

const AFTER_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:system-ui;background:#1a1a1a;color:#ddd;height:100vh;display:flex}
.sidebar{width:260px;height:100vh;background:rgba(30,30,40,0.85);backdrop-filter:blur(20px);overflow:hidden;border-right:1px solid #333;padding:12px;box-sizing:border-box;position:relative}
.main{flex:1;padding:20px;background:linear-gradient(135deg,#222,#444)}
.row{display:flex;gap:8px;align-items:center}
.cluster{display:flex;flex:1}
.new-btn{flex:1;height:32px;background:#3a3a4a;color:#fff;border:1px solid #555;border-radius:4px 0 0 4px;padding:0 8px;cursor:pointer}
.chev{width:28px;height:32px;background:#3a3a4a;color:#fff;border:1px solid #555;border-left:0;border-radius:0 4px 4px 0;cursor:pointer}
.search{width:32px;height:32px;background:#3a3a4a;border:1px solid #555;border-radius:4px;color:#fff}
.popover{position:fixed;min-width:320px;background:#2a2a3a;border:1px solid #666;border-radius:6px;padding:14px;color:#eee;box-shadow:0 8px 24px rgba(0,0,0,0.6);font-size:13px;z-index:9999}
.popover input{width:100%;padding:6px;background:#1e1e2a;border:1px solid #444;color:#fff;border-radius:3px;box-sizing:border-box;margin-bottom:8px}
.popover .item{padding:6px 8px;border-radius:3px;color:#bbb;font-family:monospace;font-size:12px}
.popover .item:hover{background:#3a3a4a}
.label{font-size:11px;color:#888;margin-bottom:6px;text-transform:uppercase}
</style></head><body>
<div class="sidebar">
<div class="row">
<div class="cluster">
<button class="new-btn">+ New session</button>
<button class="chev" id="chev">v</button>
</div>
<button class="search">S</button>
</div>
</div>
<div class="main"><h2 style="margin-top:0">Main content</h2><p>Popover is now portaled to body — escapes backdrop-filter containing block, fully visible.</p></div>
<!-- FIXED: popover is a sibling of .sidebar at body level (portal), no clipping -->
<div class="popover" style="top:54px;left:20px"><div class="label">Recent</div><input placeholder="search cwd"><div class="item">C:/Users/me/projects/foo</div><div class="item">C:/Users/me/projects/bar-baz</div><div class="item">D:/work/long-path-here</div></div>
</body></html>`;

const run = async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 800, height: 500 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.setContent(BEFORE_HTML);
  await page.screenshot({ path: path.join(here, 'before.png') });
  await page.setContent(AFTER_HTML);
  await page.screenshot({ path: path.join(here, 'after.png') });
  await browser.close();
  console.log('saved before.png + after.png to', here);
};
run();
