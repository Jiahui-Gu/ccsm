import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionStore, type StoredSession } from '../sessionStore';

// Fake safeStorage: "encrypts" by base64 so we exercise encode/decode paths.
function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  } as unknown as typeof import('electron').safeStorage;
}

const sample: StoredSession = {
  token: 'JWT',
  doUrl: 'wss://w/do/abc',
  userHash: 'abc',
  expiresAtMs: 1_000_000,
};

describe('sessionStore', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ccsm-ss-'));
    file = join(dir, 's.bin');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips save → load', () => {
    const store = createSessionStore({ filePath: file, safeStorage: fakeSafeStorage() });
    store.save(sample);
    expect(store.load()).toEqual(sample);
  });

  it('load returns null when file missing', () => {
    const store = createSessionStore({ filePath: file, safeStorage: fakeSafeStorage() });
    expect(store.load()).toBeNull();
  });

  it('clear removes the session', () => {
    const store = createSessionStore({ filePath: file, safeStorage: fakeSafeStorage() });
    store.save(sample);
    store.clear();
    expect(store.load()).toBeNull();
  });

  it('load returns null on decrypt failure', () => {
    const broken = {
      ...fakeSafeStorage(),
      decryptString: () => {
        throw new Error('bad');
      },
    } as unknown as typeof import('electron').safeStorage;
    const good = createSessionStore({ filePath: file, safeStorage: fakeSafeStorage() });
    good.save(sample);
    const bad = createSessionStore({ filePath: file, safeStorage: broken });
    expect(bad.load()).toBeNull();
  });

  it('save no-ops and persisted is false when encryption unavailable', () => {
    const store = createSessionStore({ filePath: file, safeStorage: fakeSafeStorage(false) });
    store.save(sample);
    expect(store.load()).toBeNull();
    expect(store.isPersistAvailable()).toBe(false);
  });
});
