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

    // Force light theme. Default 'system' picks up dark on most dev boxes,
    // and the marketing shot reads better on light: more contrast in the
    // sidebar group headers, terminal pane background pops.
    await win.evaluate(() => {
      window.__ccsmStore.getState().setTheme('light');
    });

    // Stub the PTY bridge so the seeded sessions' auto-attach doesn't spawn
    // claude. Renderer-side stub is best-effort — main process owns the pty,
    // so we also keep activeId null at screenshot time (see below) to avoid
    // any attach IPC firing in the first place.
    await win.evaluate(() => {
      const w = window;
      if (w.ccsmPty) {
        const noop = () => {};
        const noopAsync = async () => ({ ok: true });
        w.ccsmPty.attach = noopAsync;
        w.ccsmPty.detach = noopAsync;
        w.ccsmPty.spawn = noopAsync;
        w.ccsmPty.input = noop;
        w.ccsmPty.resize = noop;
        w.ccsmPty.kill = noopAsync;
        w.ccsmPty.list = async () => [];
        w.ccsmPty.onData = () => noop;
        w.ccsmPty.onExit = () => noop;
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
    // Seed sessions directly via setState (bypassing createSession so no
    // activeId is set → no usePtyAttach → no real claude spawn). The
    // sidebar renders the seeded layout; the right pane is whatever the
    // app shows when sessions exist but activeId is null (currently:
    // `sessions[0]` is auto-selected so TerminalPane mounts but with a
    // sid that main doesn't know about → attach fails into error state,
    // which is acceptable for the hero — but we hide that overlay below).
    await win.evaluate((cwd) => {
      const st = window.__ccsmStore.getState();
      const [refactor, bug, release] = st.groups.map((g) => g.id);
      const mk = (name, groupId) => ({
        id: `seed-${Math.random().toString(36).slice(2, 10)}`,
        name,
        cwd,
        groupId,
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
      window.__ccsmStore.setState({ sessions, activeId: null });
    }, cwd);
    await new Promise((r) => setTimeout(r, 1500));

    // Hide any "Attaching…" / error overlay sitting on top of xterm so
    // the right pane reads as a clean empty terminal in the hero shot.
    await win.evaluate(() => {
      document
        .querySelectorAll('[class*="z-10"][class*="absolute"]')
        .forEach((el) => ((el).style.display = 'none'));
    });
    await new Promise((r) => setTimeout(r, 200));

    const hero = path.join(OUT_DIR, 'hero.png');
    await win.screenshot({ path: hero, fullPage: false });
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
