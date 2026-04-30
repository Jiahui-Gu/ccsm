// E2E test-hook seams. Extracted from electron/main.ts (Task #742 Phase B).
//
// All harness diagnostic surfaces are gated behind `CCSM_NOTIFY_TEST_HOOK`
// (legacy env-var name; covers all probe-only seams now). Production never
// reads the env var so the entire `installTestHooks()` body is a no-op
// outside of e2e runs.
//
// The seams expose:
//   * __ccsmDebug                — flips the notify pipeline's diag counters
//                                  on so probes can read rule-fire counts.
//   * __ccsmSessionNamesFromRenderer
//                                — the renderer-pushed sid→name map.
//   * __ccsmNotifyPipeline       — internal ctx + markUserInput.
//   * __ccsmBadgeDebug           — total badge count + clearAll.
//   * __ccsmTestDebug            — sessionWatcher last-emitted, env, and a
//                                  jsonl tail-reader (Playwright evaluate
//                                  can't reach `require`).

import type { BadgeManager } from './notify/badge';
import type { installNotifyPipeline } from './notify/sinks/pipeline';
import { sessionWatcher } from './sessionWatcher';

export interface TestHooksDeps {
  getBadgeManager: () => BadgeManager | null;
  pipelineInstance: ReturnType<typeof installNotifyPipeline>;
}

/** Install the early test-hook seams that must be live BEFORE
 *  app.whenReady — `__ccsmSessionNamesFromRenderer` (module-load probe
 *  reads) and `__ccsmDebug` (the notify pipeline reads it during
 *  installNotifyPipeline to gate diag-counter recording). */
export function installEarlyTestHooks(
  sessionNamesFromRenderer: Map<string, string>,
): void {
  if (!process.env.CCSM_NOTIFY_TEST_HOOK) return;
  const g = globalThis as unknown as Record<string, unknown>;
  g.__ccsmSessionNamesFromRenderer = sessionNamesFromRenderer;
  // Notify pipeline diag counters — gated behind `globalThis.__ccsmDebug`
  // (#713). Production never carries them; e2e probes that consume diag
  // via the test-hook seam need them on. Set BEFORE installNotifyPipeline
  // reads it.
  g.__ccsmDebug = true;
}

/** Install the late test-hook seams that depend on the notify pipeline
 *  + badge manager being constructed (both happen inside app.whenReady). */
export function installLateTestHooks(deps: TestHooksDeps): void {
  if (!process.env.CCSM_NOTIFY_TEST_HOOK) return;
  const { getBadgeManager, pipelineInstance } = deps;
  const g = globalThis as unknown as Record<string, unknown>;

  g.__ccsmNotifyPipeline = {
    // Test seam — assert on internal Ctx shape from probes that need to
    // verify rule firing (not just the final toast/flash output).
    ctx: () => {
      const i = pipelineInstance._internals();
      return {
        focused: i.ctx.focused,
        activeSid: i.ctx.activeSid,
        lastUserInputTs: Object.fromEntries(i.ctx.lastUserInputTs),
        runStartTs: Object.fromEntries(i.ctx.runStartTs),
        mutedSids: Array.from(i.ctx.mutedSids),
        lastFiredTs: Object.fromEntries(i.ctx.lastFiredTs),
        diag: i.diag,
      };
    },
    markUserInput: (sid: string) => pipelineInstance.markUserInput(sid),
  };

  g.__ccsmBadgeDebug = {
    getTotal: () => getBadgeManager()?.getTotal() ?? 0,
    clearAll: () => getBadgeManager()?.clearAll(),
  };

  // E2E diagnostic seam — lets the harness inspect watcher state and
  // JSONL paths via electronApp.evaluate without needing access to main's
  // CommonJS `require` (Playwright's evaluate runs in a Function wrapper
  // where `require` isn't in scope).
  g.__ccsmTestDebug = {
    getLastEmittedForSid: (sid: string) =>
      sessionWatcher.getLastEmittedForTest(sid),
    env: () => ({
      CCSM_CLAUDE_CONFIG_DIR: process.env.CCSM_CLAUDE_CONFIG_DIR ?? null,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
      HOME: process.env.HOME ?? null,
      USERPROFILE: process.env.USERPROFILE ?? null,
    }),
    jsonl: () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('node:fs');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const path = require('node:path');
        const root =
          process.env.CCSM_CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR;
        const projDir = root ? path.join(root, 'projects') : null;
        if (!projDir || !fs.existsSync(projDir))
          return { projDir, exists: false };
        const projects = fs.readdirSync(projDir);
        return projects.map((p: string) => {
          const dir = path.join(projDir, p);
          try {
            const files = fs.readdirSync(dir).map((f: string) => {
              const fp = path.join(dir, f);
              let size = -1;
              let tail = '';
              try {
                size = fs.statSync(fp).size;
                if (size > 0 && f.endsWith('.jsonl')) {
                  const buf = Buffer.alloc(Math.min(size, 4000));
                  const fd = fs.openSync(fp, 'r');
                  try {
                    fs.readSync(
                      fd,
                      buf,
                      0,
                      buf.length,
                      Math.max(0, size - buf.length),
                    );
                    tail = buf.toString('utf8');
                  } finally {
                    fs.closeSync(fd);
                  }
                }
              } catch {
                /* */
              }
              return { f, size, tail };
            });
            return { project: p, files };
          } catch (e) {
            return { project: p, err: String(e) };
          }
        });
      } catch (e) {
        return `err: ${String(e)}`;
      }
    },
  };
}
