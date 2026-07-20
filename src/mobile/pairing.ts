/* global IDBDatabase, IDBRequest, URLSearchParams, history, indexedDB, location */

import type { PairingIdentity } from '../shared/mobileRemote';

const DATABASE_NAME = 'ccsm-mobile-remote';
const STORE_NAME = 'pairing';
const PAIRING_KEY = 'current';
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

export type PairingStore = {
  get(): Promise<PairingIdentity | null>;
  put(pairing: PairingIdentity): Promise<void>;
};

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexeddb_error'));
  });
}

async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexeddb_error'));
  });
}

export function createPairingStore(): PairingStore {
  return {
    async get() {
      const database = await openDatabase();
      try {
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const result = await requestResult<PairingIdentity | undefined>(
          transaction.objectStore(STORE_NAME).get(PAIRING_KEY),
        );
        return result ?? null;
      } finally {
        database.close();
      }
    },
    async put(pairing) {
      const database = await openDatabase();
      try {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        await requestResult(transaction.objectStore(STORE_NAME).put(pairing, PAIRING_KEY));
      } finally {
        database.close();
      }
    },
  };
}

export function parsePairingFragment(fragment: string): PairingIdentity | null {
  const parameters = new URLSearchParams(fragment.replace(/^#/, ''));
  const capability = parameters.get('pair');
  if (capability === null) return null;
  const separator = capability.indexOf('.');
  if (separator < 0) throw new Error('invalid_pairing');
  const roomId = capability.slice(0, separator);
  const secret = capability.slice(separator + 1);
  if (!BASE64URL_32_BYTES.test(roomId) || !BASE64URL_32_BYTES.test(secret)) {
    throw new Error('invalid_pairing');
  }
  return { roomId, secret };
}

export async function importPairingFromFragment(
  store: PairingStore,
): Promise<PairingIdentity | null> {
  const pairing = parsePairingFragment(location.hash);
  if (!pairing) return store.get();
  await store.put(pairing);
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  return pairing;
}
