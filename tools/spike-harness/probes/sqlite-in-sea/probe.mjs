// probe.mjs — T9.8 spike entrypoint.
//
// Goal: Inside a Node 22 single-executable application (SEA), load the
// better-sqlite3 native .node addon and run a trivial query. Per spec
// ch10 §1, JS is embedded in the SEA blob; native .node files cannot be
// embedded — they MUST sit on disk next to the binary and be loaded via
// `createRequire(process.execPath)` so the search path is the binary's
// directory, NOT the (frozen) SEA virtual filesystem.
//
// Note: written in a CJS-compatible subset (no top-level await, no
// import.meta) because esbuild bundles this for SEA into a CJS file.
//
// Contract:
//   stdout (success):
//     SQLITE_VERSION=<version>
//     LOAD_PATH=<absolute path to the .node we resolved>
//     EXEC_PATH=<process.execPath>
//     IS_SEA=<true|false>
//   exit 0 on success, non-zero on any failure (with stack on stderr).

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import process from 'node:process';

let isSea = false;
try {
  // node:sea is only available inside a SEA binary. Use createRequire so
  // esbuild leaves the import alone (we mark node:sea external).
  const req = createRequire(process.execPath);
  const sea = req('node:sea');
  isSea = typeof sea.isSea === 'function' ? sea.isSea() : false;
} catch {
  isSea = false;
}

// Anchor require resolution at the binary so node_modules sitting next to
// the SEA binary (specifically better_sqlite3.node) can be found.
const require = createRequire(process.execPath);
const binDir = dirname(process.execPath);

const candidates = [
  // SEA sidecar layout — flat .node next to the binary.
  join(binDir, 'better_sqlite3.node'),
  // SEA sidecar layout — full module tree next to the binary.
  join(binDir, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
];

let loadPath = null;
for (const c of candidates) {
  if (existsSync(c)) {
    loadPath = c;
    break;
  }
}

let Database = null;
let dlopenOnly = false;
try {
  // Preferred path: require the JS wrapper (which finds the .node via
  // `bindings`). This works when node_modules/better-sqlite3 sits next
  // to the binary, because createRequire(execPath) resolves there.
  Database = require('better-sqlite3');
} catch (errWrapper) {
  // Fallback: if the JS wrapper isn't reachable, dlopen the .node directly
  // to prove the *native* side loads from a SEA. We cannot run a query in
  // that mode (no JS bindings), but the load-time question is the spike's
  // primary concern.
  if (loadPath) {
    try {
      const mod = { exports: {} };
      process.dlopen(mod, loadPath);
      dlopenOnly = true;
    } catch (errDlopen) {
      process.stderr.write(`LOAD_FAILED (wrapper): ${errWrapper.stack || errWrapper.message}\n`);
      process.stderr.write(`LOAD_FAILED (dlopen):  ${errDlopen.stack || errDlopen.message}\n`);
      process.exit(1);
    }
  } else {
    process.stderr.write(`LOAD_FAILED: ${errWrapper.stack || errWrapper.message}\n`);
    process.stderr.write(`(no .node candidate found next to ${process.execPath})\n`);
    process.exit(1);
  }
}

if (dlopenOnly) {
  process.stdout.write('SQLITE_VERSION=<dlopen-only, no JS wrapper>\n');
  process.stdout.write(`LOAD_PATH=${loadPath}\n`);
  process.stdout.write(`EXEC_PATH=${process.execPath}\n`);
  process.stdout.write(`IS_SEA=${isSea}\n`);
  process.exit(0);
}

const db = new Database(':memory:');
const row = db.prepare('SELECT sqlite_version() AS v').get();
db.close();

process.stdout.write(`SQLITE_VERSION=${row.v}\n`);
process.stdout.write(`LOAD_PATH=${loadPath || '(resolved via require)'}\n`);
process.stdout.write(`EXEC_PATH=${process.execPath}\n`);
process.stdout.write(`IS_SEA=${isSea}\n`);
