// Themed harness — ABI self-heal cluster (Task #641).
//
// All cases use `skipLaunch: true` (no electron boot needed): the
// pipeline this harness defends is the BUILD pipeline (postinstall +
// after-pack + main-entry self-heal wiring), so we assert against the
// emitted `dist/` artifacts and source files directly. This keeps the
// case wall-time at ~tens of milliseconds each — way cheaper than a
// real cold-launch + ABI-mismatch reproduction (which would require a
// destructive native-module manipulation we don't want in CI).
//
// Why a NEW harness file (not absorbed into harness-ui.mjs)?
// dev-639 owns harness-ui.mjs for the storage banner case (L1+L2);
// this Task #641 owns L3 (build + self-heal pipeline). File ownership
// split by design — see the task spec hotfile-bypass note. The two
// harnesses run in parallel slots in run-all-e2e.mjs's discovery glob.
//
// Run: `node scripts/harness-abi-selfheal.mjs`
// Run one case: `node scripts/harness-abi-selfheal.mjs --only=after-pack-checks-sqlite`

import { runHarness } from './probe-helpers/harness-runner.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// Bare `require` is undefined in ESM modules; createRequire builds a
// CJS-flavored require bound to this file's URL so we can pull in the
// post-tsc CJS emit under dist/.
const require = createRequire(import.meta.url);

// ---------- main-entry-invokes-self-heal ----------
// Pin the contract that electron/main.ts wires the self-heal at startup.
// We assert against the BUILT dist/electron/main.js (post-tsc), not the
// source — we want to catch a tsconfig regression that would silently
// drop the new module from the emit.
async function caseMainEntryInvokesSelfHeal({ harnessRoot, log }) {
  const distMain = path.join(harnessRoot, 'dist', 'electron', 'main.js');
  if (!fs.existsSync(distMain)) {
    throw new Error(
      `dist/electron/main.js missing — run \`npm run build\` first ` +
      `(harness expects post-tsc emit to assert main-entry wiring).`,
    );
  }
  const src = fs.readFileSync(distMain, 'utf8');
  // tsc emits both `runAbiSelfHeal` (function call) and the
  // `./abi-self-heal` import path. We assert both are present so that
  // a refactor that renames the module also refreshes this contract.
  if (!src.includes('runAbiSelfHeal')) {
    throw new Error('dist/electron/main.js does not call runAbiSelfHeal — Task #641 wiring lost');
  }
  if (!/abi-self-heal/.test(src)) {
    throw new Error('dist/electron/main.js does not import ./abi-self-heal — module rename slipped through');
  }
  // Defensive: the call must happen BEFORE app.whenReady (or at least
  // before the call site). We don't parse JS here; cheap heuristic:
  // index of the runAbiSelfHeal callsite < index of the actual
  // `whenReady().then` call. We pin the runAbiSelfHeal lookup to the
  // tsc-emitted CommonJS shape — `(0, abi_self_heal_N.runAbiSelfHeal)(`
  // — instead of the bare identifier so a doc comment that mentions
  // the function doesn't false-match. Same for `whenReady().then` vs.
  // bare `whenReady` (which appears in import bookkeeping).
  const selfHealIdx = src.search(/abi_self_heal[_\d]*\.runAbiSelfHeal\)\(/);
  const whenReadyIdx = src.search(/whenReady\(\)\s*\.\s*then/);
  if (selfHealIdx === -1 || whenReadyIdx === -1) {
    throw new Error(
      `main.js missing one of runAbiSelfHeal call / whenReady().then ` +
      `(selfHealIdx=${selfHealIdx}, whenReadyIdx=${whenReadyIdx}) — wiring contract broken`,
    );
  }
  if (selfHealIdx > whenReadyIdx) {
    throw new Error(
      `runAbiSelfHeal must be invoked BEFORE app.whenReady (index ${selfHealIdx} > whenReady ${whenReadyIdx}); ` +
      `otherwise the daemon-spawner runs first and crashes on better-sqlite3 load before we can rebuild.`,
    );
  }
  log(`main.js wires runAbiSelfHeal pre-whenReady (selfHeal idx=${selfHealIdx}, whenReady idx=${whenReadyIdx})`);
}

