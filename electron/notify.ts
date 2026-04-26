// Defensive wrapper around the inlined notify implementation.
//
// The notify implementation lives at `./notify-impl/` (originally vendored
// from the standalone `@ccsm/notify` package — inlined to drop the private
// GitHub dep and unblock public release; see #199). It pulls in
// `electron-windows-notifications`, which transitively depends on a chain of
// nan-based `@nodert-win10-au/*` native addons that have no prebuilds. On
// environments without a working node-gyp / MSBuild toolchain the install of
// those native deps fails, so we declare `electron-windows-notifications` in
// `optionalDependencies` (npm tolerates failed optional installs) and load
// the implementation lazily here. If loading fails — for any reason:
// optional native dep missing, platform unsupported, runtime adapter init
// throws — every wrapper function becomes a graceful no-op so the rest of
// the app keeps working with the existing in-app banners / Electron
// `Notification` toasts.
//
// Same design as `fsevents` on macOS: optional install + lazy require + soft
// fallback. See task #267 for context.
//
// The payload shapes below are duplicated from the implementation's public
// API (kept narrow on purpose — only the fields callers actually pass
// through). We do NOT `import type` from `./notify-impl` directly so this
// file's behavior under the lazy loader matches the prior @ccsm/notify
// dynamic-import flow exactly; the test seam still routes through a single
// `importer` indirection.

// ---------- Local payload types (kept in lockstep with notify-impl) ----------

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

// `./notify-impl` is plain CommonJS (compiled from TS by tsconfig.electron),
// so we can `require()` it synchronously. We still expose the load through a
// promise-returning `importer` indirection so unit tests can swap the
// resolution for an async fake without touching real module state. Failure
// is sticky: once we've decided the module is unavailable, every subsequent
// call is a fast no-op without retrying the import.
let loadPromise: Promise<NotifyModuleLike | null> | null = null;
let loadError: string | null = null;
let resolvedAvailability: boolean | null = null;

// Default importer: synchronously require the inlined implementation. Wrapped
// in `Promise.resolve(...)` so the `importer` signature stays uniform across
// the test seam. The require happens inside the function (not at module load)
// so a `__setNotifyImporter` call before the first `loadModule()` invocation
// can override the import without paying for the synchronous load.
function defaultImporter(): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return Promise.resolve(require('./notify-impl'));
}

let importer: () => Promise<unknown> = defaultImporter;

/** Test-only seam. Pass `null` to reset back to the real importer. */
export function __setNotifyImporter(fn: (() => Promise<unknown>) | null): void {
  importer = fn ?? defaultImporter;
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
        `[notify] native notification module unavailable, falling back to in-app only: ${loadError}`,
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
 * Async variant — forces the JS module to load AND (when options have
 * already been configured) the underlying Notifier to be constructed, so
 * callers (e.g. the Settings dialog) can render an accurate availability
 * indicator on mount.
 *
 * Constructing the Notifier is what surfaces native-dep failures: the
 * `electron-windows-notifications` `require()` happens inside the
 * `WindowsAdapter` constructor, not at JS module load time. Without this
 * extra step, `probeNotifyAvailability()` would report "available" on
 * machines where the native chain failed to build, only for the first emit
 * to silently fall back later.
 */
export async function probeNotifyAvailability(): Promise<boolean> {
  const mod = await loadModule();
  if (!mod) return false;
  // If options aren't configured yet, the JS module loaded successfully —
  // that's the best we can report. The first real emit (after configure)
  // will trip the native-dep require if it's missing and flip availability
  // to false at that point.
  if (!notifierOptions) return true;
  const n = await getNotifier();
  return n !== null;
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
