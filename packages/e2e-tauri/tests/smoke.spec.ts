// Smoke spec — Task #680 (T13).
//
// Goal: prove tauri-driver + WebDriverIO can drive the actual ccsm-tauri.exe
// (Tauri 2 + WebView2 + Edge 147 driver) end-to-end on Windows 11. ONE happy
// path: launch the Tauri shell and assert the React tree mounts post-bootstrap
// (which requires daemon-spawn + handshake + hostConfig wiring to all succeed).
//
// Why we don't click "+ New Session" in T13 smoke:
// --------------------------------------------------------------------------
// When tauri-driver runs, the WebView2 origin observed by msedgedriver is
// `http://tauri.localhost/` — a *different* string from the production
// `tauri://localhost` that the daemon's Origin allow-list (auth.mts) accepts.
// POST /api/sessions therefore returns 403 forbidden_origin under the
// driver, even though it works fine when a human launches ccsm-tauri.exe.
// Surfacing this in T13 would entangle "does e2e plumbing work" with
// "should daemon trust webdriver-origin Tauri sessions" (a security policy
// decision, not a smoke concern). T14 / a follow-up can either (a) widen
// the allow-list under a `--ccsm-test-origin` env, (b) inject a test-only
// CSRF bypass token, or (c) drive session creation via Rust IPC instead of
// HTTP. T13's contract is "tauri-driver works at all on this code base".
//
// We therefore assert:
//   - The sidebar's "+ New Session" button is rendered + enabled. This is
//     only true after `bootstrap()` resolves daemon-ready, so its presence
//     proves: daemon spawn → handshake → hostConfig built → React render →
//     Sidebar mounted (the entire wave-2 chain T8 / T10 / T11 / T12).
//   - The T12 daemon-exit banner is NOT present (so the daemon is alive
//     throughout the smoke window).
//
// Caveats baked in deliberately:
//   - Single spec, single window. Multi-window / drag-drop / restart is
//     out of T13 scope (Plan §B).
//   - We deliberately avoid `tauri://localhost` shaped assertions because
//     under msedgedriver the URL is `http://tauri.localhost/`.

import { browser, $, expect } from '@wdio/globals';

describe('ccsm-tauri smoke (T13)', () => {
  it('launches the Tauri shell and bootstraps the daemon end-to-end', async () => {
    // 1. Sanity: msedgedriver attached to ccsm-tauri.exe's WebView2 (not a
    //    stray about:blank Edge window).
    const url = await browser.execute(() => window.location.href);
    const title = await browser.execute(() => document.title);
    // eslint-disable-next-line no-console
    console.log(`[smoke] attached url=${url} title=${title}`);
    // The WebView2 origin under webdriver is `http://tauri.localhost/`
    // (note: dot, not double-colon-slash). The production runtime origin
    // is `tauri://localhost`; both are acceptable here — what matters is
    // that we are NOT on about:blank.
    expect(url).not.toBe('about:blank');
    expect(title).toBe('ccsm-tauri');

    // 2. Wait for the React tree to mount and the sidebar New Session
    //    button to appear. The button is rendered inside <Sidebar>, which
    //    only mounts after `bootstrap()` resolves the daemon-ready
    //    handshake — so its presence proves the entire spawn + handshake
    //    + hostConfig + render chain works.
    const newSessionBtn = await $('[data-testid="sidebar-new-session"]');
    try {
      await newSessionBtn.waitForExist({ timeout: 30_000 });
    } catch (e) {
      // Diagnostic dump on bootstrap failure: helps distinguish (a) daemon
      // never started (#root empty), (b) bootstrap printed an error string
      // into #root, (c) daemon-exit banner showing instead.
      const html = await browser.execute(
        () => document.body.innerHTML.slice(0, 2000),
      );
      // eslint-disable-next-line no-console
      console.error(`[smoke] body HTML at failure:\n${html}`);
      throw e;
    }
    await newSessionBtn.waitForEnabled({ timeout: 30_000 });

    // 3. T12 contract: daemon-exit banner must NOT have fired during the
    //    smoke run. If it did, the daemon died after handshake — that's a
    //    regression in T11/T12 surface, not flake.
    const banner = await $('[data-testid="daemon-exit-banner"]');
    expect(await banner.isExisting()).toBe(false);

    // 4. Bonus assertion: the default group container is rendered (T9
    //    Sidebar Zone 2). Empty group hint should be visible since no
    //    sessions exist yet.
    const groups = await $('[data-testid="sidebar-groups"]');
    expect(await groups.isExisting()).toBe(true);
    const defaultGroup = await $('[data-testid="sidebar-group-default"]');
    expect(await defaultGroup.isExisting()).toBe(true);
  });
});
