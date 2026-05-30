// src/mobile/githubLogin.ts
/** The Worker completes the GitHub OAuth web flow (it holds the client secret)
 *  and redirects the PWA back with a short-lived session JWT on the URL. The
 *  phone never sees the GitHub access token — minimal privilege (detail spec
 *  §4.1). This module is the pure token/URL plumbing around that. */

export function readSessionToken(locationSearch: string): string | null {
  return new URLSearchParams(locationSearch).get('token');
}

export function buildLoginUrl(workerOrigin: string, redirectUri: string): string {
  const url = new URL('/auth/github/login', workerOrigin);
  url.searchParams.set('redirect_uri', redirectUri);
  return url.toString();
}
