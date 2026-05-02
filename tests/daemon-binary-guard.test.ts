// Task #114 — unit tests for scripts/daemon-binary-guard.cjs
//
// Covers each rejection branch (missing / not-a-file / zero-byte /
// below-threshold / placeholder-marker / wrong-magic / unknown-platform)
// and the happy path. The intent is that any future change to the guard's
// thresholds or magic table breaks at least one assertion here.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const guard = require('../scripts/daemon-binary-guard.cjs') as {
  assertDaemonBinary: (
    file: string,
    platform: string,
    opts?: { minSize?: number; skipMagic?: boolean },
  ) => { size: number; magic: string | null };
  MIN_SIZE_BYTES: number;
};

const PLATFORM_MAGIC: Record<string, number[]> = {
  win32: [0x4d, 0x5a],
  darwin: [0xcf, 0xfa, 0xed, 0xfe],
  linux: [0x7f, 0x45, 0x4c, 0x46],
};

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-t114-guard-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeBinary(name: string, size: number, magic?: number[]): string {
  const p = path.join(tmpRoot, name);
  const buf = Buffer.alloc(size);
  if (magic) {
    for (let i = 0; i < magic.length; i++) buf[i] = magic[i];
  }
  fs.writeFileSync(p, buf);
  return p;
}

describe('daemon-binary-guard: existence + file-type', () => {
  it('throws when the file does not exist', () => {
    const missing = path.join(tmpRoot, 'never-written.bin');
    expect(() => guard.assertDaemonBinary(missing, 'linux')).toThrow(
      /daemon binary missing/,
    );
  });

  it('throws when the path is a directory, not a file', () => {
    const d = path.join(tmpRoot, 'a-dir');
    fs.mkdirSync(d);
    expect(() => guard.assertDaemonBinary(d, 'linux')).toThrow(
      /not a regular file/,
    );
  });
});

describe('daemon-binary-guard: size enforcement', () => {
  it('throws on zero-byte daemon binary (the headline Task #114 bug)', () => {
    const p = writeBinary('zero.bin', 0);
    expect(() => guard.assertDaemonBinary(p, 'linux')).toThrow(/zero-byte/);
  });

  it('throws when smaller than the 1 MiB minimum', () => {
    const p = writeBinary('small.bin', 1024, PLATFORM_MAGIC.linux);
    expect(() => guard.assertDaemonBinary(p, 'linux')).toThrow(
      /suspiciously small/,
    );
  });

  it('detects placeholder marker text inside under-size files', () => {
    const p = path.join(tmpRoot, 'placeholder.bin');
    fs.writeFileSync(
      p,
      'placeholder: daemon binary for linux-x64 not yet built (T2 build glue pending).\n',
    );
    expect(() => guard.assertDaemonBinary(p, 'linux')).toThrow(
      /placeholder marker/,
    );
  });

  it('honours opts.minSize override (so happy-path tests can stay small)', () => {
    const p = writeBinary('tiny-but-magic.bin', 64, PLATFORM_MAGIC.linux);
    const r = guard.assertDaemonBinary(p, 'linux', { minSize: 32 });
    expect(r.size).toBe(64);
    expect(r.magic).toMatch(/ELF/);
  });
});

describe('daemon-binary-guard: magic-byte sniff', () => {
  const justAboveMin = guard.MIN_SIZE_BYTES + 16;

  it('accepts ELF on linux', () => {
    const p = writeBinary('elf.bin', justAboveMin, PLATFORM_MAGIC.linux);
    const r = guard.assertDaemonBinary(p, 'linux');
    expect(r.magic).toMatch(/ELF/);
  });

  it('accepts MZ/PE on win32', () => {
    const p = writeBinary('pe.exe', justAboveMin, PLATFORM_MAGIC.win32);
    const r = guard.assertDaemonBinary(p, 'win32');
    expect(r.magic).toMatch(/PE/);
  });

  it('accepts Mach-O 64 LE on darwin', () => {
    const p = writeBinary('macho.bin', justAboveMin, PLATFORM_MAGIC.darwin);
    const r = guard.assertDaemonBinary(p, 'darwin');
    expect(r.magic).toMatch(/Mach-O/);
  });

  it('rejects ELF when target platform is win32 (wrong-platform binary)', () => {
    const p = writeBinary('elf-as-pe.exe', justAboveMin, PLATFORM_MAGIC.linux);
    expect(() => guard.assertDaemonBinary(p, 'win32')).toThrow(
      /magic-byte mismatch/,
    );
  });

  it('rejects garbage header at the right size', () => {
    const p = writeBinary('garbage.bin', justAboveMin, [0x00, 0x01, 0x02, 0x03]);
    expect(() => guard.assertDaemonBinary(p, 'linux')).toThrow(
      /magic-byte mismatch/,
    );
  });

  it('throws on unknown platform name', () => {
    const p = writeBinary('any.bin', justAboveMin, PLATFORM_MAGIC.linux);
    expect(() => guard.assertDaemonBinary(p, 'plan9')).toThrow(
      /unknown platform/,
    );
  });

  it('opts.skipMagic bypasses the sniff but still enforces size', () => {
    const p = writeBinary('size-only.bin', justAboveMin, [0xde, 0xad, 0xbe, 0xef]);
    const r = guard.assertDaemonBinary(p, 'linux', { skipMagic: true });
    expect(r.magic).toBeNull();
    expect(r.size).toBe(justAboveMin);
  });
});

describe('daemon-binary-guard: artificial-zero regression scenario', () => {
  // The exact scenario the task asks for: build produces a real binary,
  // a later step (or a buggy hook) truncates it to zero bytes, the guard
  // must catch that before electron-builder packs it.
  it('passes on a fresh forged binary, then fails after we zero it', () => {
    const p = writeBinary(
      'ccsm-daemon-linux-x64',
      guard.MIN_SIZE_BYTES + 1024,
      PLATFORM_MAGIC.linux,
    );
    const r = guard.assertDaemonBinary(p, 'linux');
    expect(r.size).toBeGreaterThanOrEqual(guard.MIN_SIZE_BYTES);

    // Simulate the bug: a downstream step opens the binary with O_TRUNC
    // and never writes anything (e.g. a copy that fails after open()).
    fs.writeFileSync(p, '');
    expect(() => guard.assertDaemonBinary(p, 'linux')).toThrow(/zero-byte/);
  });
});
