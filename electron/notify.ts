// Defensive wrapper around the optional `@ccsm/notify` dependency.
//
// `@ccsm/notify` pulls in `electron-windows-notifications`, which transitively
// depends on a chain of nan-based `@nodert-win10-au/*` native addons that have
// no prebuilds. On environments without a working node-gyp / MSBuild toolchain
// the install of those native deps fails, so we declare `@ccsm/notify` in
// `optionalDependencies` (npm tolerates failed optional installs) and load it
// lazily here. If loading fails — for any reason: optional install skipped,
// platform unsupported, runtime adapter init throws — every wrapper function
// becomes a graceful no-op so the rest of the app keeps working with the
// existing in-app banners / Electron `Notification` toasts.
//
// Same design as `fsevents` on macOS: optional install + lazy require + soft
// fallback. See task #267 for context.
//
// We intentionally do NOT `import type` from '@ccsm/notify' so that this file
// type-checks even when the optional dep is missing on disk. The payload
// shapes below are duplicated from the upstream public API (kept narrow on
// purpose — only the fields callers actually pass through).

// ---------- Local payload types (kept in lockstep with @ccsm/notify) ----------

export interface PermissionPayload {
  toastId: string;
  sessionName: string;
  toolName: string;
  toolBrief: string;
  cwdBasename: string;
}

export interface QuestionPayload {
  toastId: string;
  sessionName: string;
  question: string;
  selectionKind: 'single' | 'multi';
  optionCount: number;
  cwdBasename: string;
}

export interface DonePayload {
  toastId: string;
  groupName: string;
  sessionName: string;
  lastUserMsg: string;
  lastAssistantMsg: string;
  elapsedMs: number;
  toolCount: number;
  cwdBasename: string;
}

export type ActionId = 'allow' | 'allow-always' | 'reject' | 'focus';
export interface ActionEvent {
  toastId: string;
  action: ActionId;
  args: Record<string, string>;
}

export interface NotifierOptions {
  appId: string;
  appName: string;
  iconPath?: string;
  silent?: boolean;
  onAction: (event: ActionEvent) => void;
}

// ---------- Lazy load + cache ----------

interface NotifyModuleLike {
  Notifier: {
    create: (options: NotifierOptions) => Promise<NotifierLike>;
  };
}

interface NotifierLike {
  permission(p: PermissionPayload): void;
  question(p: QuestionPayload): void;
  done(p: DonePayload): void;
  dismiss(toastId: string): void;
  dispose?: () => void;
}

// `@ccsm/notify` is published as ESM (`"type": "module"`). The electron main
// process compiles to CommonJS, which can't `require()` ESM, so we use a
// one-shot dynamic `import()` whose resolution is cached. Failure is sticky:
// once we've decided the module is unavailable, every subsequent call is a
// fast no-op without retrying the import.
let loadPromise: Promise<NotifyModuleLike | null> | null = null;
let loadError: string | null = null;
let resolvedAvailability: boolean | null = null;

// Indirection so unit tests can swap the loader without touching the real
// import resolution. Production code never overrides this.
let importer: () => Promise<unknown> = () =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Function('m', 'return import(m)') as (m: string) => Promise<any>)('@ccsm/notify');

/** Test-only seam. Pass `null` to reset back to the real importer. */
export function __setNotifyImporter(fn: (() => Promise<unknown>) | null): void {
  importer = fn ?? (() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Function('m', 'return import(m)') as (m: string) => Promise<any>)('@ccsm/notify'));
  loadPromise = null;
  loadError = null;
  resolvedAvailability = null;
  notifierPromise = null;
}

function loadModule(): Promise<NotifyModuleLike | null> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const mod = (await importer()) as NotifyModuleLike;
      if (!mod || !mod.Notifier || typeof mod.Notifier.create !== 'function') {
        throw new Error('imported module did not expose Notifier.create');
      }
      resolvedAvailability = true;
      return mod;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
      // Sentence case per project rule. This is the only place the failure
      // is logged so callers don't spam the console.
      // eslint-disable-next-line no-console
      console.warn(
        `[notify] @ccsm/notify unavailable, falling back to in-app only: ${loadError}`,
      );
      resolvedAvailability = false;
      return null;
    }
  })();
  return loadPromise;
}

// ---------- Notifier singleton ----------

let notifierPromise: Promise<NotifierLike | null> | null = null;
let notifierOptions: NotifierOptions | null = null;

/**
 * Configure the underlying notifier. Safe to call before or after the module
 * has loaded; the options are consumed on first emit. Calling this a second
 * time discards any previously created notifier so the next emit picks up the
 * new options.
 */
export function configureNotify(options: NotifierOptions): void {
  notifierOptions = options;
  notifierPromise = null;
}

async function getNotifier(): Promise<NotifierLike | null> {
  const mod = await loadModule();
  if (!mod) return null;
  if (!notifierOptions) {
    // No options set yet — caller hasn't wired up `onAction` etc. Treat the
    // same as "unavailable" so we don't construct a half-initialised notifier
    // that would then drop activations on the floor.
    return null;
  }
  if (!notifierPromise) {
    const opts = notifierOptions;
    notifierPromise = mod.Notifier.create(opts).catch((e: unknown) => {
      loadError = e instanceof Error ? e.message : String(e);
      // eslint-disable-next-line no-console
      console.warn(
        `[notify] Notifier.create failed, falling back to in-app only: ${loadError}`,
      );
      resolvedAvailability = false;
      return null;
    });
  }
  return notifierPromise;
}

// ---------- Public availability surface ----------

/**
 * Returns true when the optional native module loaded AND a notifier has been
 * successfully constructed. Returns `false` until the first emit (or an
 * explicit `probeNotifyAvailability()` call) has resolved the import.
 */
export function isNotifyAvailable(): boolean {
  return resolvedAvailability === true;
}

/**
 * Async variant — forces the dynamic import to run if it hasn't yet, so
 * callers (e.g. the Settings dialog) can render an accurate availability
 * indicator on mount.
 */
export async function probeNotifyAvailability(): Promise<boolean> {
  const mod = await loadModule();
  return mod !== null;
}

/** Last load/init error message, or null when the module is healthy. */
export function notifyLastError(): string | null {
  return loadError;
}

// ---------- Wrapper functions (always resolve, never throw) ----------

export async function notifyPermission(payload: PermissionPayload): Promise<void> {
  const n = await getNotifier();
  if (!n) return;
  try {
    n.permission(payload);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[notify] permission emit failed: ${e instanceof Error ? e.message : e}`);
  }
}

export async function notifyQuestion(payload: QuestionPayload): Promise<void> {
  const n = await getNotifier();
  if (!n) return;
  try {
    n.question(payload);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[notify] question emit failed: ${e instanceof Error ? e.message : e}`);
  }
}

export async function notifyDone(payload: DonePayload): Promise<void> {
  const n = await getNotifier();
  if (!n) return;
  try {
    n.done(payload);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[notify] done emit failed: ${e instanceof Error ? e.message : e}`);
  }
}

export async function notifyDismiss(toastId: string): Promise<void> {
  const n = await getNotifier();
  if (!n) return;
  try {
    n.dismiss(toastId);
  } catch {
    // adapter may already be gone — swallow
  }
}

export async function disposeNotify(): Promise<void> {
  if (!notifierPromise) return;
  const n = await notifierPromise;
  if (!n || !n.dispose) return;
  try {
    n.dispose();
  } catch {
    // best effort
  }
}
