// R-30 (Task #87): hide the daemon's own console window on Windows.
//
// Background: Tauri spawns the daemon with CREATE_NEW_CONSOLE so node-pty's
// `conpty_console_list_agent.js` helper subprocess inherits a stable console
// handle (see `packages/frontend-tauri/src-tauri/src/daemon_mgr.rs` for the
// full rationale on why CREATE_NO_WINDOW broke the second PTY spawn). The
// trade-off is that the daemon launches with a visible Node console window.
//
// This module hides that window via Win32 user32!ShowWindow(GetConsoleWindow,
// SW_HIDE), called once at daemon startup. We use `koffi` (a thin
// dlopen/dlsym wrapper, prebuilt native binary, no compile step) because Node
// has no built-in way to call user32 from JS and we don't want to add another
// node-gyp build for a 3-line FFI call.
//
// No-op on non-Windows.
//
// Failure modes (logged + ignored):
//   - koffi fails to load (very rare; would surface as ERR_DLOPEN_FAILED)
//   - GetConsoleWindow returns 0 (process has no console — e.g. spawned by
//     something other than Tauri with CREATE_NEW_CONSOLE; the conpty fix is
//     not active in that case but we don't need to hide anything either)
//   - ShowWindow returns 0 (window was already hidden — fine)
//
// Hiding is best-effort. The functional fix (CREATE_NEW_CONSOLE giving
// node-pty a console to attach/detach against) does NOT depend on this hide
// succeeding — only on the console existing.

export async function hideOwnConsoleWindowOnWindows(): Promise<void> {
  if (process.platform !== 'win32') return;
  try {
    // Lazy ESM import so non-Windows platforms never load koffi.
    const koffiMod = await import('koffi');
    const koffi = (koffiMod as { default?: typeof import('koffi') }).default ?? koffiMod;
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');

    // HWND GetConsoleWindow();
    const GetConsoleWindow = kernel32.func('void* GetConsoleWindow()');
    // BOOL ShowWindow(HWND hWnd, int nCmdShow);
    const ShowWindow = user32.func('int ShowWindow(void* hWnd, int nCmdShow)');

    const hwnd = GetConsoleWindow();
    if (!hwnd) {
      console.error('[ccsm] hide-console: GetConsoleWindow returned null (no console attached)');
      return;
    }
    const SW_HIDE = 0;
    ShowWindow(hwnd, SW_HIDE);
    console.error('[ccsm] hide-console: hid console window');
  } catch (err) {
    // Don't let an FFI/koffi load failure abort daemon startup — the user
    // would just see a stray Node console window, which is annoying but not
    // functionally broken (the conpty fix in Rust still applies).
    console.error('[ccsm] hide-console: failed to hide console window:', err);
  }
}
