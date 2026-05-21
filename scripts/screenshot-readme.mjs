// README hero + feature screenshots.
//
// Captures docs/screenshots/readme/{hero,permission}.png by seeding a
// realistic-looking sidebar (a few groups, a few sessions per group) and a
// running terminal pane. We seed via window.__ccsmStore so we don't need
// to spin up real claude CLI sessions — the hero shot is about the UI
// shape, not live agent output.
//
// Usage: `npm run build` first, then:
//   node scripts/screenshot-readme.mjs
//
// The output dir is wiped + recreated each run so old shots don't linger.

import { mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import {
  createIsolatedClaudeDir,
  launchCcsmIsolated,
} from './probe-utils-real-cli.mjs';

const OUT_DIR = path.resolve('docs/screenshots/readme');

async function main() {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const isolated = await createIsolatedClaudeDir();
  const { electronApp, win } = await launchCcsmIsolated({
    tempDir: isolated.tempDir,
  });
  try {
    await win.waitForFunction(
      () => !!window.__ccsmStore?.getState,
      null,
      { timeout: 15000 },
    );
    // Tighter than App Store's 1440x900 — at that size the right pane
    // leaves ~40% dead vertical space when no agent is running.
    await win.setViewportSize({ width: 1280, height: 800 }).catch(() => {});

    // Force dark theme. CCSM shell + terminal both dark reads as one
    // cohesive surface; light shell + dark terminal looks like two apps.
    await win.evaluate(() => {
      window.__ccsmStore.getState().setTheme('dark');
    });

    // Stub the PTY bridge so the seeded sessions' auto-attach doesn't spawn
    // claude. Returning a fake-but-shaped attach response keeps usePtyAttach
    // on the happy path (no error overlay), and onData/onExit return real
    // no-op disposers so the listener setup doesn't throw.
    await win.evaluate(() => {
      const w = window;
      if (w.ccsmPty) {
        const noop = () => {};
        const noopAsync = async () => undefined;
        w.ccsmPty.attach = async () => ({ snapshot: '', cols: 140, rows: 34, pid: 0 });
        w.ccsmPty.detach = noopAsync;
        w.ccsmPty.spawn = async (sid) => ({ ok: true, sid, pid: 0, cols: 140, rows: 34 });
        w.ccsmPty.input = noop;
        w.ccsmPty.resize = noopAsync;
        w.ccsmPty.kill = noopAsync;
        w.ccsmPty.list = async () => [];
        w.ccsmPty.getBufferSnapshot = async () => ({ snapshot: '', seq: 0 });
        w.ccsmPty.onData = () => noop;
        w.ccsmPty.onExit = () => noop;
        if (w.ccsmPty.clipboard) {
          w.ccsmPty.clipboard.writeText = noop;
          w.ccsmPty.clipboard.readText = () => '';
        }
      }
    });

    // Seed a realistic-looking workspace: three task-oriented groups with
    // mixed session names. Group names + session names are the user-facing
    // copy that lands in the screenshot, so they need to read well.
    await win.evaluate(() => {
      const st = window.__ccsmStore.getState();
      // Wipe any default group so the seeded ones don't sit next to a
      // stray "New group". Reach into the store directly.
      window.__ccsmStore.setState({ groups: [], sessions: [], activeId: null });
      const refactor = st.createGroup('Refactor auth middleware');
      const bug = st.createGroup('Triage: paste double-fire');
      const release = st.createGroup('v0.3 release prep');
      return { refactor, bug, release };
    });

    const cwd = isolated.tempDir;
    // Seed sessions directly via setState. With ccsmPty fully stubbed the
    // auto-attach to sessions[0] runs the happy path against the fake
    // attach response — no real claude spawned, no error overlay. We
    // then write a synthetic claude transcript directly into the visible
    // xterm via `window.__ccsmTerm.write` so the hero shot demonstrates
    // CCSM's CLI-grade message density (`>` user, `●` assistant, `⏺`
    // collapsed tool) rather than the empty welcome banner.
    await win.evaluate((cwd) => {
      const st = window.__ccsmStore.getState();
      const [refactor, bug, release] = st.groups.map((g) => g.id);
      const mk = (name, groupId) => ({
        id: `seed-${Math.random().toString(36).slice(2, 10)}`,
        name,
        cwd,
        groupId,
        agentType: 'claude-code',
        state: 'idle',
        model: 'claude-opus-4-7',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const sessions = [
        mk('Read existing middleware', refactor),
        mk('Draft replacement', refactor),
        mk('Reproduce on Windows', bug),
        mk('Probe via Playwright', bug),
        mk('Update README', release),
        mk('Cut v0.3.0 tag', release),
      ];
      window.__ccsmStore.setState({ sessions, activeId: sessions[0].id });
    }, cwd);
    // Wait past the attach effect + post-attach fit + snapshot replay so
    // the script-injected transcript isn't clobbered by a late replay.
    await new Promise((r) => setTimeout(r, 2500));

    // Hide any "Attaching…" / error overlay sitting on top of xterm so
    // the right pane reads as a clean terminal in the hero shot.
    await win.evaluate(() => {
      document
        .querySelectorAll('[class*="z-10"][class*="absolute"]')
        .forEach((el) => ((el).style.display = 'none'));
    });

    // Nudge the viewport so the product's ResizeObserver fires fit() with
    // the real, fully-laid-out container width. The initial attach can fit
    // before the container settles, leaving xterm at PTY-spawn cols on a
    // wider pane. After this fires, the post-resize snapshot replay runs
    // against our (stubbed-empty) buffer — so we MUST inject the transcript
    // AFTER the replay drains, otherwise it gets reset away.
    // Nudge the viewport wider then back to the final size to force
    // ResizeObserver -> fit() against a fully-laid-out container. The
    // final size is also the screenshot dimensions — win.screenshot()
    // captures at the playwright emulated viewport, not the BrowserWindow
    // size — so pick a height that matches the seeded transcript and
    // leaves no black void below.
    await win.setViewportSize({ width: 1400, height: 880 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    await win.setViewportSize({ width: 1280, height: 780 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 600));

    // Inject a synthetic claude transcript demonstrating CCSM's CLI
    // information density. ANSI: \x1b[2m dim, \x1b[1m bold, \x1b[36m cyan,
    // \x1b[32m green, \x1b[33m yellow, \x1b[0m reset.
    await win.evaluate(() => {
      const t = window.__ccsmTerm;
      if (!t) return;
      try { t.reset(); } catch { /* ignore */ }
      const lines = [
        '\x1b[2m╭─ Refactor auth middleware  ·  ~/repos/api  ·  claude-opus-4.7\x1b[0m',
        '',
        '\x1b[36m>\x1b[0m read the current auth middleware and tell me what it does',
        '',
        '\x1b[32m●\x1b[0m I\'ll start by locating the middleware and tracing how requests flow through it.',
        '',
        '\x1b[2m⏺ \x1b[0mGrep\x1b[2m(pattern: "authMiddleware|requireAuth", glob: "**/*.ts")  →  7 matches\x1b[0m',
        '\x1b[2m⏺ \x1b[0mRead\x1b[2m(src/middleware/auth.ts, 1-180)\x1b[0m',
        '\x1b[2m⏺ \x1b[0mRead\x1b[2m(src/middleware/session.ts, 1-95)\x1b[0m',
        '',
        '\x1b[32m●\x1b[0m The middleware does three things in sequence:',
        '  \x1b[33m1.\x1b[0m Extracts the session token from the `sid` cookie (auth.ts:34)',
        '  \x1b[33m2.\x1b[0m Looks it up in Redis with a 50ms timeout, falls back to Postgres on miss',
        '  \x1b[33m3.\x1b[0m Attaches `req.user` and refreshes the token TTL if older than 12h',
        '',
        '  Notable: the Postgres fallback writes back to Redis async without awaiting,',
        '  so the next request can still miss the cache. Likely the source of the',
        '  duplicate-session-lookup spikes you saw in last week\'s dashboard.',
        '',
        '\x1b[36m>\x1b[0m good catch. open a PR that awaits the redis writeback and adds a metric',
        '',
        '\x1b[32m●\x1b[0m On it. Minimal change — one await + one counter — plus a regression test.',
        '',
        '\x1b[2m⏺ \x1b[0mEdit\x1b[2m(src/middleware/auth.ts)  +3 -1\x1b[0m',
        '\x1b[2m⏺ \x1b[0mEdit\x1b[2m(src/metrics/auth.ts)  +6 -0\x1b[0m',
        '\x1b[2m⏺ \x1b[0mWrite\x1b[2m(src/middleware/__tests__/auth.cache.test.ts)\x1b[0m',
        '\x1b[2m⏺ \x1b[0mBash\x1b[2m(npm test -- auth.cache)  →  ✓ 4 passed (220ms)\x1b[0m',
        '',
        '\x1b[32m●\x1b[0m Tests pass. Ready to push and open the PR — target `working` or branch',
        '  off `release/0.42`?',
        '',
        '\x1b[36m>\x1b[0m working, and tag @ops for review since this touches the hot path',
        '',
        '\x1b[32m●\x1b[0m Pushing to `working` and opening the PR with @ops as reviewer.',
        '',
        '\x1b[2m⏺ \x1b[0mBash\x1b[2m(git push -u origin auth-cache-await)  →  branch published\x1b[0m',
        '',
        '\x1b[33m⏵\x1b[0m \x1b[1mBash\x1b[0m wants to run \x1b[36mgh pr create --title "auth: await redis writeback" --reviewer ops --base working\x1b[0m',
        '  \x1b[2mAllow once  ·  Allow always  ·  Reject\x1b[0m',
        '',
      ];
      for (const line of lines) t.write(line + '\r\n');
      try { t.scrollToTop(); } catch { /* ignore */ }
    });
    await new Promise((r) => setTimeout(r, 1200));

    const hero = path.join(OUT_DIR, 'hero.png');
    await win.screenshot({ path: hero, clip: { x: 0, y: 0, width: 1280, height: 480 } });
    console.log(`saved ${hero}`);
  } finally {
    try { await electronApp.close(); } catch { /* ignore */ }
    try { isolated.cleanup?.(); } catch { /* ignore */ }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
