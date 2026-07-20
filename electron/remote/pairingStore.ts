import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import {
  generatePairingIdentity,
  type PairingIdentity,
} from '../../src/shared/mobileRemote';

const PAIRING_FILE = 'mobile-remote-pairing.bin';
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

type SafeStorageLike = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

type PairingFiles = {
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer, options: { mode: number }): Promise<unknown>;
  unlink(path: string): Promise<unknown>;
};

export type PairingStore = {
  loadOrCreate(): Promise<PairingIdentity | null>;
  delete(): Promise<void>;
};

export type PairingStoreOptions = {
  safeStorage?: SafeStorageLike;
  userDataPath?: string;
  files?: PairingFiles;
  generateIdentity?: () => PairingIdentity;
};

function isPairingIdentity(value: unknown): value is PairingIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.roomId === 'string' &&
    BASE64URL_32_BYTES.test(candidate.roomId) &&
    typeof candidate.secret === 'string' &&
    BASE64URL_32_BYTES.test(candidate.secret)
  );
}

export function createPairingStore(options: PairingStoreOptions = {}): PairingStore {
  const storage = options.safeStorage ?? safeStorage;
  const userDataPath = options.userDataPath ?? app.getPath('userData');
  const files = options.files ?? fs;
  const generateIdentity = options.generateIdentity ?? generatePairingIdentity;
  const filePath = path.join(userDataPath, PAIRING_FILE);

  return {
    async loadOrCreate() {
      if (!storage.isEncryptionAvailable()) return null;

      try {
        const encrypted = await files.readFile(filePath);
        const decoded = JSON.parse(storage.decryptString(encrypted)) as unknown;
        if (!isPairingIdentity(decoded)) throw new Error('invalid_pairing');
        return decoded;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }

      const pairing = generateIdentity();
      if (!isPairingIdentity(pairing)) throw new Error('invalid_pairing');
      const encrypted = storage.encryptString(JSON.stringify(pairing));
      await files.writeFile(filePath, encrypted, { mode: 0o600 });
      return pairing;
    },

    async delete() {
      try {
        await files.unlink(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
  };
}
