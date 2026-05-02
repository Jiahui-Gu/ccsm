// electron-builder afterSign hook — Windows signtool integration (Task #1011 / spec frag-11 §11.3.1).
//
// Signs every .exe / .dll under the packaged Windows app output dir (NSIS
// installer's $INSTDIR layout) with `signtool.exe`. Cert is ENV-driven so
// the same hook works on dev machines (no cert → skip), CI (cert injected
// via secret), and downstream re-signers (point env at their own cert).
//
// Why afterSign and NOT inline:
//   electron-builder's `signtoolOptions` only signs the outer NSIS .exe;
//   it does NOT recurse into resources/ or asar.unpacked .node files.
//   Per spec §11.3 (and round-2 P0-2), an unsigned .node dlopen'd from a
//   signed .exe trips Defender / SmartScreen on hardened systems. So we
//   walk $INSTDIR after EB finishes its work and re-sign every PE file.
//
// Spec §11.3.1 covers the daemon-side signing (runs in CI before
// electron-builder via release.yml). This hook handles the EB output side
// — primarily app-resource .dlls and any .exe shipped via extraResources
// that EB does not re-sign.
//
// ENV contract (placeholder-safe — unset env logs + skips, never fails):
//   CCSM_WIN_CERT_PATH      path to .pfx (or .cer); REQUIRED to sign.
//   CCSM_WIN_CERT_PASSWORD  pfx password; required when .pfx is encrypted.
//   CCSM_WIN_TIMESTAMP_URL  RFC3161 timestamp server URL.
//                           default: http://timestamp.digicert.com
//   CCSM_WIN_REQUIRE_SIGN   if "1"/"true", missing cert FAILS the build
//                           instead of skipping (CI prod hardening).
//
// Sign command (no shell — spawnSync with array argv to avoid injection):
//   signtool sign /f $cert /p $pass /tr $ts /td sha256 /fd sha256 <file>
//
// This module is exported as both:
//   - default export (electron-builder afterSign hook signature)
//   - named exports (for unit testing: buildSignArgs, runSign,
//     collectTargets, _spawn override)

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const DEFAULT_TIMESTAMP_URL = 'http://timestamp.digicert.com';

function isTruthy(v) {
  if (!v) return false;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

function buildSignArgs({ certPath, certPassword, timestampUrl, file }) {
  if (!certPath) throw new Error('buildSignArgs: certPath required');
  if (!file) throw new Error('buildSignArgs: file required');
  const argv = ['sign', '/f', certPath];
  if (certPassword) argv.push('/p', certPassword);
  argv.push(
    '/tr', timestampUrl || DEFAULT_TIMESTAMP_URL,
    '/td', 'sha256',
    '/fd', 'sha256',
    file,
  );
  return argv;
}

function collectTargets(rootDir) {
  // Walk rootDir recursively and collect .exe / .dll files (case-insensitive).
  // Skip symlinks to avoid double-sign loops.
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  const stack = [rootDir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (ext === '.exe' || ext === '.dll') out.push(full);
    }
  }
  return out;
}