// ---------- abi-self-heal-module-loads ----------
// The compiled CJS module must require-load cleanly under plain Node
// (no electron, no native deps required at module-eval time). This is
// the same load-smoke pattern as tests/electron-load-smoke.test.ts but
// scoped to the new module so a regression here surfaces as an e2e
// failure even if the load-smoke test was somehow disabled.
async function caseAbiSelfHealModuleLoads({ harnessRoot, log }) {
  const distModule = path.join(harnessRoot, 'dist', 'electron', 'abi-self-heal.js');
  if (!fs.existsSync(distModule)) {
    throw new Error(
      `dist/electron/abi-self-heal.js missing — run \`npm run build\` first.`,
    );
  }
  // require() in this Node-only context: the module must avoid pulling
  // electron at top level. Our source does `import { spawnSync } from
  // 'node:child_process'` only, so this should just work.
  const required = require(distModule);
  if (typeof required.runAbiSelfHeal !== 'function') {
    throw new Error('abi-self-heal.js: runAbiSelfHeal export missing or not a function');
  }
  if (typeof required.isAbiMismatchError !== 'function') {
    throw new Error('abi-self-heal.js: isAbiMismatchError export missing');
  }
  if (typeof required.defaultProbeBetterSqlite3 !== 'function') {
    throw new Error('abi-self-heal.js: defaultProbeBetterSqlite3 export missing');
  }
  if (typeof required.defaultRunRebuild !== 'function') {
    throw new Error('abi-self-heal.js: defaultRunRebuild export missing');
  }
  log('abi-self-heal.js: all four expected exports present and callable');
}

