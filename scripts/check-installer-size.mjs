#!/usr/bin/env node
// Installer size guard — Task #1015 (T58).
//
// Measures the installer artifact produced by `npm run make:<platform>` and
// compares against:
//   1. Per-extension absolute ceilings from frag-11 §11.5(6) (HARD fail).
//   2. A delta vs the recorded baseline in `installer/size-baseline.json`:
//        > 10% growth -> FAIL
//        >  5% growth ->  WARN (CI annotation, exit 0)
//
// The baseline file stores the last-blessed size per OS+ext. To bump it,
// edit `installer/size-baseline.json` in a separate PR (manual approval —
// NEVER auto-commit from CI per spec).
//
// Usage:
//   node scripts/check-installer-size.mjs                # auto-detect
//   node scripts/check-installer-size.mjs --dir release  # custom search dir
//   node scripts/check-installer-size.mjs --file path/to/installer.exe
//
// Exit codes:
//   0 = within budget (may print warnings)
//   1 = over absolute ceiling OR > 10% over baseline
//   2 = no installer artifact found / bad invocation
//
// CI gh-actions friendly: emits ::error:: / ::warning:: annotations.

import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { join, extname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const BASELINE_PATH = join(REPO_ROOT, 'installer', 'size-baseline.json');

// Per-extension absolute ceilings in MB. Locked in
// docs/superpowers/specs/v0.3-fragments/frag-11-packaging.md §11.5(6).
// Bumping these requires a spec edit + reviewer sign-off.
//
// 2026-05-01 rebaseline (PR #765, manager decision). The original ceilings
// (145 / 160 / 140 / 125 / 125 MB) were copied from frag-11 §11.5(6) early-
// design estimates that pre-dated the v0.3 daemon-split. Real CI builds
// during the v0.3 dark-window measure 25-71% above those numbers because:
//   * v0.3 split the daemon out of Electron-main into a separate binary
//     shipped under `daemon/native-staged` + `daemon/sdk-staged` +
//     `daemon/deps-staged` extraResources -- this is the architecture
//     change, not a regression.
//   * @sentry/* + @opentelemetry/* observability deps add ~25 MB
//     (@sentry/react alone is ~22 MB unpacked).
//   * The SDK is intentionally duplicated under `<resources>/sdk/` for
//     the loadSdk() shim AND under `daemon/node_modules/` for the daemon
//     subprocess (per spec §3.2 + required-after-pack.test.ts).
//   * Linux AppImage carries a self-extracting AppRun stub + libfuse
//     shim (~30 MB) on top of the same payload as deb/rpm.
// New ceilings = current max measured + ~20% buffer to leave v0.4 room;
// the >10% growth-vs-baseline guard remains the primary regression signal.
const CEILING_MB = {
  exe: 210,
  dmg: 235,
  AppImage: 250,
  deb: 190,
  rpm: 165,
};

const WARN_PCT = 5;
const FAIL_PCT = 10;

function emit(level, msg) {
  // GitHub Actions log command; prints plain when run locally.
  if (process.env.GITHUB_ACTIONS === 'true') {
    process.stdout.write(`::${level}::${msg}\n`);
  } else {
    process.stdout.write(`[${level}] ${msg}\n`);
  }
}

function parseArgs(argv) {
  const out = { dir: null, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[++i];
    else if (a === '--file') out.file = argv[++i];
  }
  return out;
}

function findInstallers(searchDir) {
  if (!existsSync(searchDir)) return [];
  const out = [];
  const stack = [searchDir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) {
        // Skip blockmap / unpacked dirs — only top-level installer artifacts matter.
        if (ent.name === 'win-unpacked' || ent.name === 'mac' || ent.name === 'linux-unpacked') continue;
        stack.push(p);
      } else if (ent.isFile()) {
        const ext = extname(ent.name).slice(1);
        if (ext in CEILING_MB) out.push(p);
      }
    }
  }
  return out;
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    emit('warning', `baseline file not found at ${BASELINE_PATH} — skipping delta check`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (err) {
    emit('warning', `failed to parse baseline: ${err.message}`);
    return null;
  }
}

function bytesToMB(n) {
  return n / 1024 / 1024;
}

function checkOne(filePath, baseline) {
  const ext = extname(filePath).slice(1);
  const ceilMB = CEILING_MB[ext];
  if (ceilMB === undefined) {
    emit('warning', `unknown installer ext: ${filePath}`);
    return { fail: false, warn: false };
  }
  const sizeBytes = statSync(filePath).size;
  const sizeMB = bytesToMB(sizeBytes);
  const sizeMBRounded = Math.round(sizeMB * 100) / 100;

  let fail = false;
  let warn = false;

  process.stdout.write(`\n${filePath}\n`);
  process.stdout.write(`  size:    ${sizeMBRounded} MB (${sizeBytes} bytes)\n`);
  process.stdout.write(`  ceiling: ${ceilMB} MB (.${ext})\n`);

  if (sizeMB > ceilMB) {
    emit('error', `${basename(filePath)} exceeds absolute ceiling: ${sizeMBRounded} MB > ${ceilMB} MB`);
    fail = true;
  }

  if (baseline && baseline.entries) {
    const key = baseline.entries[ext] != null ? ext : null;
    if (key) {
      const baselineBytes = baseline.entries[ext];
      const baselineMB = Math.round(bytesToMB(baselineBytes) * 100) / 100;
      const deltaPct = ((sizeBytes - baselineBytes) / baselineBytes) * 100;
      const deltaPctRounded = Math.round(deltaPct * 100) / 100;
      process.stdout.write(`  baseline: ${baselineMB} MB (delta ${deltaPctRounded > 0 ? '+' : ''}${deltaPctRounded}%)\n`);

      if (deltaPct > FAIL_PCT) {
        emit('error', `${basename(filePath)} grew ${deltaPctRounded}% vs baseline (>${FAIL_PCT}% fail threshold)`);
        fail = true;
      } else if (deltaPct > WARN_PCT) {
        emit('warning', `${basename(filePath)} grew ${deltaPctRounded}% vs baseline (>${WARN_PCT}% warn threshold)`);
        warn = true;
      }
    } else {
      emit('warning', `no baseline entry for .${ext} — skipping delta check (add to installer/size-baseline.json)`);
    }
  }

  return { fail, warn };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  let files = [];
  if (args.file) {
    if (!existsSync(args.file)) {
      emit('error', `--file does not exist: ${args.file}`);
      process.exit(2);
    }
    files = [resolve(args.file)];
  } else {
    const searchDir = args.dir
      ? resolve(args.dir)
      : join(REPO_ROOT, 'release');
    files = findInstallers(searchDir);
    if (files.length === 0) {
      emit('error', `no installer artifacts found under ${searchDir} (expected .exe/.dmg/.AppImage/.deb/.rpm)`);
      process.exit(2);
    }
  }

  const baseline = loadBaseline();
  let anyFail = false;
  let anyWarn = false;

  for (const f of files) {
    const r = checkOne(f, baseline);
    anyFail = anyFail || r.fail;
    anyWarn = anyWarn || r.warn;
  }

  process.stdout.write('\n');
  if (anyFail) {
    process.stdout.write('RESULT: FAIL — installer size budget exceeded\n');
    process.exit(1);
  }
  if (anyWarn) {
    process.stdout.write('RESULT: PASS (with warnings)\n');
  } else {
    process.stdout.write('RESULT: PASS\n');
  }
  process.exit(0);
}

main();
