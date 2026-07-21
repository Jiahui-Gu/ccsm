import { describe, expect, it } from 'vitest';

import { classifyMobileRequest } from '../../src/mobile/serviceWorkerPolicy';

describe('mobile service worker cache policy', () => {
  it('always fetches navigations and HTML from the network', () => {
    expect(
      classifyMobileRequest({
        mode: 'navigate',
        url: 'https://relay.example/',
      }),
    ).toBe('network-only');
    expect(
      classifyMobileRequest({
        mode: 'same-origin',
        url: 'https://relay.example/index.html',
      }),
    ).toBe('network-only');
  });

  it('cache-first serves only content-hashed JavaScript and CSS assets', () => {
    expect(
      classifyMobileRequest({
        mode: 'same-origin',
        url: 'https://relay.example/phone.0123456789abcdef.js',
      }),
    ).toBe('cache-first');
    expect(
      classifyMobileRequest({
        mode: 'same-origin',
        url: 'https://relay.example/phone.abcdef123456.css',
      }),
    ).toBe('cache-first');
    expect(
      classifyMobileRequest({
        mode: 'same-origin',
        url: 'https://relay.example/manifest.webmanifest',
      }),
    ).toBe('network-only');
    expect(
      classifyMobileRequest({
        mode: 'same-origin',
        url: 'https://relay.example/phone.js',
      }),
    ).toBe('network-only');
  });
});
