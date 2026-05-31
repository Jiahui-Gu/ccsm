import { describe, it, expect, vi } from 'vitest';
import { loginWithGithub } from '../oauthLogin';
import type { SessionStore, StoredSession } from '../sessionStore';

function memStore(): SessionStore & { saved: StoredSession | null } {
  let saved: StoredSession | null = null;
  return {
    load: () => saved,
    save: (s) => {
      saved = s;
    },
    clear: () => {
      saved = null;
    },
    isPersistAvailable: () => true,
    get saved() {
      return saved;
    },
  } as SessionStore & { saved: StoredSession | null };
}

const ORIGIN = 'https://ccsm-worker.example.workers.dev';

describe('loginWithGithub', () => {
  it('exchanges authCode and persists session', async () => {
    const store = memStore();
    const fetchSession = vi.fn(async () => ({
      token: 'SESS',
      userHash: 'uh',
      doUrl: 'wss://w/do/uh',
      iceServers: [],
      expiresInSeconds: 900,
    }));
    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const state = await loginWithGithub({
      workerOrigin: ORIGIN,
      runPopup: async () => ({ authCode: 'AC' }),
      fetchSession,
      store,
    });

    expect(fetchSession).toHaveBeenCalledWith(ORIGIN, 'AC');
    expect(store.saved).toEqual({
      token: 'SESS',
      doUrl: 'wss://w/do/uh',
      userHash: 'uh',
      expiresAtMs: now + 900_000,
    });
    expect(state).toEqual({
      loggedIn: true,
      userHash: 'uh',
      expiresAtMs: now + 900_000,
      persisted: true,
    });
    vi.restoreAllMocks();
  });

  it('returns logged-out state and saves nothing when popup rejects', async () => {
    const store = memStore();
    const state = await loginWithGithub({
      workerOrigin: ORIGIN,
      runPopup: async () => {
        throw new Error('cancelled');
      },
      fetchSession: vi.fn(),
      store,
    });
    expect(store.saved).toBeNull();
    expect(state.loggedIn).toBe(false);
  });
});
