// electron/remote/oauthTokenProvider.ts
import type { TokenProvider } from './tokenProvider';
import type { SessionStore } from './sessionStore';

export function createOauthTokenProvider(store: SessionStore): TokenProvider {
  return () => {
    const s = store.load();
    if (!s || s.expiresAtMs <= Date.now()) return null;
    return { token: s.token, doUrl: s.doUrl };
  };
}
