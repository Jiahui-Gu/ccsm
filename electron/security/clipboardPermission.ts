// Clipboard permission policy for the renderer (Task #266).
//
// Why: xterm's keydown handler swallows the user-activation propagation
// `navigator.clipboard.read*` requires under sandbox:true + contextIsolation:
// true, so the renderer currently routes clipboard ops through a native
// bridge (`window.ccsmPty.clipboard.*` per src/terminal/xtermSingleton.ts).
// Once we register `setPermissionRequestHandler` + `setPermissionCheckHandler`
// granting `clipboard-read` for our own `app://` origin (see T6.1 /
// `packages/electron/src/main/protocol-app.ts`), the renderer can switch to
// `navigator.clipboard.*` directly. The actual cutover at xtermSingleton.ts
// is a separate downstream task — this module only installs the policy.
//
// Policy:
//   * `clipboard-read` is GRANTED iff the requesting origin's scheme is
//     `app:` (i.e. our own descriptor-served renderer per ch08 §4.1). All
//     other origins (file://, http://localhost dev server, https://*, ...)
//     and all other permissions (`notifications`, `geolocation`, `media`,
//     ...) are DENIED.
//   * `setPermissionCheckHandler` mirrors the same rule — Chromium consults
//     it for synchronous permission queries (e.g. `navigator.permissions.
//     query({ name: 'clipboard-read' })`) and we want both APIs to agree.
//
// Why not broaden to `clipboard-write`: writing to the clipboard does not
// require a permission grant in Chromium when triggered by user activation;
// the bridge today exposes both read + write but only read needed special
// handling. Adding `clipboard-write` here would be inert and confuse a
// future reader about which permissions actually go through this gate.

/**
 * Pure decider — exported for unit tests. Returns true iff the renderer
 * should be allowed to use the requested permission from the given origin.
 *
 * `requestingOrigin` is the value Chromium hands the permission handler
 * (e.g. `app://ccsm`, `http://localhost:4100`, `file://`). `permission` is
 * the Electron permission string (e.g. `clipboard-read`, `notifications`).
 */
export function isClipboardPermissionAllowed(
  permission: string,
  requestingOrigin: string,
): boolean {
  if (permission !== 'clipboard-read') return false;
  try {
    const u = new URL(requestingOrigin);
    return u.protocol === 'app:';
  } catch {
    return false;
  }
}

/**
 * Minimal structural shape of `Electron.Session` we depend on. Keeping this
 * narrow lets the unit test fake a session without pulling in the full
 * Electron type surface.
 */
export interface ClipboardPermissionSession {
  setPermissionRequestHandler(
    handler:
      | ((
          webContents: unknown,
          permission: string,
          callback: (granted: boolean) => void,
          details: { requestingUrl?: string },
        ) => void)
      | null,
  ): void;
  setPermissionCheckHandler(
    handler:
      | ((
          webContents: unknown,
          permission: string,
          requestingOrigin: string,
        ) => boolean)
      | null,
  ): void;
}

/**
 * Install the permission request + check handlers on the supplied session.
 * Call once per session (typically `session.defaultSession`) at boot, after
 * `app.whenReady()` has resolved.
 */
export function installClipboardPermissionHandlers(
  session: ClipboardPermissionSession,
): void {
  session.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(
      isClipboardPermissionAllowed(permission, details.requestingUrl ?? ''),
    );
  });
  session.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    isClipboardPermissionAllowed(permission, requestingOrigin),
  );
}