// ---------- abi-self-heal-detects-mismatch ----------
// End-to-end through the compiled module: feed it a fake probe that
// throws the canonical NODE_MODULE_VERSION error, a fake rebuild that
// returns success, an in-memory fs, and assert the result.kind chain.
// Catches the case where a refactor drops the marker-write or the
// is-mismatch detection regex.
async function caseAbiSelfHealDetectsMismatch({ harnessRoot, log }) {
  const distModule = path.join(harnessRoot, 'dist', 'electron', 'abi-self-heal.js');
  const { runAbiSelfHeal, selfHealMarkerPath } = require(distModule);

  const userDataDir = '/tmp/abi-self-heal-harness';
  const appRoot = harnessRoot;
  const store = new Map();
  // Prepopulate fake bin so the rebuild step is reachable.
  store.set(path.join(appRoot, 'node_modules', '.bin', 'electron-rebuild'), 'x');
  store.set(path.join(appRoot, 'node_modules', '.bin', 'electron-rebuild.cmd'), 'x');
  const fsMock = {
    existsSync: (p) => store.has(p),
    mkdirSync: () => {},
    readFileSync: (p) => {
      const v = store.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeFileSync: (p, data) => store.set(p, String(data)),
    unlinkSync: (p) => store.delete(p),
  };

  // Scenario A: ABI mismatch + successful rebuild → 'healed'.
  let rebuildCalls = 0;
  const probeErr = new Error(
    'NODE_MODULE_VERSION 127 ... requires NODE_MODULE_VERSION 145',
  );
  const result = runAbiSelfHeal({
    userDataDir,
    appRoot,
    isPackaged: false,
    platform: 'linux',
    probeBetterSqlite3: () => probeErr,
    runRebuild: () => {
      rebuildCalls += 1;
      return { status: 0, stderrTail: '' };
    },
    fs: fsMock,
    log: () => {},
  });
  if (result.kind !== 'healed') {
    throw new Error(`expected result.kind='healed' for ABI-mismatch + good rebuild, got ${JSON.stringify(result)}`);
  }
  if (rebuildCalls !== 1) {
    throw new Error(`expected exactly 1 rebuild call, got ${rebuildCalls}`);
  }
  if (!store.has(selfHealMarkerPath(userDataDir))) {
    throw new Error('expected marker file to be written after a healed rebuild (loop guard)');
  }

  // Scenario B: marker already present → 'already-tried' (no infinite loop).
  let secondRebuildCalls = 0;
  const result2 = runAbiSelfHeal({
    userDataDir,
    appRoot,
    isPackaged: false,
    platform: 'linux',
    probeBetterSqlite3: () => probeErr,
    runRebuild: () => {
      secondRebuildCalls += 1;
      return { status: 0, stderrTail: '' };
    },
    fs: fsMock,
    log: () => {},
  });
  if (result2.kind !== 'already-tried') {
    throw new Error(`expected result.kind='already-tried' on second run, got ${JSON.stringify(result2)}`);
  }
  if (secondRebuildCalls !== 0) {
    throw new Error(`marker guard broken: rebuild ran ${secondRebuildCalls} time(s) on second pass`);
  }
  log('healed (1 rebuild + marker) → already-tried (0 rebuilds, loop prevented)');
}

// ---------- after-pack-checks-sqlite ----------
// Static check that scripts/after-pack.cjs verifies BOTH native bindings.
// A regression that drops the better-sqlite3 check would let a broken
// installer ship to users; this case catches that without packing a
// real installer (electron-builder pack is multi-minute).
async function caseAfterPackChecksSqlite({ harnessRoot, log }) {
  const afterPack = path.join(harnessRoot, 'scripts', 'after-pack.cjs');
  const src = fs.readFileSync(afterPack, 'utf8');
  if (!/node-pty/.test(src)) {
    throw new Error('scripts/after-pack.cjs lost the node-pty check — pre-existing contract broken');
  }
  if (!/better-sqlite3/.test(src)) {
    throw new Error('scripts/after-pack.cjs missing better-sqlite3 check — Task #641 Layer 2 dropped');
  }
  if (!/better_sqlite3\.node/.test(src)) {
    throw new Error('scripts/after-pack.cjs missing the actual `better_sqlite3.node` filename assertion');
  }
  log('after-pack.cjs verifies both node-pty AND better-sqlite3 bindings ship in the bundle');
}

// ---------- postinstall-helpers-retry ----------
// Direct integration test of the rebuildWithRetry helper from
// scripts/postinstall-helpers.mjs. UT covers the same surface; this
// e2e case exists as a belt-and-suspenders check that the helper file
// loads under plain ESM and exports the expected shape (a regression
// that broke the import chain would slip past UT-only coverage).
async function casePostinstallHelpersRetry({ harnessRoot, log }) {
  const helpersUrl = new URL(
    'file:///' +
      path.join(harnessRoot, 'scripts', 'postinstall-helpers.mjs').replace(/\\/g, '/'),
  );
  const mod = await import(helpersUrl.href);
  if (typeof mod.rebuildWithRetry !== 'function') {
    throw new Error('postinstall-helpers.mjs: rebuildWithRetry export missing');
  }
  if (typeof mod.blockingSleep !== 'function') {
    throw new Error('postinstall-helpers.mjs: blockingSleep export missing');
  }
  // End-to-end retry behavior: first call fails, second succeeds, on Windows.
  let attempts = 0;
  let sleepCalls = 0;
  const result = mod.rebuildWithRetry({
    rebuildBin: '/x/electron-rebuild.cmd',
    moduleName: 'better-sqlite3',
    cwd: '/repo',
    isWindows: true,
    allowFailure: false,
    retryDelayMs: 1, // make the test fast even if sleep was real
    spawn: () => {
      attempts += 1;
      return attempts === 1 ? { status: 1 } : { status: 0 };
    },
    sleep: () => { sleepCalls += 1; },
  });
  if (result.status !== 0 || result.attempts !== 2 || sleepCalls !== 1) {
    throw new Error(
      `retry contract broken: status=${result.status} attempts=${result.attempts} sleepCalls=${sleepCalls}`,
    );
  }
  log('rebuildWithRetry: failed→sleep→succeeded loop intact (Windows EPERM recovery)');
}

// ---------- harness spec ----------
// All cases skipLaunch — see file header for the rationale.
await runHarness({
  name: 'abi-selfheal',
  cases: [
    { id: 'main-entry-invokes-self-heal', skipLaunch: true, run: caseMainEntryInvokesSelfHeal },
    { id: 'abi-self-heal-module-loads', skipLaunch: true, run: caseAbiSelfHealModuleLoads },
    { id: 'abi-self-heal-detects-mismatch', skipLaunch: true, run: caseAbiSelfHealDetectsMismatch },
    { id: 'after-pack-checks-sqlite', skipLaunch: true, run: caseAfterPackChecksSqlite },
    { id: 'postinstall-helpers-retry', skipLaunch: true, run: casePostinstallHelpersRetry },
  ],
});
