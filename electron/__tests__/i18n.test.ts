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
  tTray,
  tMenu,
  tDialog,
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

  it('localizes tray menu strings (en)', () => {
    setMainLanguage('en');
    expect(tTray('show')).toBe('Show CCSM');
    expect(tTray('quit')).toBe('Quit');
    expect(tTray('tooltip')).toBe('CCSM');
  });

  it('localizes tray menu strings (zh)', () => {
    setMainLanguage('zh');
    const labels = [tTray('show'), tTray('quit'), tTray('tooltip')];
    // Spot-check Chinese characters appear in the localized menu so a
    // future "oops, English literal slipped in" regression fails loud.
    expect(labels.some((s) => /[\u4e00-\u9fff]/.test(s))).toBe(true);
    expect(tTray('show')).toBe('显示 CCSM');
    expect(tTray('quit')).toBe('退出');
  });

  it('localizes the app accelerator menu Edit label (en + zh)', () => {
    setMainLanguage('en');
    expect(tMenu('edit')).toBe('&Edit');
    setMainLanguage('zh');
    // Localized label must contain Chinese characters and preserve the
    // `&E` accelerator marker so Alt+E still opens the submenu on
    // Windows/Linux.
    const zhEdit = tMenu('edit');
    expect(/[\u4e00-\u9fff]/.test(zhEdit)).toBe(true);
    expect(zhEdit).toContain('&E');
  });

  it('localizes native dialog titles (en + zh)', () => {
    setMainLanguage('en');
    expect(tDialog('chooseCwd')).toBe('Choose working directory');
    setMainLanguage('zh');
    const zhCwd = tDialog('chooseCwd');
    expect(/[\u4e00-\u9fff]/.test(zhCwd)).toBe(true);
  });

  // E2E coverage for #295 (tray-menu i18n).
  //
  // We can't drive the real Tray.setContextMenu() in CI: Electron's tray
  // surface is OS-native (Windows shell notification area, GNOME indicator,
  // macOS NSStatusItem) and exposes no scriptable accessor for the resolved
  // menu items. Playwright sees the BrowserWindow tree, not the OS chrome.
  //
  // Instead this case asserts the underlying string source that
  // `applyTrayLocale()` in electron/main.ts feeds into the menu template
  // (`i18n.tTray(key)`). Coverage chain:
  //   IPC ccsm:set-language → setMainLanguage → tTray returns localized →
  //   Menu.buildFromTemplate uses those labels.
  // The IPC handler itself is verified by the language-toggle E2E probe
  // (scripts/probe-e2e-language-toggle.mjs) which calls
  // window.ccsm.i18n.setLanguage and observes the renderer flip.
  describe('#295 tray-menu i18n end-to-end via setMainLanguage', () => {
    it('flipping language flips every tray catalog key, with no English bleed in zh', () => {
      setMainLanguage('en');
      const enLabels = {
        show: tTray('show'),
        quit: tTray('quit'),
        tooltip: tTray('tooltip')
      };
      expect(enLabels.show).toBe('Show CCSM');
      expect(enLabels.quit).toBe('Quit');

      setMainLanguage('zh');
      const zhLabels = {
        show: tTray('show'),
        quit: tTray('quit'),
        tooltip: tTray('tooltip')
      };
      // Every menu item (show, quit) MUST contain CJK once switched.
      // 'tooltip' is the brand 'CCSM' in both locales by design — exclude.
      expect(/[\u4e00-\u9fff]/.test(zhLabels.show)).toBe(true);
      expect(/[\u4e00-\u9fff]/.test(zhLabels.quit)).toBe(true);
      // No English-only fallback leaked through.
      expect(zhLabels.show).not.toBe(enLabels.show);
      expect(zhLabels.quit).not.toBe(enLabels.quit);
      expect(zhLabels.show).not.toMatch(/^Show /);
      expect(zhLabels.quit).not.toMatch(/^Quit$/);

      // Reverse-verify: revert to en and assert the English literals come
      // back. This guards against a regression where setMainLanguage gets
      // wired to a constant.
      setMainLanguage('en');
      expect(tTray('show')).toBe('Show CCSM');
      expect(tTray('quit')).toBe('Quit');
    });
  });
});
