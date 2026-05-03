// packages/daemon/test/lock/segmentation-cadence.spec.ts
//
// FOREVER-STABLE per docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
// chapter 15 §3 item #26 (and chapter 06 §3 / §4 narrative lock).
//
// Locks two invariants for the pty delta-segmentation + snapshot cadence:
//
//   1. SINGLE SOURCE FILE. All cadence constants live in exactly one file:
//      `packages/daemon/src/pty/segmentation.ts`. The numeric literals that
//      define the cadence (16ms timeout, 16 KiB byte cap, K_TIME=30s,
//      M_DELTAS=256, B_BYTES=1 MiB) MUST NOT appear anywhere else under
//      `packages/daemon/src/`. This is what makes the cadence per-session
//      (one emitter, one set of constants, broadcast to N subscribers as
//      identical byte ranges) — see ch06 §3 "Segmentation cadence is
//      per-session".
//
//   2. NO PER-SUBSCRIBER KNOBS. No function / method / RPC field anywhere
//      under `packages/daemon/src/pty*` (or the AttachRequest proto) accepts
//      a `cadence` / `segmentation` / `snapshot` parameter that would let a
//      caller override the per-session cadence. v0.4 client-side coalescing
//      for high-latency transports happens in the client renderer, never on
//      the daemon emitter.
//
// `packages/daemon/src/pty/segmentation.ts` is created later by Task #43
// (T4.10 delta segmenter) and Task #50 (T4.9 snapshot cadence). Until those
// land, the entire describe block auto-skips via `describe.skipIf` — same
// shape as `test/db/migration-lock.spec.ts` (which gates on `locked.ts`).
//
// The grep-based forbidden-literal check is deliberately TEXT-LEVEL (not
// AST-level): the spec asserts a structural property of the source tree,
// not runtime behavior. AST parsing would couple this lock to a TypeScript
// version and add a heavy dep for no reliability gain.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DAEMON_ROOT = resolve(__dirname, '..', '..');
const SRC_ROOT = join(DAEMON_ROOT, 'src');
const CADENCE_FILE_REL = join('pty', 'segmentation.ts');
const CADENCE_FILE_ABS = join(SRC_ROOT, CADENCE_FILE_REL);
const PROTO_PTY_PATH = resolve(
  DAEMON_ROOT,
  '..',
  'proto',
  'src',
  'ccsm',
  'v1',
  'pty.proto',
);

// Walk a directory and yield every .ts file (excluding .d.ts and test/spec
// files — locks are about runtime source, not test fixtures that may
// legitimately reference the magic numbers).
function* walkTs(root: string): Generator<string> {
  for (const entry of readdirSync(root)) {
    const abs = join(root, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      // Skip nested __tests__ + .spec.ts files — they may reference
      // constants for assertions, which is allowed.
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') {
        continue;
      }
      yield* walkTs(abs);
    } else if (
      st.isFile() &&
      entry.endsWith('.ts') &&
      !entry.endsWith('.d.ts') &&
      !entry.endsWith('.spec.ts') &&
      !entry.endsWith('.bench.ts')
    ) {
      yield abs;
    }
  }
}

const cadenceFileExists = existsSync(CADENCE_FILE_ABS);

