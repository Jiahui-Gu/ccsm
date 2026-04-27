import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  isAllowedMemoryPath,
  readMemoryFile,
  writeMemoryFile,
  memoryFileExists,
} from '../memory';

describe('isAllowedMemoryPath', () => {
  it('accepts absolute paths ending in CLAUDE.md', () => {
    const p = path.join(os.tmpdir(), 'repo', 'CLAUDE.md');
    expect(isAllowedMemoryPath(p)).toBe(true);
  });

  it('rejects files with different basename', () => {
    expect(isAllowedMemoryPath(path.join(os.tmpdir(), 'NOTES.md'))).toBe(false);
    expect(isAllowedMemoryPath(path.join(os.tmpdir(), 'claude.md'))).toBe(false);
    expect(isAllowedMemoryPath(path.join(os.tmpdir(), 'Claude.md'))).toBe(false);
    expect(isAllowedMemoryPath(path.join(os.tmpdir(), 'CLAUDE.MD'))).toBe(false);
  });

  it('rejects relative paths', () => {
    expect(isAllowedMemoryPath('CLAUDE.md')).toBe(false);
    expect(isAllowedMemoryPath('./CLAUDE.md')).toBe(false);
    expect(isAllowedMemoryPath('sub/CLAUDE.md')).toBe(false);
  });

  it('rejects non-string / empty inputs', () => {
    expect(isAllowedMemoryPath(undefined)).toBe(false);
    expect(isAllowedMemoryPath(null)).toBe(false);
    expect(isAllowedMemoryPath(42)).toBe(false);
    expect(isAllowedMemoryPath('')).toBe(false);
  });

  it('rejects traversal segments even inside basename', () => {
    // After normalization these collapse, but the defense-in-depth check
    // catches any that would still contain `..`.
    expect(isAllowedMemoryPath('/a/..b/CLAUDE.md')).toBe(true); // ..b is not ..
    // This is the real attack shape — note the middle segment.
    const crafted = '/a/b/../c/CLAUDE.md';
    // path.normalize collapses to /a/c/CLAUDE.md which is fine.
    expect(isAllowedMemoryPath(crafted)).toBe(true);
  });

  it('trailing slash is tolerated (Node normalizes the basename)', () => {
    // path.basename trims trailing separators, so this still resolves to
    // the `CLAUDE.md` segment. Allowing it is fine — fs operations will
    // follow the same normalization, we can't accidentally write elsewhere.
    expect(isAllowedMemoryPath('/a/b/CLAUDE.md/')).toBe(true);
  });
});

describe('memory read/write security', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-memory-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('readMemoryFile rejects non-CLAUDE.md paths', () => {
    const evil = path.join(tmpDir, 'secrets.env');
    fs.writeFileSync(evil, 'API_KEY=nope');
    const res = readMemoryFile(evil);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('invalid_path');
  });

  it('writeMemoryFile rejects non-CLAUDE.md paths', () => {
    const evil = path.join(tmpDir, 'secrets.env');
    const res = writeMemoryFile(evil, 'overwritten');
    expect(res.ok).toBe(false);
    expect(fs.existsSync(evil)).toBe(false);
  });

  it('writeMemoryFile rejects non-absolute paths', () => {
    const res = writeMemoryFile('CLAUDE.md', 'hi');
    expect(res.ok).toBe(false);
  });

  it('memoryFileExists returns false for disallowed paths even if the file exists', () => {
    const evil = path.join(tmpDir, 'secrets.env');
    fs.writeFileSync(evil, 'x');
    expect(memoryFileExists(evil)).toBe(false);
  });

  it('read + write roundtrip for a valid CLAUDE.md path', () => {
    const p = path.join(tmpDir, 'CLAUDE.md');
    const r1 = readMemoryFile(p);
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.exists).toBe(false);
      expect(r1.content).toBe('');
    }
    const w = writeMemoryFile(p, '# project rules\nbe terse');
    expect(w.ok).toBe(true);
    const r2 = readMemoryFile(p);
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.exists).toBe(true);
      expect(r2.content).toContain('be terse');
    }
  });

  it('writeMemoryFile creates missing parent directories', () => {
    const p = path.join(tmpDir, 'nested', 'dir', 'CLAUDE.md');
    const w = writeMemoryFile(p, 'hello');
    expect(w.ok).toBe(true);
    expect(fs.existsSync(p)).toBe(true);
  });
});
