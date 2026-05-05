/**
 * Startup auto-registry — mirror of `daemon/api/index.ts` for boot-time
 * wiring. Scans `daemon/startup/*.js`, skipping `index.js` + `types.js`,
 * requires each, awaits the default export as a `Startup` function.
 *
 * Modules execute in alphabetical filename order — if A depends on B
 * being initialized first, name them so B sorts ahead (e.g. `00-db.ts`
 * before `pty.ts`). One module throwing is logged + skipped; the daemon
 * keeps booting so a single bad module doesn't crash the host.
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
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require(full) as { default?: Startup };
    } catch (err) {
      process.stderr.write(`runStartup: require(${full}) failed: ${String(err)}\n`);
      continue;
    }
    const fn = mod.default;
    if (typeof fn !== "function") continue;
    try {
      await fn(ctx);
      okCount += 1;
    } catch (err) {
      process.stderr.write(
        `runStartup: ${name} threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
      );
    }
  }
  process.stderr.write(`[daemon] startup phase complete (${okCount} modules)\n`);
}
