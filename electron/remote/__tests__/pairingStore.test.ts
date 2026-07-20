import { describe, expect, it, vi } from 'vitest';

import { createPairingStore } from '../pairingStore';

const identity = {
  roomId: 'B'.repeat(43),
  secret: 'A'.repeat(43),
};

describe('desktop pairing store', () => {
  it('returns unavailable and writes no file when safe storage is unavailable', async () => {
    const writeFile = vi.fn();
    const store = createPairingStore({
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: vi.fn(),
        decryptString: vi.fn(),
      },
      userDataPath: 'user-data',
      files: {
        readFile: vi.fn(),
        writeFile,
        unlink: vi.fn(),
      },
      generateIdentity: () => identity,
    });

    await expect(store.loadOrCreate()).resolves.toBeNull();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('persists only encrypted bytes and reloads the same identity', async () => {
    let stored: Buffer | null = null;
    const files = {
      readFile: vi.fn(async () => {
        if (!stored) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return stored;
      }),
      writeFile: vi.fn(async (_path: string, bytes: Buffer) => {
        stored = Buffer.from(bytes);
      }),
      unlink: vi.fn(),
    };
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: vi.fn(() => Buffer.from('encrypted pairing bytes')),
      decryptString: vi.fn(() => JSON.stringify(identity)),
    };
    const generateIdentity = vi.fn(() => identity);
    const options = {
      safeStorage,
      userDataPath: 'user-data',
      files,
      generateIdentity,
    };

    const first = await createPairingStore(options).loadOrCreate();
    const second = await createPairingStore(options).loadOrCreate();

    expect(first).toEqual(identity);
    expect(second).toEqual(identity);
    expect(stored?.toString('utf8')).toBe('encrypted pairing bytes');
    expect(stored?.toString('utf8')).not.toContain(identity.roomId);
    expect(stored?.toString('utf8')).not.toContain(identity.secret);
    expect(files.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/mobile-remote-pairing\.bin$/),
      expect.any(Buffer),
      expect.objectContaining({ mode: 0o600 }),
    );
    expect(generateIdentity).toHaveBeenCalledTimes(1);
  });

  it('deletes corrupt encrypted content and persists a fresh identity', async () => {
    const writeFile = vi.fn();
    const unlink = vi.fn(async () => undefined);
    const store = createPairingStore({
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: vi.fn(() => Buffer.from('fresh ciphertext')),
        decryptString: () => JSON.stringify({ roomId: 'short', secret: 'also-short' }),
      },
      userDataPath: 'user-data',
      files: {
        readFile: async () => Buffer.from('ciphertext'),
        writeFile,
        unlink,
      },
      generateIdentity: () => identity,
    });

    await expect(store.loadOrCreate()).resolves.toEqual(identity);
    expect(unlink).toHaveBeenCalledWith(expect.stringMatching(/mobile-remote-pairing\.bin$/));
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/mobile-remote-pairing\.bin$/),
      Buffer.from('fresh ciphertext'),
      { mode: 0o600 },
    );
  });

  it('propagates non-corruption file read failures', async () => {
    const readError = Object.assign(new Error('access denied'), { code: 'EACCES' });
    const store = createPairingStore({
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: vi.fn(),
        decryptString: vi.fn(),
      },
      userDataPath: 'user-data',
      files: {
        readFile: async () => {
          throw readError;
        },
        writeFile: vi.fn(),
        unlink: vi.fn(),
      },
      generateIdentity: () => identity,
    });

    await expect(store.loadOrCreate()).rejects.toBe(readError);
  });
});
