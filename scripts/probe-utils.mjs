// Shared probe helpers. Pick the app renderer window (not DevTools) since
// dev mode opens DevTools detached and the order of windows is racy.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function appWindow(app, { timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        const url = w.url();
        if (url.startsWith('http://localhost') || url.startsWith('file://')) return w;
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('appWindow: no renderer window appeared in time');
}

// Spin up an isolated static server bound to a free port that serves the
// freshly-built `dist/renderer/`. Returns `{ port, close }`. Used by
// E2E probes that MUST load this worktree's bundle — never the developer's
// possibly-stale `npm run dev:web` instance on the default port 4100.
//
// Pair with `CCSM_DEV_PORT=<port>` in the electron launch env so
// `electron/main.ts` points the BrowserWindow at our server instead of
// the well-known dev port.
export async function startBundleServer(rootDir) {
  const distDir = path.resolve(rootDir, 'dist/renderer');
  if (!fs.existsSync(path.join(distDir, 'bundle.js'))) {
    throw new Error('dist/renderer/bundle.js missing — run `npm run build` first');
  }
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.png': 'image/png',
    '.json': 'application/json'
  };
  const server = http.createServer((req, res) => {
    const reqPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const filePath = reqPath === '/' ? 'index.html' : reqPath.replace(/^\//, '');
    const abs = path.join(distDir, filePath);
    if (!abs.startsWith(distDir) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-type', MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
    fs.createReadStream(abs).pipe(res);
  });
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  return { port, close: () => server.close() };
}

// dnd-kit's PointerSensor listens for native PointerEvents. Playwright's
// `mouse.down/move/up` API dispatches MouseEvents — Chromium does not
// synthesize PointerEvents from those in a way dnd-kit picks up reliably,
// so the sensor's activation constraint never trips. We dispatch real
// PointerEvent instances on the document instead, which routes through
// React's synthetic event system and into dnd-kit's listeners.
//
// `holdMs` keeps the press alive over the target before release — needed
// for collapsed-group hover-to-expand (default 400ms in Sidebar).
export async function dndDrag(win, sourceSelector, targetSelector, opts = {}) {
  const { holdMs = 0, steps = 18, settleMs = 250, postReleaseMs = 350 } = opts;
  const src = win.locator(sourceSelector).first();
  const tgt = win.locator(targetSelector).first();
  await src.waitFor({ state: 'visible', timeout: 5000 });
  await tgt.waitFor({ state: 'visible', timeout: 5000 });
  const sb = await src.boundingBox();
  const tb = await tgt.boundingBox();
  if (!sb || !tb) throw new Error('dndDrag: missing boundingBox');
  const sx = sb.x + sb.width / 2;
  const sy = sb.y + sb.height / 2;
  const tx = tb.x + tb.width / 2;
  const ty = tb.y + tb.height / 2;
  // Press on the source itself so the listeners on that element wire up.
  await src.dispatchEvent('pointerdown', {
    button: 0,
    clientX: sx,
    clientY: sy,
    pointerType: 'mouse',
    pointerId: 1,
    isPrimary: true
  });
  // dnd-kit attaches pointermove/pointerup on the document after activation —
  // dispatch on document to satisfy both pre- and post-activation listeners.
  for (let i = 1; i <= steps; i++) {
    const px = sx + ((tx - sx) * i) / steps;
    const py = sy + ((ty - sy) * i) / steps;
    await win.evaluate(
      ({ px, py }) =>
        document.dispatchEvent(
          new PointerEvent('pointermove', {
            clientX: px,
            clientY: py,
            bubbles: true,
            pointerType: 'mouse',
            pointerId: 1,
            isPrimary: true
          })
        ),
      { px, py }
    );
    await win.waitForTimeout(15);
  }
  await win.waitForTimeout(settleMs);
  if (holdMs > 0) {
    // Heartbeat: re-fire pointermove on the target every 100ms during the
    // hold window. dnd-kit's collision detection (and the GroupRow
    // hover-to-expand timer) only re-evaluates on pointermove; on macOS CI
    // a single move-then-idle leaves isOver stuck false even after 1500ms.
    // The heartbeat keeps the over state hot so the auto-expand timer
    // actually fires. Win/linux were tolerant to a single move; this is
    // defensive slack, not a behavior change.
    const heartbeatMs = 100;
    let elapsed = 0;
    while (elapsed < holdMs) {
      await win.evaluate(
        ({ tx, ty }) =>
          document.dispatchEvent(
            new PointerEvent('pointermove', {
              clientX: tx,
              clientY: ty,
              bubbles: true,
              pointerType: 'mouse',
              pointerId: 1,
              isPrimary: true
            })
          ),
        { tx, ty }
      );
      await win.waitForTimeout(heartbeatMs);
      elapsed += heartbeatMs;
    }
  }
  await win.evaluate(
    ({ tx, ty }) =>
      document.dispatchEvent(
        new PointerEvent('pointerup', {
          clientX: tx,
          clientY: ty,
          bubbles: true,
          pointerType: 'mouse',
          pointerId: 1,
          isPrimary: true
        })
      ),
    { tx, ty }
  );
  await win.waitForTimeout(postReleaseMs);
}

// Allocate an isolated electron userData directory under os.tmpdir so probes
// never share persisted state with the dev user or each other. Returns the
// path plus a cleanup function the caller can invoke in finally.
export function isolatedUserData(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  return {
    dir,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  };
}

// Allocate an isolated `CLAUDE_CONFIG_DIR` for a probe that asserts on
// permission-prompt behavior.
//
// Why this exists: the dev's real `~/.claude/settings.json` may contain
// `Bash(*)`, `Write(*)`, etc. in `permissions.allow`. With those rules the
// upstream CLI silently auto-allows the tool calls these probes use as
// triggers, the renderer never receives a `can_use_tool`/`hook_callback`
// request, no Allow button ever appears, and the probe's `waitFor(allowSel)`
// times out — OR worse, the probe asserts the wrong thing and false-greens.
// Probes that EXIST to verify "the permission prompt fires" must spawn the
// CLI against a config dir whose allowlist is empty.
//
// Returned shape mirrors `isolatedUserData`. The settings.json seeded inside
// is the minimum the CLI needs to boot with no allowlist. Pass the resulting
// `dir` as `CCSM_CLAUDE_CONFIG_DIR` in the electron launch env — ccsm's
// `resolveClaudeConfigDir` (electron/agent-sdk/sessions.ts) will pick it up
// and the spawned CLI will see it as `CLAUDE_CONFIG_DIR`.
//
// CRITICAL: the user's real `~/.claude/.credentials.json` is NOT copied —
// these probes rely on the user being logged in to talk to the model. We
// symlink (or copy if symlinks aren't allowed) just `.credentials.json`
// from the real config dir so login persists, while leaving every other
// file (settings.json, projects/, agents/, etc.) absent.
export function isolatedClaudeConfigDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-cfg-'));
  // Inherit only the `env` block from the user's real settings.json — that's
  // where ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / model overrides live
  // and the CLI needs them to actually talk to a backend. Drop `permissions`
  // (and everything else) so no auto-allow rules carry over and every tool
  // call must hit the permission-prompt path.
  const sandboxSettings = { permissions: { allow: [], deny: [] } };
  try {
    const realSettings = path.join(os.homedir(), '.claude', 'settings.json');
    if (fs.existsSync(realSettings)) {
      const raw = JSON.parse(fs.readFileSync(realSettings, 'utf8'));
      if (raw && typeof raw === 'object' && raw.env && typeof raw.env === 'object') {
        sandboxSettings.env = raw.env;
      }
    }
  } catch {}
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify(sandboxSettings, null, 2),
    'utf8'
  );
  // Inherit credentials so the spawned CLI can authenticate.
  const realCreds = path.join(os.homedir(), '.claude', '.credentials.json');
  if (fs.existsSync(realCreds)) {
    try {
      fs.copyFileSync(realCreds, path.join(dir, '.credentials.json'));
    } catch {}
  }
  return {
    dir,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  };
}

