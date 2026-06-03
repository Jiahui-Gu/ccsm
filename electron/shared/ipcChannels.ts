// Single source of truth for IPC channel names.
//
// Before this module, channel names were inline string literals on BOTH
// sides of the bridge: `electron/preload/bridges/*.ts` spelled `'pty:attach'`
// by hand, and the main-process registrar in `electron/ipc/*.ts` +
// `electron/ptyHost/ipcRegistrar.ts` spelled the same string independently.
// Adding a channel required touching 3+ files; renaming was grep-and-pray.
//
// Every channel now appears in exactly one place. A typo in either preload
// OR main becomes a TypeScript error (`as const` gives literal types) rather
// than a silent IPC dead-letter at runtime.
//
// Scope intentionally limited (per task brief) to the six high-churn
// namespaces:
//   - pty:*       — node-pty bridge (lifecycle + data fan-out)
//   - session:*   — sessionWatcher signals + renderer→main mirrors
//   - window:*    — title-bar controls + close-action dialog
//   - updates:*   — electron-updater status / actions (renderer↔main invokes)
//   - update:*    — fan-out events from electron-updater (main→renderer sends)
//   - db:*        — app_state key/value persistence
//
// Renderer-side `.d.ts` files (`src/pty.d.ts`, `src/session.d.ts`) deliberately
// remain untouched — they describe the `window.ccsm*` shape, not the channel
// strings, and folding them in would require typed signatures (follow-up PR).

export const PTY_CHANNELS = {
  list: 'pty:list',
  spawn: 'pty:spawn',
  attach: 'pty:attach',
  detach: 'pty:detach',
  input: 'pty:input',
  resize: 'pty:resize',
  kill: 'pty:kill',
  get: 'pty:get',
  getBufferSnapshot: 'pty:getBufferSnapshot',
  data: 'pty:data',
  exit: 'pty:exit',
  saveClipboardImage: 'pty:saveClipboardImage',
  checkClaudeAvailable: 'pty:checkClaudeAvailable',
} as const;

export const SESSION_CHANNELS = {
  // main → renderer
  state: 'session:state',
  title: 'session:title',
  cwdRedirected: 'session:cwdRedirected',
  activate: 'session:activate',
  // renderer → main (one-way)
  setActive: 'session:setActive',
  setName: 'session:setName',
} as const;

export const WINDOW_CHANNELS = {
  // renderer → main (invoke)
  minimize: 'window:minimize',
  toggleMaximize: 'window:toggleMaximize',
  close: 'window:close',
  isMaximized: 'window:isMaximized',
  // renderer → main (one-way)
  resolveCloseAction: 'window:resolveCloseAction',
  // main → renderer
  maximizedChanged: 'window:maximizedChanged',
  beforeHide: 'window:beforeHide',
  afterShow: 'window:afterShow',
  askCloseAction: 'window:askCloseAction',
} as const;

export const UPDATES_CHANNELS = {
  status: 'updates:status',
  check: 'updates:check',
  download: 'updates:download',
  install: 'updates:install',
  getAutoCheck: 'updates:getAutoCheck',
  setAutoCheck: 'updates:setAutoCheck',
} as const;

// Fan-out events emitted by `electron/updater.ts` alongside the aggregated
// `updates:status` channel. All three are main → renderer sends so renderer
// listeners can subscribe to a single transition without switching on kind.
export const UPDATE_CHANNELS = {
  // main → renderer
  available: 'update:available',
  downloaded: 'update:downloaded',
  error: 'update:error',
} as const;

export const DB_CHANNELS = {
  load: 'db:load',
  save: 'db:save',
} as const;
