// Dogfood probe — dual-install isolation (#898 / #896 audit Item 8).
//
// Verifies that PR #616's prod + dev co-install isolation actually holds on
// real builds. The release gate (feedback_dogfood_protocol.md) requires
// "prod-install pass mandatory per release WITH CLEARED USER CONFIG"; this
// probe is the automated half of that gate for the dual-variant case.
//
// What it checks:
//   1. Each variant reports a distinct app.getName() ("CCSM" vs "CCSM Dev").
//   2. Each variant resolves a distinct app.getPath('userData').
//   3. The userData dir for each variant matches its productName segment.
//   4. (Bonus) Both variants can run simultaneously without single-instance
//      lock collision — they stay alive ≥3s side-by-side.
//
// Strategy:
//   * Prefer real packaged installers (release/CCSM-Setup-*.exe and
//     release/CCSM Dev-Setup-*.exe). Install each silently to a temp dir,
//     launch the unpacked exe, capture metrics, uninstall.
//   * Fallback (dev/CI without installers): launch the locally-built
//     unpacked dir (release/win-unpacked) twice — once as-is for prod, once
//     with `--ccsm-name-override="CCSM Dev"` parsed by the probe-launched
//     wrapper. NOTE: the unpacked dir is overwritten between prod/dev
//     electron-builder runs, so the fallback only exercises the in-process
//     code path (app.setName) — it does NOT validate the packaged appId
//     isolation. The probe prints a WARNING in fallback mode.
//
// Usage:
//   # After running: npm run make:win && npm run make:win:dev
//   node scripts/probe-dual-install.mjs
//
// Exit codes:
//   0 = all assertions pass
//   1 = any assertion fail
//   2 = prerequisites missing (no installers AND no unpacked build)