describe.skipIf(!cadenceFileExists)(
  'pty segmentation cadence (single source file lock)',
  () => {
    it('exports the cadence constants from packages/daemon/src/pty/segmentation.ts', () => {
      const src = readFileSync(CADENCE_FILE_ABS, 'utf8');

      // Required exported names. The spec ch06 §3-§4 names them; whatever
      // shape the file ships (individual `export const` or grouped object
      // like `export const PTY_CADENCE = {...}`), each name must appear as
      // an exported identifier so consumers import from one place.
      const requiredNames = [
        'SEGMENTATION_TIMEOUT_MS', // 16
        'SEGMENTATION_BYTE_CAP', // 16384 (16 KiB)
        'K_TIME_MS', // 30_000
        'M_DELTAS', // 256
        'B_BYTES', // 1_048_576 (1 MiB)
      ];

      for (const name of requiredNames) {
        expect(
          src,
          `expected ${name} to be exported from ${CADENCE_FILE_REL}`,
        ).toMatch(new RegExp(`\\bexport\\b[\\s\\S]{0,80}\\b${name}\\b`));
      }
    });

    it('contains the spec-mandated numeric literals (16, 16384, 30000, 256, 1048576)', () => {
      const src = readFileSync(CADENCE_FILE_ABS, 'utf8');
      // Tolerate underscore separators and hex; just assert each canonical
      // value appears textually somewhere in the file. The single-source
      // grep below is the negative half of the lock.
      const expected = [
        /\b16\b/, // SEGMENTATION_TIMEOUT_MS
        /\b16[_]?384\b|\b16\s*\*\s*1024\b/, // 16 KiB cap
        /\b30[_]?000\b|\b30\s*\*\s*1000\b/, // K_TIME_MS
        /\b256\b/, // M_DELTAS
        /\b1[_]?048[_]?576\b|\b1\s*\*\s*1024\s*\*\s*1024\b|\b1024\s*\*\s*1024\b/, // B_BYTES
      ];
      for (const re of expected) {
        expect(
          src,
          `${CADENCE_FILE_REL} missing spec-mandated literal matching ${re}`,
        ).toMatch(re);
      }
    });

    it('is the only source file under packages/daemon/src/ that defines these cadence literals', () => {
      // Forbid the cadence literals appearing in any OTHER src file. We use
      // narrow, specific patterns (the byte caps + K/M/B identifiers) so we
      // do not falsely flag every "16" in the codebase.
      //
      // Patterns chosen to be tight: the bare "16" and "256" alone are
      // far too common, so we anchor on the BYTE CAP (16384 / 16*1024) and
      // the named identifier exports (K_TIME_MS / M_DELTAS / B_BYTES /
      // SEGMENTATION_*).
      const forbiddenPatterns: Array<{ name: string; re: RegExp }> = [
        { name: 'SEGMENTATION_TIMEOUT_MS', re: /\bSEGMENTATION_TIMEOUT_MS\b/ },
        { name: 'SEGMENTATION_BYTE_CAP', re: /\bSEGMENTATION_BYTE_CAP\b/ },
        { name: 'K_TIME_MS', re: /\bK_TIME_MS\b/ },
        { name: 'M_DELTAS', re: /\bM_DELTAS\b/ },
        { name: 'B_BYTES', re: /\bB_BYTES\b/ },
        // Numeric literal for the 16 KiB byte cap — uniquely identifies
        // the cadence (the daemon has no other reason to mention 16384).
        { name: '16384 literal', re: /\b16384\b|\b16\s*\*\s*1024\b/ },
      ];

      const offenders: Array<{ file: string; pattern: string; line: string }> =
        [];

      for (const file of walkTs(SRC_ROOT)) {
        if (file === CADENCE_FILE_ABS) continue;
        const text = readFileSync(file, 'utf8');
        const lines = text.split(/\r?\n/);
        for (const { name, re } of forbiddenPatterns) {
          // Skip patterns that are pure imports of the canonical module —
          // consumers MUST be able to import the named exports. Imports
          // are the legal way to reference these constants.
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!re.test(line)) continue;
            // Allow `import ... from '.../pty/segmentation'` (and re-exports).
            if (
              /\bfrom\s+['"][^'"]*pty\/segmentation(\.js)?['"]/.test(line) ||
              /^\s*export\s+\{[^}]*\}\s+from\s+['"][^'"]*pty\/segmentation/.test(
                line,
              )
            ) {
              continue;
            }
            offenders.push({
              file: relative(DAEMON_ROOT, file).split(sep).join('/'),
              pattern: name,
              line: line.trim(),
            });
          }
        }
      }

      expect(
        offenders,
        `cadence constants/literals MUST live only in ${CADENCE_FILE_REL}; ` +
          `found ${offenders.length} stray reference(s):\n` +
          offenders
            .map((o) => `  - ${o.file}: [${o.pattern}] ${o.line}`)
            .join('\n'),
      ).toEqual([]);
    });
  },
);

