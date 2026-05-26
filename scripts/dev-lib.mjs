// Helpers for scripts/dev.mjs. Kept separate from the entry point so they
// can be unit-tested without spawning electron / webpack-dev-server.
//
// Designed to be pure-ish: callers pass in the bits we'd otherwise reach
// for via process / fs globals, so tests can swap fakes.

import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Ask the OS for a free TCP port by listening on :0 and reading the
// assigned port off the socket. We bind to 127.0.0.1 so we never accept
// from the LAN even for the lifetime of this probe.
//
// There's an inherent race: between close() and the time the caller
// actually re-binds, another process *could* claim the port. In practice
// the dev orchestrator re-binds within milliseconds and the ephemeral
// port range is large enough that collisions are vanishingly rare for
// 1–2 concurrent dev runs. If we ever need stronger guarantees we'd
// switch to passing the bound socket fd to the child via SO_REUSEADDR,
// but that's overkill here.
export function allocateDevPort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr !== 'object') {
        srv.close();
        reject(new Error('allocateDevPort: server.address() returned non-object'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

// `.dev-userdata-<6 hex>` lets two concurrent `npm run dev` runs have
// independent SQLite WAL / cache / prefs. 6 hex = 16M values; collision
// risk is negligible for the realistic ceiling of <10 simultaneous runs.
export function generateUserDataDirName() {
  return `.dev-userdata-${randomBytes(3).toString('hex')}`;
}

// Install a cleanup function on the process so it runs on any termination
// path we can intercept on Node: normal exit, Ctrl-C (SIGINT), SIGTERM,
// SIGHUP, and uncaught exceptions.
//
// On Windows, SIGINT/SIGTERM/SIGHUP work for the orchestrator process
// itself when invoked via `npm run dev` from a console (Node maps the
// CTRL_C_EVENT). A force-kill from outside (Stop-Process -Force,
// taskkill /F /PID) sidesteps Node entirely — 'exit' does NOT fire in
// that case. Orphan recovery on next start (reapOrphanUserDataDirs) is
// the safety net for that path; Job Objects would be the proper fix
// but require a native addon, out of scope.
//
// Idempotent: multiple events firing in quick succession (e.g. SIGINT
// then exit) collapse to a single cleanup invocation.
export function installCleanupTrap(cleanup, opts = {}) {
  const proc = opts.proc ?? process;
  let ran = false;
  const once = () => {
    if (ran) return;
    ran = true;
    try {
      cleanup();
    } catch {
      // Swallow — we're already on an exit path; surfacing here would
      // mask the original cause.
    }
  };
  proc.on('exit', once);
  proc.on('SIGINT', () => {
    once();
    // SIGINT default would exit(130); we ran cleanup ourselves so
    // call exit explicitly to be sure we leave.
    try {
      proc.exit(130);
    } catch {}
  });
  proc.on('SIGTERM', () => {
    once();
    try {
      proc.exit(143);
    } catch {}
  });
  proc.on('SIGHUP', () => {
    once();
    try {
      proc.exit(129);
    } catch {}
  });
  proc.on('uncaughtException', (err) => {
    // eslint-disable-next-line no-console
    console.error('[dev] uncaughtException:', err);
    once();
    try {
      proc.exit(1);
    } catch {}
  });
  proc.on('unhandledRejection', (err) => {
    // eslint-disable-next-line no-console
    console.error('[dev] unhandledRejection:', err);
    once();
    try {
      proc.exit(1);
    } catch {}
  });
}

// Sweep stale `.dev-userdata-XXXXXX` directories at orchestrator start.
// Strong-kill of a previous run skips the exit hook, leaving the dir on
// disk; this is the recovery path. We deliberately scope to the hashed
// dirs (six hex chars) so the legacy `.dev-userdata` (no hash) is
// untouched — it might still be in use by a developer running an older
// branch in another shell.
//
// Returns the list of removed dir names so callers can log them.
export function reapOrphanUserDataDirs(repoRoot, opts = {}) {
  const maxAgeMs = opts.maxAgeMs ?? 60 * 60 * 1000; // 1h
  const now = Date.now();
  const pattern = /^\.dev-userdata-[0-9a-f]{6}$/;
  const removed = [];
  if (!existsSync(repoRoot)) return removed;
  let entries;
  try {
    entries = readdirSync(repoRoot, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!pattern.test(entry.name)) continue;
    const abs = join(repoRoot, entry.name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (now - st.mtimeMs < maxAgeMs) continue;
    try {
      rmSync(abs, { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      // Locked by another running dev instance? Leave it; next sweep
      // will retry.
    }
  }
  return removed;
}