function runSign({ certPath, certPassword, timestampUrl, file, spawnImpl }) {
  const spawn = spawnImpl || childProcess.spawnSync;
  const argv = buildSignArgs({ certPath, certPassword, timestampUrl, file });
  const result = spawn('signtool.exe', argv, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(
      `signtool spawn failed for ${file}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const stderr = (result.stderr && result.stderr.toString()) || '';
    const stdout = (result.stdout && result.stdout.toString()) || '';
    throw new Error(
      `signtool exited ${result.status} for ${file}\nstdout: ${stdout}\nstderr: ${stderr}`,
    );
  }
  return result;
}

// Post-sign verification (Task #116). `signtool verify /pa <file>` runs
// the standard Authenticode verification policy (the same one Defender
// + SmartScreen apply at runtime). Fails the build on any unsigned /
// invalid PE — load-bearing safety net for the daemon binary which is
// the focus of Task #116. /q quiets success output.
function buildVerifyArgs({ file }) {
  if (!file) throw new Error('buildVerifyArgs: file required');
  return ['verify', '/pa', '/q', file];
}

function runVerify({ file, spawnImpl }) {
  const spawn = spawnImpl || childProcess.spawnSync;
  const argv = buildVerifyArgs({ file });
  const result = spawn('signtool.exe', argv, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(
      `signtool verify spawn failed for ${file}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const stderr = (result.stderr && result.stderr.toString()) || '';
    const stdout = (result.stdout && result.stdout.toString()) || '';
    throw new Error(
      `signtool verify exited ${result.status} for ${file}\nstdout: ${stdout}\nstderr: ${stderr}`,
    );
  }
  return result;
}

async function signWindowsHook(context) {
  // electron-builder afterSign context shape: { appOutDir, packager, ... }.
  // On non-Windows targets this hook is a no-op.
  const platformName =
    (context && context.electronPlatformName) ||
    (context && context.packager && context.packager.platform && context.packager.platform.name);
  if (platformName && platformName !== 'win32') {
    console.log(`[sign-windows] skip: platform=${platformName} (non-Windows)`);
    return;
  }

  const certPath = process.env.CCSM_WIN_CERT_PATH;
  const certPassword = process.env.CCSM_WIN_CERT_PASSWORD;
  const timestampUrl = process.env.CCSM_WIN_TIMESTAMP_URL || DEFAULT_TIMESTAMP_URL;
  const requireSign = isTruthy(process.env.CCSM_WIN_REQUIRE_SIGN);

  if (!certPath) {
    const msg =
      '[sign-windows] CCSM_WIN_CERT_PATH not set — skipping signtool integration. ' +
      'Set CCSM_WIN_CERT_PATH (+ CCSM_WIN_CERT_PASSWORD) to enable production signing.';
    if (requireSign) {
      throw new Error(
        `[sign-windows] CCSM_WIN_REQUIRE_SIGN=1 but CCSM_WIN_CERT_PATH is not set. ` +
          `Cannot continue: production builds must be signed.`,
      );
    }
    console.log(msg);
    return;
  }

  if (!fs.existsSync(certPath)) {
    throw new Error(
      `[sign-windows] CCSM_WIN_CERT_PATH points at missing file: ${certPath}. ` +
        `Provide an absolute path to a readable .pfx / .cer.`,
    );
  }

  const appOutDir = (context && context.appOutDir) || process.cwd();
  const targets = collectTargets(appOutDir);
  if (targets.length === 0) {
    console.log(`[sign-windows] no .exe/.dll targets found under ${appOutDir}`);
    return;
  }

  console.log(
    `[sign-windows] signing ${targets.length} target(s) under ${appOutDir} ` +
      `(timestamp=${timestampUrl})`,
  );
  for (const file of targets) {
    runSign({ certPath, certPassword, timestampUrl, file });
    console.log(`[sign-windows] OK ${file}`);
  }

  // Task #116 — post-sign verification pass. Runs `signtool verify /pa`
  // on every signed artifact; fails the build on any invalid signature.
  // Load-bearing for the daemon binary (`daemon\ccsm-daemon.exe`) which
  // before Task #116 was already collected by extension but never
  // verified — a corrupt timestamp server response or expired cert chain
  // would otherwise ship a "signed but invalid" installer.
  console.log(`[sign-windows] verifying ${targets.length} target(s) (signtool verify /pa)`);
  for (const file of targets) {
    runVerify({ file });
    console.log(`[sign-windows] verify OK ${file}`);
  }
}

module.exports = signWindowsHook;
module.exports.default = signWindowsHook;
module.exports.buildSignArgs = buildSignArgs;
module.exports.collectTargets = collectTargets;
module.exports.runSign = runSign;
module.exports.buildVerifyArgs = buildVerifyArgs;
module.exports.runVerify = runVerify;
module.exports.DEFAULT_TIMESTAMP_URL = DEFAULT_TIMESTAMP_URL;
