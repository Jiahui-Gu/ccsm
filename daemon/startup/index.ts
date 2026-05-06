/**
 * Startup auto-registry — mirror of `daemon/api/index.ts` for boot-time
 * wiring. Scans `daemon/startup/*.js`, skipping `index.js` + `types.js`,
 * requires each, awaits the default export as a `Startup` function.
 *
 * Modules execute in alphabetical filename order — if A depends on B
 * being initialized first, name them so B sorts ahead (e.g. `00-db.ts`
 * before `pty.ts`).
 *
 * Two failure modes (Task #639):
 *   * `critical: false` (default) — throw is logged + we continue. Keeps
 *     a broken non-critical sub-module from crashing the whole daemon.
 *   * `critical: true` — throw is logged AND daemon exits 1 BEFORE the
 *     HTTP server starts. Parent never sees PORT, surfaces hard-fail
 *     screen. Used for modules whose failure means the daemon CANNOT
 *     serve its contract (e.g. db init — no db = silent saveState loss
 *     which was the dogfood-575 P0).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { StartupContext, Startup } from "./types";

export async function runStartup(ctx: StartupContext): Promise<void> {
  const dir = __dirname;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    process.stderr.write(`runStartup: readdir(${dir}) failed: ${String(err)}\n`);
    return;
  }
  const candidates = entries
    .filter(
      (name) =>
        name.endsWith(".js") && name !== "index.js" && name !== "types.js",
    )
    .sort();
  let okCount = 0;
  for (const name of candidates) {
    const full = path.join(dir, name);
    let mod: { default?: Startup };
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic auto-registry across compiled siblings; CJS require is intentional.
      mod = require(full) as { default?: Startup };
    } catch (err) {
      process.stderr.write(`runStartup: require(${full}) failed: ${String(err)}\n`);
      continue;
    }
    const fn = mod.default;
    if (typeof fn !== "function") continue;
    const isCritical = (fn as Startup).critical === true;
    try {
      await fn(ctx);
      okCount += 1;
    } catch (err) {
      const stack = err instanceof Error ? err.stack ?? err.message : String(err);
      if (isCritical) {
        // Task #639: critical module failure is a hard-fail. Print a
        // recognisable banner to stderr so the parent's stderr-tail
        // capture surfaces it, then exit before HTTP server binds. This
        // is the ONLY signalling channel — parent treats "no PORT line +
        // exit 1" as hard-fail and shows the startup error screen.
        process.stderr.write(
          `[daemon] FATAL: critical startup module ${name} threw — daemon will exit before binding HTTP server.\n`,
        );
        process.stderr.write(`[daemon] FATAL reason: ${stack}\n`);
        process.exit(1);
      }
      process.stderr.write(
        `runStartup: ${name} threw: ${stack}\n`,
      );
    }
  }
  process.stderr.write(`[daemon] startup phase complete (${okCount} modules)\n`);
}
