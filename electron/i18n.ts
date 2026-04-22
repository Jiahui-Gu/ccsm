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

type NotificationKey = keyof NotificationCatalog;

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

// Resolve a system locale tag into one of the two supported languages.
// Mirrors `resolveLanguage` in the renderer; duplicated for the same
// rootDir reason as above.
export function resolveSystemLanguage(localeTag: string | undefined): SupportedLanguage {
  const tag = (localeTag ?? '').toLowerCase();
  if (tag.startsWith('zh')) return 'zh';
  return 'en';
}
