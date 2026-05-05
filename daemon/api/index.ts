/**
 * Endpoint registry for the daemon HTTP API.
 *
 * Wave-2-prep: auto-registry. Scans sibling files in `daemon/api/*.js`,
 * skips `index.js`, requires each, and invokes the default export as a
 * registrar `(router: Router) => void`. Wave-2 sub-PRs (B/C) drop new
 * files like `pty.ts` / `system.ts` here without touching this index —
 * which lets W2-A/B/C run in parallel (no shared edits to this file).
 *
 * A registrar that throws is logged to stderr and skipped; one bad
 * module must not take down the whole API surface.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { Router } from "../router";

type Registrar = (router: Router) => void;

export function registerApi(router: Router): void {
  const dir = __dirname;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    process.stderr.write(`registerApi: readdir(${dir}) failed: ${String(err)}\n`);
    return;
  }
  const candidates = entries
    .filter((name) => name.endsWith(".js") && name !== "index.js")
    .sort();
  for (const name of candidates) {
    const full = path.join(dir, name);
    let mod: { default?: Registrar };
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require(full) as { default?: Registrar };
    } catch (err) {
      process.stderr.write(`registerApi: require(${full}) failed: ${String(err)}\n`);
      continue;
    }
    const reg = mod.default;
    if (typeof reg !== "function") continue;
    try {
      reg(router);
    } catch (err) {
      process.stderr.write(`registerApi: register(${name}) threw: ${String(err)}\n`);
    }
  }
}
