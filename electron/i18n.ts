// Main-process translations.
//
// The main process emits OS notifications (and a few system-level dialogs)
// whose copy must follow the user's chosen UI language. We can't share the
// renderer i18next instance — main is plain Node, no React. The renderer
// catalog also can't be `import`-ed because the electron tsconfig has
// `rootDir: "electron"` and excludes `src/`. So we duplicate just the
// notifications namespace here. Keep the keys/strings in lock-step with
// `src/i18n/locales/{en,zh}.ts` — the parity test exists to catch drift.
//
// Renderer pushes the resolved language over IPC at boot and on every
// change. Main keeps the active language in a module-level variable.

export type SupportedLanguage = 'en' | 'zh';

type NotificationCatalog = {
  sessionWaitingTitle: string;
  sessionWaitingBody: string;
  sessionDoneTitle: string;
  sessionDoneBody: string;
  permissionRequestTitle: string;
  permissionRequestBody: string;
};

type TrayCatalog = {
  show: string;
  quit: string;
  tooltip: string;
};

type MenuCatalog = {
  edit: string;
};

type DialogCatalog = {
  chooseCwd: string;
};

type CloseDialogCatalog = {
  message: string;
  detail: string;
  tray: string;
  quit: string;
  dontAskAgain: string;
};

type BadgeCatalog = {
  unreadOverlay: string;
};

type NotificationKey = keyof NotificationCatalog;
type TrayKey = keyof TrayCatalog;
type MenuKey = keyof MenuCatalog;
type DialogKey = keyof DialogCatalog;
type CloseDialogKey = keyof CloseDialogCatalog;
type BadgeKey = keyof BadgeCatalog;

// IMPORTANT: keep these strings byte-identical to the renderer catalog
// `notifications` namespace. The renderer catalog is the source of truth.
const catalogs: Record<SupportedLanguage, NotificationCatalog> = {
  en: {
    sessionWaitingTitle: 'Session waiting',
    sessionWaitingBody: '{{name}} needs your input',
    sessionDoneTitle: 'Session finished',
    sessionDoneBody: '{{name}} completed its task',
    permissionRequestTitle: 'Permission requested',
    permissionRequestBody: '{{name}} is asking to {{action}}'
  },
  zh: {
    sessionWaitingTitle: '会话等待中',
    sessionWaitingBody: '{{name}} 需要你的输入',
    sessionDoneTitle: '会话已完成',
    sessionDoneBody: '{{name}} 完成了任务',
    permissionRequestTitle: '请求权限',
    permissionRequestBody: '{{name}} 想要 {{action}}'
  }
};

// Tray menu / tooltip strings. Same parity rule as the notifications
// catalog above: keep these byte-identical to the renderer catalog
// `tray` namespace in `src/i18n/locales/{en,zh}.ts`.
const trayCatalogs: Record<SupportedLanguage, TrayCatalog> = {
  en: {
    show: 'Show CCSM',
    quit: 'Quit',
    tooltip: 'CCSM'
  },
  zh: {
    show: '显示 CCSM',
    quit: '退出',
    tooltip: 'CCSM'
  }
};

// Application accelerator menu (Edit submenu carrying Cut/Copy/Paste/Undo
// shortcuts). Single label since the submenu items use Electron `role`s and
// are localized by the OS. Keep parity with the renderer catalog `menu`
// namespace.
const menuCatalogs: Record<SupportedLanguage, MenuCatalog> = {
  en: {
    edit: '&Edit'
  },
  zh: {
    edit: '编辑(&E)'
  }
};

// Native file/directory picker dialog titles. Keep parity with the renderer
// catalog `dialog` namespace.
const dialogCatalogs: Record<SupportedLanguage, DialogCatalog> = {
  en: {
    chooseCwd: 'Choose working directory'
  },
  zh: {
    chooseCwd: '选择工作目录'
  }
};

// Native "close to tray or quit?" prompt shown the first time the user
// clicks the window X (when their preference is still 'ask'). Keep parity
// with the renderer catalog `closeDialog` namespace — the same strings are
// surfaced in the Settings explainer hint so wording stays consistent.
const closeDialogCatalogs: Record<SupportedLanguage, CloseDialogCatalog> = {
  en: {
    message: 'Close ccsm?',
    detail:
      'Minimize to tray keeps ccsm running so notifications and background sessions stay active.',
    tray: 'Minimize to tray',
    quit: 'Quit',
    dontAskAgain: "Don't ask again"
  },
  zh: {
    message: '关闭 ccsm？',
    detail:
      '最小化到托盘会让 ccsm 继续运行，通知和后台会话保持活跃。',
    tray: '最小化到托盘',
    quit: '退出',
    dontAskAgain: '不再询问'
  }
};

// Accessibility alt text for the Windows taskbar overlay icon. The visible
// badge is just a digit ("1" / "9+"); screen readers announce this string.
// Not surfaced in the renderer so no parity concern.
const badgeCatalogs: Record<SupportedLanguage, BadgeCatalog> = {
  en: {
    unreadOverlay: '{{n}} unread'
  },
  zh: {
    unreadOverlay: '{{n}} 条未读'
  }
};

let activeLanguage: SupportedLanguage = 'en';

export function setMainLanguage(lang: SupportedLanguage): void {
  activeLanguage = lang;
}

export function getMainLanguage(): SupportedLanguage {
  return activeLanguage;
}

// Tiny mustache-style interpolator: replaces `{{name}}` with vars.name.
// Matches what i18next does for the keys we actually use, without pulling
// in the dependency.
function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : `{{${key}}}`
  );
}

export function tNotification(
  key: NotificationKey,
  vars: Record<string, string | number> = {}
): string {
  const catalog = catalogs[activeLanguage] ?? catalogs.en;
  const template = catalog[key] ?? catalogs.en[key] ?? key;
  return interpolate(template, vars);
}

export function tTray(key: TrayKey): string {
  const catalog = trayCatalogs[activeLanguage] ?? trayCatalogs.en;
  return catalog[key] ?? trayCatalogs.en[key] ?? key;
}

export function tMenu(key: MenuKey): string {
  const catalog = menuCatalogs[activeLanguage] ?? menuCatalogs.en;
  return catalog[key] ?? menuCatalogs.en[key] ?? key;
}

export function tDialog(key: DialogKey): string {
  const catalog = dialogCatalogs[activeLanguage] ?? dialogCatalogs.en;
  return catalog[key] ?? dialogCatalogs.en[key] ?? key;
}

export function tCloseDialog(key: CloseDialogKey): string {
  const catalog = closeDialogCatalogs[activeLanguage] ?? closeDialogCatalogs.en;
  return catalog[key] ?? closeDialogCatalogs.en[key] ?? key;
}

export function tBadge(
  key: BadgeKey,
  vars: Record<string, string | number> = {}
): string {
  const catalog = badgeCatalogs[activeLanguage] ?? badgeCatalogs.en;
  const template = catalog[key] ?? badgeCatalogs.en[key] ?? key;
  return interpolate(template, vars);
}

// Resolve a system locale tag into one of the two supported languages.
// Mirrors `resolveLanguage` in the renderer; duplicated for the same
// rootDir reason as above.
export function resolveSystemLanguage(localeTag: string | undefined): SupportedLanguage {
  const tag = (localeTag ?? '').toLowerCase();
  if (tag.startsWith('zh')) return 'zh';
  return 'en';
}
