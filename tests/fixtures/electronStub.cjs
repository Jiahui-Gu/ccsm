// Stub for `electron` module used by load-smoke harness.
// Provides shape-only objects so `const { app, BrowserWindow } = require('electron')`
// does not throw at module-load time. Methods are jest/vi spies that return undefined.

function noop() { /* noop */ }

const eventTarget = {
  on: noop,
  once: noop,
  off: noop,
  removeListener: noop,
  removeAllListeners: noop,
  emit: noop,
  addListener: noop,
};

const app = {
  ...eventTarget,
  getName: () => 'ccsm-load-smoke',
  getVersion: () => '0.0.0',
  getPath: () => '/tmp',
  getAppPath: () => '/tmp',
  isReady: () => false,
  whenReady: () => Promise.resolve(),
  quit: noop,
  exit: noop,
  setAppUserModelId: noop,
  setLoginItemSettings: noop,
  isPackaged: false,
  commandLine: { appendSwitch: noop, hasSwitch: () => false, getSwitchValue: () => '' },
  dock: { setBadge: noop, setIcon: noop, hide: noop, show: noop },
};

class BrowserWindow {
  constructor() { /* noop */ }
  loadURL() { return Promise.resolve(); }
  loadFile() { return Promise.resolve(); }
  on() { /* noop */ }
  once() { /* noop */ }
  show() { /* noop */ }
  hide() { /* noop */ }
  close() { /* noop */ }
  destroy() { /* noop */ }
  isDestroyed() { return false; }
  isMinimized() { return false; }
  isFocused() { return false; }
  isVisible() { return false; }
  webContents = { ...eventTarget, send: noop, openDevTools: noop, executeJavaScript: () => Promise.resolve() };
  static getAllWindows() { return []; }
  static fromWebContents() { return null; }
}

const ipcMain = {
  ...eventTarget,
  handle: noop,
  handleOnce: noop,
  removeHandler: noop,
};

const ipcRenderer = {
  ...eventTarget,
  send: noop,
  invoke: () => Promise.resolve(),
  sendSync: () => undefined,
};

const Menu = {
  buildFromTemplate: () => ({ popup: noop, closePopup: noop }),
  setApplicationMenu: noop,
  getApplicationMenu: () => null,
};

const Tray = class {
  constructor() { /* noop */ }
  setToolTip() { /* noop */ }
  setContextMenu() { /* noop */ }
  on() { /* noop */ }
  destroy() { /* noop */ }
  setImage() { /* noop */ }
};

const nativeImage = {
  createEmpty: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0), resize: () => nativeImage.createEmpty() }),
  createFromBuffer: () => nativeImage.createEmpty(),
  createFromPath: () => nativeImage.createEmpty(),
  createFromDataURL: () => nativeImage.createEmpty(),
};

const Notification = class {
  constructor() { /* noop */ }
  show() { /* noop */ }
  close() { /* noop */ }
  on() { /* noop */ }
  static isSupported() { return false; }
};

const dialog = {
  showMessageBox: () => Promise.resolve({ response: 0 }),
  showMessageBoxSync: () => 0,
  showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
  showSaveDialog: () => Promise.resolve({ canceled: true, filePath: '' }),
  showErrorBox: noop,
};

const shell = {
  openExternal: () => Promise.resolve(),
  openPath: () => Promise.resolve(''),
  showItemInFolder: noop,
  beep: noop,
};

const screen = {
  ...eventTarget,
  getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 }, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
  getAllDisplays: () => [],
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getDisplayNearestPoint: () => ({ workAreaSize: { width: 1920, height: 1080 }, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
};

const session = {
  defaultSession: {
    ...eventTarget,
    setPermissionRequestHandler: noop,
    setPermissionCheckHandler: noop,
    webRequest: { onHeadersReceived: noop, onBeforeRequest: noop },
  },
  fromPartition: () => ({ ...eventTarget, setPermissionRequestHandler: noop }),
};

const globalShortcut = {
  register: () => true,
  unregister: noop,
  unregisterAll: noop,
  isRegistered: () => false,
};

const powerMonitor = { ...eventTarget };
const powerSaveBlocker = { start: () => 0, stop: noop, isStarted: () => false };
const protocol = {
  registerSchemesAsPrivileged: noop,
  registerFileProtocol: noop,
  handle: noop,
  registerStringProtocol: noop,
};
const clipboard = {
  readText: () => '',
  writeText: noop,
  clear: noop,
  has: () => false,
};
const contextBridge = { exposeInMainWorld: noop };
const webContents = { getAllWebContents: () => [], fromId: () => null };

const crashReporter = {
  start: noop,
  getLastCrashReport: () => null,
  getUploadedReports: () => [],
};

module.exports = {
  app,
  BrowserWindow,
  ipcMain,
  ipcRenderer,
  Menu,
  MenuItem: class { constructor() { /* noop */ } },
  Tray,
  nativeImage,
  Notification,
  dialog,
  shell,
  screen,
  session,
  globalShortcut,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  clipboard,
  contextBridge,
  webContents,
  crashReporter,
  systemPreferences: { ...eventTarget, getColor: () => '#000000', isDarkMode: () => false },
  nativeTheme: { ...eventTarget, shouldUseDarkColors: false, themeSource: 'system' },
  autoUpdater: { ...eventTarget, setFeedURL: noop, checkForUpdates: noop, quitAndInstall: noop },
  desktopCapturer: { getSources: () => Promise.resolve([]) },
  // default export shape
  default: undefined,
};
