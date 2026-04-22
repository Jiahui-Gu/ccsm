// Main-process notification i18n.
//
// `electron/i18n.ts` is plain Node — no React, no i18next. This test
// covers the contract: setMainLanguage flips the active catalog, and
// tNotification interpolates {{vars}} correctly.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setMainLanguage,
  getMainLanguage,
  tNotification,
  resolveSystemLanguage
} from '../i18n';

describe('main process i18n', () => {
  beforeEach(() => {
    setMainLanguage('en');
  });

  it('defaults to English', () => {
    expect(getMainLanguage()).toBe('en');
    expect(tNotification('sessionWaitingTitle')).toBe('Session waiting');
  });

  it('switches to Chinese when setMainLanguage(zh) is called', () => {
    setMainLanguage('zh');
    expect(getMainLanguage()).toBe('zh');
    expect(tNotification('sessionWaitingTitle')).toBe('会话等待中');
  });

  it('interpolates {{vars}} the same way i18next does', () => {
    setMainLanguage('en');
    expect(tNotification('sessionWaitingBody', { name: 'webhook-worker' })).toBe(
      'webhook-worker needs your input'
    );
    setMainLanguage('zh');
    expect(tNotification('sessionWaitingBody', { name: 'webhook-worker' })).toBe(
      'webhook-worker 需要你的输入'
    );
  });

  it('resolves zh-CN / zh-TW system locales to zh, everything else to en', () => {
    expect(resolveSystemLanguage('zh-CN')).toBe('zh');
    expect(resolveSystemLanguage('zh-TW')).toBe('zh');
    expect(resolveSystemLanguage('zh')).toBe('zh');
    expect(resolveSystemLanguage('en-US')).toBe('en');
    expect(resolveSystemLanguage(undefined)).toBe('en');
    expect(resolveSystemLanguage('fr-FR')).toBe('en');
  });
});
