// electron/remote/sessionStore.ts
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import type { MobileRemoteLogin } from './tokenProvider';

export type StoredSession = MobileRemoteLogin & { userHash: string; expiresAtMs: number };

export type SessionStore = {
  load(): StoredSession | null;
  save(s: StoredSession): void;
  clear(): void;
  isPersistAvailable(): boolean;
};

type SafeStorage = typeof import('electron').safeStorage;

export function createSessionStore(deps: {
  filePath: string;
  safeStorage: SafeStorage;
}): SessionStore {
  const { filePath, safeStorage } = deps;
  const available = () => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  };
  return {
    isPersistAvailable: available,
    save(s) {
      if (!available()) return;
      try {
        writeFileSync(filePath, safeStorage.encryptString(JSON.stringify(s)));
      } catch {
        /* ignore */
      }
    },
    load() {
      try {
        const buf = readFileSync(filePath);
        const json = safeStorage.decryptString(buf);
        return JSON.parse(json) as StoredSession;
      } catch {
        return null;
      }
    },
    clear() {
      try {
        rmSync(filePath, { force: true });
      } catch {
        /* ignore */
      }
    },
  };
}