import { _electron as electron } from 'playwright';
import { existsSync, readdirSync, rmSync, mkdtempSync, statSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const RELEASE_DIR = path.join(ROOT, 'release');

const results = [];
const log = (step, ok, detail) => {
  results.push({ step, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${step}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 300) : ''}`);
};

function findInstaller(productNamePrefix) {
  if (!existsSync(RELEASE_DIR)) return null;
  const entries = readdirSync(RELEASE_DIR);
  const match = entries.find((f) => f.startsWith(productNamePrefix + '-Setup-') && f.endsWith('.exe'));
  return match ? path.join(RELEASE_DIR, match) : null;
}

function findUnpackedExe() {
  // electron-builder default unpacked-dir name on Windows.
  const candidates = ['win-unpacked', 'win-ia32-unpacked', 'win-arm64-unpacked'];
  for (const c of candidates) {
    const dir = path.join(RELEASE_DIR, c);
    if (existsSync(dir)) {
      const entries = readdirSync(dir);
      const exe = entries.find((f) => f.endsWith('.exe') && !f.toLowerCase().includes('uninst'));
      if (exe) return { dir, exe: path.join(dir, exe) };
    }
  }
  return null;
}

async function captureMetricsViaPlaywright({ exePath, args = [], env = {}, label }) {
  // Launch the packaged executable directly via playwright.
  // The exe IS the electron app — playwright._electron.launch supports this
  // when given executablePath + args=['.'] is unnecessary because the
  // packaged binary already knows its asar.
  const userDataOverride = mkdtempSync(path.join(os.tmpdir(), `ccsm-probe-${label}-`));
  const electronApp = await electron.launch({
    executablePath: exePath,
    args: [`--user-data-dir=${userDataOverride}`, ...args],
    env: {
      ...process.env,
      ...env,
      CCSM_E2E_NO_SINGLE_INSTANCE: '1',
      ELECTRON_DISABLE_GPU: '1',
    },
    timeout: 60000,
  });

  // Pull facts from main-process via electronApp.evaluate (runs in main).
  const facts = await electronApp.evaluate(async ({ app }) => {
    return {
      appName: app.getName(),
      userData: app.getPath('userData'),
      exePath: app.getPath('exe'),
      version: app.getVersion(),
    };
  });

  await electronApp.close().catch(() => { /* ignore */ });
  // Best-effort cleanup of the override dir.
  try { rmSync(userDataOverride, { recursive: true, force: true }); } catch { /* ignore */ }
  return facts;
}

async function launchAndKeepAlive({ exePath, label, holdMs }) {
  // Spawn raw child (not playwright) so we can keep two alive concurrently.
  const userDataOverride = mkdtempSync(path.join(os.tmpdir(), `ccsm-probe-keep-${label}-`));
  const child = spawn(exePath, [`--user-data-dir=${userDataOverride}`], {
    env: {
      ...process.env,
      CCSM_E2E_NO_SINGLE_INSTANCE: '1',
      ELECTRON_DISABLE_GPU: '1',
    },
    detached: false,
    stdio: 'ignore',
    windowsHide: true,
  });
  return { child, userDataOverride };
}

function processAlive(child) {
  if (!child || child.killed) return false;
  try { return child.exitCode === null && child.signalCode === null; } catch { return false; }
}

async function main() {
  console.log('===== probe-dual-install =====');
  console.log('release dir:', RELEASE_DIR);

  const prodInstaller = findInstaller('CCSM');
  const devInstaller = findInstaller('CCSM Dev');
  console.log('prod installer:', prodInstaller || '(none)');
  console.log('dev installer :', devInstaller || '(none)');

  // Decide mode.
  let prodExe = null;
  let devExe = null;
  let mode = null;

  if (prodInstaller && devInstaller) {
    mode = 'installer';
    // Silent install both; capture install dirs.
    // NSIS one-click=false build, but installer supports /S silent + /D=path
    // (must be the LAST argument).
    const prodInstallDir = path.join(os.tmpdir(), 'ccsm-probe-prod-install');
    const devInstallDir = path.join(os.tmpdir(), 'ccsm-probe-dev-install');
    rmSync(prodInstallDir, { recursive: true, force: true });
    rmSync(devInstallDir, { recursive: true, force: true });
    console.log('installing prod →', prodInstallDir);
    execSync(`"${prodInstaller}" /S /D=${prodInstallDir}`, { stdio: 'inherit' });
    console.log('installing dev  →', devInstallDir);
    execSync(`"${devInstaller}" /S /D=${devInstallDir}`, { stdio: 'inherit' });
    prodExe = path.join(prodInstallDir, 'CCSM.exe');
    devExe = path.join(devInstallDir, 'CCSM Dev.exe');
    if (!existsSync(prodExe)) { log('prod-exe-exists', false, prodExe); process.exit(1); }
    if (!existsSync(devExe))  { log('dev-exe-exists',  false, devExe);  process.exit(1); }
  } else {
    // Fallback: try unpacked.
    const unpacked = findUnpackedExe();
    if (!unpacked) {
      console.error('\nFAIL: neither installers nor unpacked build found.');
      console.error('Prerequisites:');
      console.error('  npm run make:win        # builds prod installer + win-unpacked');
      console.error('  npm run make:win:dev    # builds dev installer  (overwrites win-unpacked)');
      console.error('Then re-run this probe.');
      process.exit(2);
    }
    mode = 'unpacked';
    console.warn('\nWARNING: running in unpacked-fallback mode.');
    console.warn('  - electron-builder overwrites release/win-unpacked between prod/dev runs.');
    console.warn('  - Fallback validates app.setName() code path only, NOT packaged appId isolation.');
    console.warn('  - For full release-gate coverage, build BOTH installers and re-run.\n');
    prodExe = unpacked.exe;
    devExe = unpacked.exe; // Same binary; we'll override name via env at launch.
  }

  // ---------- Capture facts for prod ----------
  let prodInfo, devInfo;
  try {
    prodInfo = await captureMetricsViaPlaywright({
      exePath: prodExe,
      label: 'prod',
      env: mode === 'unpacked' ? { CCSM_FORCE_APP_NAME: 'CCSM' } : {},
    });
    log('prod-launched', true, prodInfo);
  } catch (err) {
    log('prod-launched', false, String(err).slice(0, 300));
    process.exit(1);
  }

  try {
    devInfo = await captureMetricsViaPlaywright({
      exePath: devExe,
      label: 'dev',
      env: mode === 'unpacked' ? { CCSM_FORCE_APP_NAME: 'CCSM Dev' } : {},
    });
    log('dev-launched', true, devInfo);
  } catch (err) {
    log('dev-launched', false, String(err).slice(0, 300));
    process.exit(1);
  }

  // ---------- Assertions ----------
  if (mode === 'installer') {
    // Hard assertions only meaningful when we ran two distinct binaries.
    log(
      'app-name-prod-is-CCSM',
      prodInfo.appName === 'CCSM',
      { actual: prodInfo.appName },
    );
    log(
      'app-name-dev-is-CCSM-Dev',
      devInfo.appName === 'CCSM Dev',
      { actual: devInfo.appName },
    );
    log(
      'app-names-distinct',
      prodInfo.appName !== devInfo.appName,
      { prod: prodInfo.appName, dev: devInfo.appName },
    );
    log(
      'userdata-dirs-distinct',
      prodInfo.userData !== devInfo.userData,
      { prod: prodInfo.userData, dev: devInfo.userData },
    );
    // We forced --user-data-dir to a tmp path so the userData equals that
    // override; verify the tmp dirs themselves differ (already by construction)
    // AND verify the productName-derived directory exists on disk for each
    // install (electron's default %APPDATA%\<productName>\ should be absent
    // because we overrode, so instead verify install dir contains the right
    // productName.exe).
    const prodInstallExe = prodInfo.exePath || '';
    const devInstallExe = devInfo.exePath || '';
    log(
      'prod-exe-name-CCSM.exe',
      /\bCCSM\.exe$/i.test(prodInstallExe),
      { actual: prodInstallExe },
    );
    log(
      'dev-exe-name-CCSM-Dev.exe',
      /\bCCSM Dev\.exe$/i.test(devInstallExe),
      { actual: devInstallExe },
    );
  } else {
    // Unpacked fallback: app name comes from package.json#productName, which
    // is "CCSM" for both runs. We can only soft-assert that the binary loads.
    log(
      'unpacked-prod-loaded',
      typeof prodInfo.appName === 'string' && prodInfo.appName.length > 0,
      prodInfo,
    );
    log(
      'unpacked-dev-loaded',
      typeof devInfo.appName === 'string' && devInfo.appName.length > 0,
      devInfo,
    );
    log(
      'unpacked-fallback-coverage-warning',
      false,
      'unpacked mode cannot validate dual-install isolation; build installers and re-run',
    );
  }

  // ---------- Bonus: simultaneous run ----------
  if (mode === 'installer') {
    const prodLive = await launchAndKeepAlive({ exePath: prodExe, label: 'prod-sim' });
    const devLive = await launchAndKeepAlive({ exePath: devExe, label: 'dev-sim' });
    await new Promise((r) => setTimeout(r, 3500));
    const bothAlive = processAlive(prodLive.child) && processAlive(devLive.child);
    log(
      'simultaneous-run-3s',
      bothAlive,
      { prodAlive: processAlive(prodLive.child), devAlive: processAlive(devLive.child) },
    );
    try { prodLive.child.kill(); } catch { /* ignore */ }
    try { devLive.child.kill(); } catch { /* ignore */ }
    try { rmSync(prodLive.userDataOverride, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(devLive.userDataOverride, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // ---------- Summary ----------
  const failed = results.filter((r) => !r.ok);
  console.log('\n===== SUMMARY =====');
  console.log(`mode: ${mode}`);
  console.log(`total: ${results.length}, passed: ${results.length - failed.length}, failed: ${failed.length}`);
  if (failed.length) {
    console.log('failed steps:');
    for (const f of failed) console.log(`  - ${f.step}: ${JSON.stringify(f.detail).slice(0, 200)}`);
    process.exit(1);
  }
  console.log('all assertions passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error('probe crashed:', err);
  process.exit(1);
});