// Switch the renderer's theme deterministically and wait for the swap to
// take visual effect.
//
// Why this helper exists (#264):
//   The naive "flip `theme-light`/`theme-dark` classes on <html>" approach
//   used by earlier capture scripts (e.g. the original
//   capture-dropped-tool-contrast-242.mjs) produced screenshots that
//   md5-matched across themes. Three reasons compound:
//     1. App.tsx owns a `useEffect([theme])` that re-applies BOTH `dark`
//        and `theme-light` classes from the zustand store. A manual
//        classList.toggle race-loses to the next React render that
//        re-fires this effect; the manual class is silently reverted.
//        The store is the single source of truth — only `setTheme(...)`
//        survives the next render cycle.
//     2. The classes the App actually toggles are `dark` and
//        `theme-light` (NOT `theme-dark`). Capture scripts that removed
//        `theme-dark` were no-ops on the dark side; the previously-set
//        `dark` class lingered.
//     3. Even after the class lands, `getComputedStyle().backgroundColor`
//        is sampled before Chromium has re-resolved the dependent CSS
//        variables and re-painted. Two rAFs (style → layout → paint)
//        are the minimum settle window before screenshotting.
//
// What this helper does:
//   - Calls `__ccsmStore.setState({ theme: <mode> })` so the App's
//     `useEffect([theme])` fires its own apply() and writes ALL the
//     classes/data attributes the rest of the styling depends on.
//   - Awaits a `waitForFunction` that the expected `html.theme-light` /
//     `html.dark` class is present and `data-theme` matches — proves the
//     effect ran, not just that we asked for the change.
//   - Awaits double rAF in the page so Chromium has had a paint cycle to
//     resolve the new `--color-*` custom properties before any
//     screenshot or color sample.
//   - Optionally asserts a sentinel CSS variable swapped by reading
//     `--color-bg-app` and confirming the OK-Lch lightness moved past a
//     midpoint (light > 0.6, dark < 0.6). This catches the scenario
//     where the class lands but the CSS file we built doesn't actually
//     contain the override (e.g. Tailwind purge dropped it). Off by
//     default (`verify: false`) for callers that haven't built with the
//     full theme CSS.
export async function setTheme(win, mode, { verify = false, timeoutMs = 5000 } = {}) {
  if (mode !== 'light' && mode !== 'dark') {
    throw new Error(`setTheme: mode must be 'light' or 'dark', got ${mode}`);
  }
  // Wait for BOTH the store to be exposed AND React to have mounted at least
  // one component subtree. Calling setTheme before React mounts is a no-op
  // in terms of class application — the App.tsx `useEffect([theme])` hasn't
  // run yet, so writing `theme: 'dark'` to the store changes nothing on
  // <html> until first render. The original capture-dropped-tool-contrast-242
  // script (#264) ran into exactly this and produced theme-identical PNGs
  // because the class flips it issued were either reverted by the eventual
  // first render or never re-applied.
  await win.waitForFunction(
    () => !!window.__ccsmStore && (document.getElementById('root')?.children.length ?? 0) > 0,
    null,
    { timeout: timeoutMs }
  );
  await win.evaluate((m) => {
    const store = window.__ccsmStore;
    const st = store.getState();
    if (typeof st.setTheme === 'function') st.setTheme(m);
    else store.setState({ theme: m });
  }, mode);
  // The App's useEffect([theme]) is what actually writes the classes; wait
  // for ITS output, not ours.
  await win.waitForFunction(
    (m) => {
      const html = document.documentElement;
      if (m === 'light') {
        return html.classList.contains('theme-light') &&
          !html.classList.contains('dark') &&
          html.dataset.theme === 'light';
      }
      return html.classList.contains('dark') &&
        !html.classList.contains('theme-light') &&
        html.dataset.theme === 'dark';
    },
    mode,
    { timeout: timeoutMs }
  );
  // Double rAF: rAF #1 fires after style recalc, rAF #2 fires after layout
  // and paint scheduling. Screenshots taken before rAF #2 returns can still
  // capture the old paint frame on Chromium under heavy renderer load.
  await win.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  );
  if (verify) {
    const bgLum = await win.evaluate(() => {
      const raw = getComputedStyle(document.documentElement)
        .getPropertyValue('--color-bg-app')
        .trim();
      const m = raw.match(/^oklch\(\s*([0-9.]+)/i) || raw.match(/^oklab\(\s*([0-9.]+)/i);
      if (m) return parseFloat(m[1]);
      const rgb = raw.match(/rgba?\(\s*(\d+)[, ]+(\d+)[, ]+(\d+)/);
      if (rgb) {
        return (0.2126 * +rgb[1] + 0.7152 * +rgb[2] + 0.0722 * +rgb[3]) / 255;
      }
      return null;
    });
    if (bgLum == null) {
      throw new Error(`setTheme(${mode}): could not parse --color-bg-app; theme CSS may not be loaded`);
    }
    if (mode === 'light' && bgLum < 0.6) {
      throw new Error(`setTheme('light'): --color-bg-app lightness=${bgLum.toFixed(2)} too dark; class flip didn't propagate`);
    }
    if (mode === 'dark' && bgLum > 0.6) {
      throw new Error(`setTheme('dark'): --color-bg-app lightness=${bgLum.toFixed(2)} too light; class flip didn't propagate`);
    }
  }
}

// Wait for the renderer's zustand store to finish hydration (rendering
// implies React has mounted, which implies hydrateStore().finally() has run).
// Then forcibly replace state with the fixture and yield long enough for
// React to flush. Use this instead of raw setState — the store is async-
// hydrated and a bare setState can race the persisted-state apply.
//
// Task #311: post-PR #976 (Wave 0e persist.ts cutover) hydrateStore resolves
// far faster than the old IPC-based path, so probes can race in before the
// store has applied persisted state (theme, groups, etc.). Gate on the
// `window.__ccsm_hydrated` flag set by `src/index.tsx` after `hydrateStore()`
// settles to make the wait deterministic.
export async function seedStore(win, state) {
  await win.waitForFunction(
    () => !!window.__ccsmStore && document.querySelector('aside') !== null,
    null,
    { timeout: 20_000 }
  );
  // Task #313 round 5: dump renderer state on hydration-gate timeout to
  // discriminate root cause (missed store update / React unmounted / hydration
  // race / persisted-shape regression / ErrorBoundary fallback). Remove after
  // #311 resolves.
  try {
    await win.waitForFunction(() => window.__ccsm_hydrated === true, null, {
      timeout: 5_000,
    });
  } catch (e) {
    const dump = await win.evaluate(() => ({
      hydratedFlag: window.__ccsm_hydrated,
      storeRef: !!window.__ccsmStore,
      storeTheme: window.__ccsmStore?.getState?.().theme,
      persistedRaw: localStorage.getItem('main')?.slice(0, 200) ?? null,
      appMounted: !!document.querySelector('aside'),
      errorBoundaryShown: /Something went wrong/.test(document.body.innerText),
      daemonModalOpen: !!document.querySelector('[data-testid="daemon-not-running-modal"]'),
      htmlClasses: document.documentElement.className,
      bodyTextHead: document.body.innerText.slice(0, 200),
      ccsmError: window.__ccsm_error ?? null,
    }));
    console.error('[seedStore] hydration gate timeout — dump:', JSON.stringify(dump));
    throw e;
  }
  await win.evaluate((s) => {
    const store = window.__ccsmStore;
    if (!store) throw new Error('__ccsmStore missing on window — App.tsx no longer exposes it?');
    store.setState(s);
  }, state);
  await win.waitForTimeout(200);
}
