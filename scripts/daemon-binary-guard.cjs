// Task #114 — daemon binary integrity guard.
//
// Asserts that a packaged daemon binary file is (a) present, (b) at least
// MIN_SIZE_BYTES large, and (c) starts with the expected platform magic
// bytes (PE / Mach-O / ELF). Catches three failure modes that all shipped
// to dogfood worker #14 at one point or another:
//
//   1. Zero-byte binary — pkg invocation crashed mid-write but the run
//      script returned 0 because a previous successful build left a stale
//      file path that pkg truncated.
//   2. Placeholder marker — `before-pack.cjs` falls back to a ~200-byte
//      text file when the real binary is missing, so smoke builds still
//      copy *something*. Zero-byte gate alone misses this; size>=1MiB does.
//   3. Wrong-platform binary — a Linux-host CI leg accidentally picked up
//      a macOS Mach-O from a previous local build sitting in daemon/dist/.
//      Magic-byte sniff catches this before electron-builder happily wraps
//      a Mach-O inside an MSI.
//
// Coupling boundaries: this guard does NOT verify signatures (PR #116 owns
// that), does NOT verify symbols, does NOT execute the binary. It is a pure
// metadata + first-N-bytes check, safe to run anywhere a file is readable.
//
// The 1 MiB threshold is intentionally far below the real ~108 MB pkg
// output (PR #781 measurement on Win/x64) but far above placeholder marker
// files (~200 bytes) and any plausible truncated-write artifact.

const fs = require('node:fs');

// 1 MiB. Real daemon binary is ~108 MB on every platform (pkg + Node 22
// runtime + native asset payload). Anything under 1 MiB is definitionally
// either a placeholder, a truncated write, or a non-binary file.
const MIN_SIZE_BYTES = 1 * 1024 * 1024;

// Magic-byte signatures for each platform's executable format. We only
// look at the first 4 bytes — enough to disambiguate ELF / Mach-O / PE.
//
//   ELF      : 7F 45 4C 46                (Linux)
//   Mach-O   : FE ED FA CE / FE ED FA CF / CA FE BA BE (fat) / CF FA ED FE
//              / CE FA ED FE  (little-endian variants)
//              -- pkg currently emits CF FA ED FE (Mach-O 64-bit LE) for
//                 macOS x64 + arm64 single-arch outputs.
//   PE       : 4D 5A ('MZ')               (Windows DOS header)
const MAGIC = {
  win32: [
    { name: 'PE/MZ', bytes: [0x4d, 0x5a] },
  ],
  darwin: [
    { name: 'Mach-O 64 LE (CFFAEDFE)', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
    { name: 'Mach-O 32 LE (CEFAEDFE)', bytes: [0xce, 0xfa, 0xed, 0xfe] },
    { name: 'Mach-O 64 BE (FEEDFACF)', bytes: [0xfe, 0xed, 0xfa, 0xcf] },
    { name: 'Mach-O 32 BE (FEEDFACE)', bytes: [0xfe, 0xed, 0xfa, 0xce] },
    { name: 'Mach-O FAT (CAFEBABE)', bytes: [0xca, 0xfe, 0xba, 0xbe] },
  ],
  linux: [
    { name: 'ELF', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  ],
};

function readHead(filePath, n) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function matchesAny(head, sigs) {
  for (const sig of sigs) {
    if (head.length < sig.bytes.length) continue;
    let ok = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (head[i] !== sig.bytes[i]) { ok = false; break; }
    }
    if (ok) return sig.name;
  }
  return null;
}

function hex(buf) {
  return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

/**
 * Assert the file at `filePath` is a sane daemon binary for `platform`.
 * Throws Error with a human-readable diagnostic on any failure.
 *
 * @param {string} filePath  Absolute path to the daemon binary.
 * @param {'win32'|'darwin'|'linux'} platform  electron-builder platform name.
 * @param {object} [opts]
 * @param {number} [opts.minSize]  Override minimum-size threshold (bytes).
 *                                 Default MIN_SIZE_BYTES (1 MiB).
 * @param {boolean} [opts.skipMagic]  Skip magic-byte sniff (e.g. for a
 *                                    cross-host CI gate where the host
 *                                    OS can't be inferred from the file).
 *                                    Default false.
 */
function assertDaemonBinary(filePath, platform, opts = {}) {
  const minSize = opts.minSize ?? MIN_SIZE_BYTES;
  const skipMagic = opts.skipMagic === true;

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `[daemon-binary-guard] daemon binary missing: ${filePath}\n` +
        `  Expected platform: ${platform}\n` +
        `  Hint: run \`npm run build:daemon-bin\` (frag-11 §11.1) before packaging.`,
    );
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(
      `[daemon-binary-guard] daemon binary is not a regular file: ${filePath} (mode=${stat.mode.toString(8)})`,
    );
  }

  if (stat.size === 0) {
    throw new Error(
      `[daemon-binary-guard] daemon binary is zero-byte: ${filePath}\n` +
        `  Hint: a previous build crashed mid-write or pkg silently failed. ` +
        `Re-run \`npm run build:daemon-bin\` from a clean tree.`,
    );
  }

  if (stat.size < minSize) {
    // Distinguish placeholder marker (text file written by before-pack.cjs
    // when the real binary is absent) from generic too-small.
    let head = '';
    try {
      head = readHead(filePath, Math.min(256, stat.size)).toString('utf8');
    } catch { /* unreadable head — fall through with empty head */ }
    const looksLikePlaceholder = /placeholder/i.test(head);
    throw new Error(
      `[daemon-binary-guard] daemon binary suspiciously small: ${filePath}\n` +
        `  Size: ${stat.size} bytes (minimum ${minSize} bytes / ${(minSize / 1024 / 1024).toFixed(1)} MiB)\n` +
        (looksLikePlaceholder
          ? `  Detected placeholder marker text in file head — before-pack.cjs ` +
            `fell back because daemon/dist/ccsm-daemon-* was absent. ` +
            `Run \`npm run build:daemon-bin\` then re-package.\n`
          : `  Hint: real pkg-bundled daemon is ~108 MB. This file is almost ` +
            `certainly a truncated write or wrong-target artifact.\n`),
    );
  }

  if (skipMagic) return { size: stat.size, magic: null };

  const sigs = MAGIC[platform];
  if (!sigs) {
    throw new Error(
      `[daemon-binary-guard] unknown platform for magic-byte check: ${platform} ` +
        `(expected win32/darwin/linux)`,
    );
  }
  const head = readHead(filePath, 8);
  const matched = matchesAny(head, sigs);
  if (!matched) {
    const expected = sigs.map((s) => s.name).join(' OR ');
    throw new Error(
      `[daemon-binary-guard] daemon binary magic-byte mismatch: ${filePath}\n` +
        `  Expected: ${expected} (platform=${platform})\n` +
        `  Got first ${head.length} bytes: ${hex(head)}\n` +
        `  Hint: this file is likely a binary built for the wrong platform ` +
        `(e.g. macOS Mach-O picked up on a Linux runner) or not an executable ` +
        `at all (e.g. an esbuild bundle that pkg never wrapped).`,
    );
  }

  return { size: stat.size, magic: matched };
}

module.exports = {
  assertDaemonBinary,
  MIN_SIZE_BYTES,
  // Exposed for unit tests that want to drive the matcher directly.
  _internals: { MAGIC, readHead, matchesAny },
};
