// src/mobile/__tests__/githubLogin.test.ts
import { describe, it, expect } from 'vitest';
import { readSessionToken, buildLoginUrl } from '../githubLogin';

describe('githubLogin', () => {
  it('reads the session token from the query string', () => {
    expect(readSessionToken('?token=abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('returns null when no token is present', () => {
    expect(readSessionToken('')).toBeNull();
    expect(readSessionToken('?foo=bar')).toBeNull();
  });

  it('url-decodes the token', () => {
    expect(readSessionToken('?token=a%2Bb')).toBe('a+b');
  });

  it('builds the GitHub login URL pointing at the Worker callback', () => {
    const url = buildLoginUrl('https://ccsm-worker.example.workers.dev', 'https://pwa.example/');
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://ccsm-worker.example.workers.dev');
    expect(parsed.pathname).toBe('/auth/github/login');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://pwa.example/');
  });
});