// The per-subscriber-knob ban runs UNCONDITIONALLY — it asserts a property
// of the proto + any pty-host source that already exists. Even before
// segmentation.ts lands (#43/#50), v0.3 must not introduce a per-subscriber
// override anywhere. This is the ch15 §3 #26 forbidden pattern in code form.
describe('pty segmentation cadence (no per-subscriber knobs)', () => {
  it('AttachRequest proto has no segmentation/cadence/snapshot override field', () => {
    if (!existsSync(PROTO_PTY_PATH)) {
      // Proto package layout may shift; skip rather than false-fail.
      return;
    }
    const proto = readFileSync(PROTO_PTY_PATH, 'utf8');
    const match = proto.match(/message\s+AttachRequest\s*\{([\s\S]*?)\}/);
    expect(match, 'AttachRequest message not found in pty.proto').toBeTruthy();
    const body = match![1];
    // Forbidden field names that would let a caller override the cadence.
    const forbidden = [
      /\bcadence\b/i,
      /\bsegmentation\b/i,
      /\bsnapshot_(interval|cadence|knob|override)\b/i,
      /\b(timeout_ms|byte_cap|chunk_size|chunk_ms)\b/i,
    ];
    for (const re of forbidden) {
      expect(
        body,
        `AttachRequest must not expose per-subscriber knob matching ${re}`,
      ).not.toMatch(re);
    }
  });

  it('no function / method in packages/daemon/src/ accepts a cadence|segmentation|snapshot parameter', () => {
    // Look for parameter names like `(cadence: ...)`, `(segmentation: ...)`,
    // or destructured option bags `{ cadence, ... }` in function/method
    // signatures under daemon src. The cadence file itself is allowed to
    // export functions PARAMETERIZED on these (e.g. a factory taking a
    // `PTY_CADENCE` for testability) — exemption is handled by skipping
    // the canonical file path.
    //
    // Pattern: look for tokens 'cadence' / 'segmentation' (word-bound,
    // case-insensitive) appearing inside what looks like a function/method
    // signature. We approximate "signature" by matching lines containing
    // both an identifier-like keyword and a colon-typed parameter, OR by
    // matching destructured `{ cadence` / `{ segmentation` patterns.

    const signatureLikePatterns: Array<{ name: string; re: RegExp }> = [
      // `cadence:` / `segmentation:` / `snapshotCadence:` as a typed param
      { name: 'cadence: typed param', re: /\bcadence\s*[:?]\s*\w/i },
      {
        name: 'segmentation: typed param',
        re: /\bsegmentation\s*[:?]\s*\w/i,
      },
      // destructured option-bag entry
      {
        name: '{ cadence } destructure',
        re: /\{\s*[^}]*\bcadence\b[^}]*\}\s*[:=]/i,
      },
      {
        name: '{ segmentation } destructure',
        re: /\{\s*[^}]*\bsegmentation\b[^}]*\}\s*[:=]/i,
      },
    ];

    const offenders: Array<{ file: string; pattern: string; line: string }> =
      [];

    for (const file of walkTs(SRC_ROOT)) {
      // The canonical cadence file is the ONE place a `cadence:` typed
      // shape may legitimately exist (e.g. an exported `PtyCadence` type).
      if (file === CADENCE_FILE_ABS) continue;
      const text = readFileSync(file, 'utf8');
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip pure comment lines — narrative references in JSDoc are fine.
        const trimmed = line.trim();
        if (
          trimmed.startsWith('//') ||
          trimmed.startsWith('*') ||
          trimmed.startsWith('/*')
        ) {
          continue;
        }
        for (const { name, re } of signatureLikePatterns) {
          if (re.test(line)) {
            offenders.push({
              file: relative(DAEMON_ROOT, file).split(sep).join('/'),
              pattern: name,
              line: trimmed,
            });
          }
        }
      }
    }

    expect(
      offenders,
      `pty-host functions/methods MUST NOT accept per-subscriber cadence/segmentation parameters; ` +
        `found ${offenders.length} offending signature(s):\n` +
        offenders
          .map((o) => `  - ${o.file}: [${o.pattern}] ${o.line}`)
          .join('\n'),
    ).toEqual([]);
  });
});
