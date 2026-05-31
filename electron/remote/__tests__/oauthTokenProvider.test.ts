import { describe, it, expect } from 'vitest';
import { createOauthTokenProvider } from '../oauthTokenProvider';
import type { SessionStore, StoredSession } from '../sessionStore';

function storeWith(s: StoredSession | null): SessionStore {
  return { load: () => s, save: () => {}, clear: () => {}, isPersistAvailable: () => true };
}

describe('oauthTokenProvider', () => {
  it('returns {token,doUrl} for a fresh session', () => {
    const p = createOauthTokenProvider(
      storeWith({ token: 'T', doUrl: 'wss://d', userHash: 'h', expiresAtMs: Date.now() + 60_000 }),
    );
    expect(p()).toEqual({ token: 'T', doUrl: 'wss://d' });
  });
  it('returns null for an expired session', () => {
    const p = createOauthTokenProvider(
      storeWith({ token: 'T', doUrl: 'wss://d', userHash: 'h', expiresAtMs: Date.now() - 1 }),
    );
    expect(p()).toBeNull();
  });
  it('returns null when no session', () => {
    expect(createOauthTokenProvider(storeWith(null))()).toBeNull();
  });
});
