import { create } from 'zustand';
import { loadPersisted, schedulePersist, PERSISTED_KEYS, type PersistedState, type PersistedKey } from './persist';
import { hydrateDrafts } from './drafts';
import { createSessionCrudSlice } from './slices/sessionCrudSlice';
import { createSessionRuntimeSlice } from './slices/sessionRuntimeSlice';
import { createSessionTitleBackfillSlice } from './slices/sessionTitleBackfillSlice';
import { createGroupsSlice } from './slices/groupsSlice';
import {
  createAppearanceSlice,
  legacyFontSizeToPx,
  sanitizeFontSizePx,
  resolvePersistedSidebarWidth,
} from './slices/appearanceSlice';
import { createModelPickerSlice } from './slices/modelPickerSlice';
import { createPopoverSlice } from './slices/popoverSlice';
import type { State, RootStore } from './slices/types';

export const useStore = create<RootStore>((set, get) => ({
  ...createSessionCrudSlice(set, get),
  ...createSessionRuntimeSlice(set, get),
  ...createSessionTitleBackfillSlice(set, get),
  ...createGroupsSlice(set, get),
  ...createAppearanceSlice(set, get),
  ...createModelPickerSlice(set, get),
  ...createPopoverSlice(set, get),
  // Boot-only state owned by `hydrateStore()` below — neither a slice
  // (no actions) nor persisted (lifecycle only).
  hydrated: false,
}));

let hydrated = false;

/**
 * Boot timing trace exposed on `window.__ccsmHydrationTrace`. Populated by
 * `index.tsx` (renderedAt) and `hydrateStore()` (hydrateStartedAt /
 * hydrateDoneAt). Used by the harness-ui case
 * `startup-paints-before-hydrate` to assert renderedAt < hydrateDoneAt —
 * i.e. that React mounted before the awaited persisted-state load
 * resolved. Same E2E-debug-affordance trade-off as `__ccsmStore`.
 */
export interface HydrationTrace {
  renderedAt?: number;
  hydrateStartedAt?: number;
  hydrateDoneAt?: number;
}

// Compile-time guard: every key in PERSISTED_KEYS must exist on State (so the
// subscriber's `s[k]` read is well-typed) AND on PersistedState (so the
// snapshot we hand to schedulePersist is structurally valid). If a key is
// added to PERSISTED_KEYS that doesn't exist on either, this assertion fails
// at typecheck — keeping the source-of-truth array honest.
type _AssertPersistedKeysOnState = PersistedKey extends keyof State ? true : never;
type _AssertPersistedKeysOnPersisted = PersistedKey extends keyof PersistedState ? true : never;
const _persistedKeysOnState: _AssertPersistedKeysOnState = true;
const _persistedKeysOnPersisted: _AssertPersistedKeysOnPersisted = true;
void _persistedKeysOnState;
void _persistedKeysOnPersisted;

export async function hydrateStore(): Promise<void> {
  if (hydrated) return;
  // E2E + perf trace. Pinned by harness-ui case `startup-paints-before-hydrate`
  // to verify render() runs before hydrate resolves. Same security/scope
  // trade-off as `__ccsmStore`.
  const trace =
    (typeof window !== 'undefined'
      ? ((window as unknown as { __ccsmHydrationTrace?: HydrationTrace }).__ccsmHydrationTrace ??=
          {} as HydrationTrace)
      : ({} as HydrationTrace));
  trace.hydrateStartedAt = Date.now();
  // Drafts live alongside the main snapshot but in their own key — load both
  // before render so the InputBar's initial value is the persisted draft, not
  // an empty string that flashes for one tick.
  await hydrateDrafts();
  const persisted = await loadPersisted();
  if (persisted) {
    const stillActive = persisted.sessions.some((s) => s.id === persisted.activeId);
    // Migration: older snapshots may carry `model`, `permission`, and
    // `notificationSettings` keys (PR-D removed them as orphan persisted
    // state with no subscribers). We simply don't read them — `loadPersisted`
    // returns the parsed JSON unchanged, and unrecognised top-level keys
    // bypass the setState below without errors.
    useStore.setState({
      sessions: persisted.sessions,
      groups: persisted.groups,
      activeId: stillActive ? persisted.activeId : persisted.sessions[0]?.id ?? '',
      sidebarCollapsed: persisted.sidebarCollapsed ?? false,
      sidebarWidth: resolvePersistedSidebarWidth(persisted),
      theme: persisted.theme ?? 'system',
      fontSize: persisted.fontSize ?? 'md',
      fontSizePx: persisted.fontSizePx !== undefined
        ? sanitizeFontSizePx(persisted.fontSizePx)
        : legacyFontSizeToPx(persisted.fontSize ?? 'md'),
      tutorialSeen: persisted.tutorialSeen ?? false,
    });
  }
  // Flip `hydrated` BEFORE kicking off the deferred IPCs below — components
  // that gate their first paint on this can stop showing skeleton state the
  // moment the persisted snapshot lands, even though connection/models may
  // still be in flight for another 100-500ms.
  useStore.setState({ hydrated: true });
  hydrated = true;
  trace.hydrateDoneAt = Date.now();

  // One-shot best-effort migration: probe every persisted session's `cwd`
  // and tag rows whose directory has vanished between runs. We only
  // SET the flag — we never CLEAR an unset one — and the work is fully
  // async so a slow/missing IPC never blocks hydration. The Sidebar dims
  // tagged rows; `agent:start` would also catch this on the spawn path,
  // but tagging up front means the user sees the bad state immediately
  // instead of after their first send. Once the user repicks via the
  // StatusBar cwd chip, `changeCwd` clears the flag.
  void (async () => {
    const sessions = useStore.getState().sessions;
    const uniquePaths = Array.from(new Set(sessions.map((s) => s.cwd).filter(Boolean)));
    if (uniquePaths.length === 0) return;
    const api = window.ccsm;
    if (!api?.pathsExist) return;
    let existence: Record<string, boolean>;
    try {
      existence = await api.pathsExist(uniquePaths);
    } catch {
      return;
    }
    const missing = new Set(
      uniquePaths.filter((p) => existence[p] === false)
    );
    if (missing.size === 0) return;
    useStore.setState((s) => ({
      sessions: s.sessions.map((x) =>
        missing.has(x.cwd) ? { ...x, cwdMissing: true } : x
      ),
    }));
  })();

  // Seed boot defaults from main: `userHome` is the always-true default cwd
  // for new sessions, and `claudeSettingsDefaultModel` is the CLI's own
  // `--model` default (read from `~/.claude/settings.json`). Both are
  // best-effort — if the IPC fails, the renderer keeps its empty defaults
  // and the SDK falls back to its built-ins. Fire-and-forget so a slow IPC
  // (or a binary shell-out from defaultModel) doesn't gate first paint.
  void (async () => {
    try {
      const api = window.ccsm;
      if (api?.userHome && api?.defaultModel) {
        const [userHome, defaultModel] = await Promise.all([
          api.userHome(),
          api.defaultModel(),
        ]);
        useStore.setState({
          userHome: typeof userHome === 'string' ? userHome : '',
          claudeSettingsDefaultModel: typeof defaultModel === 'string' ? defaultModel : null,
        });
      }
      // Seed `lastUsedCwd` from the ccsm-owned `userCwds` LRU so the very
      // first `+` click after launch already lands in the user's most
      // recent project. Without this, the first session of every boot
      // would silently fall back to home and re-train the picker. Skip
      // when the only entry is `userHome` — that's the empty-LRU sentinel
      // (`getUserCwds()` always appends home), which means "no real
      // pick", so we leave `lastUsedCwd` null and let createSession use
      // userHome via the explicit fallback.
      if (api?.userCwds?.get) {
        const list = await api.userCwds.get().catch(() => [] as string[]);
        const head = Array.isArray(list) && list.length > 0 ? list[0] : null;
        const home = useStore.getState().userHome;
        if (head && head !== home) {
          useStore.setState({ lastUsedCwd: head });
        }
      }
    } catch {
      /* IPC unavailable — boot continues with empty defaults */
    }
  })();

  // Connection info + discovered models from settings.json. Demoted to
  // fire-and-forget post-hydrate (perf/startup-render-gate): `loadModels`
  // shells out to the claude binary and can take 100-500ms; awaiting it
  // here would gate first paint by that much. Consumers
  // (SettingsDialog, StatusBar) already render an empty/loading state
  // until `models` populates and re-fire these themselves on mount.
  void useStore.getState().loadConnection();
  void useStore.getState().loadModels();

  // PR4: backfill any default-named persisted sessions from the SDK's
  // `listSessions` per-project view. Fire-and-forget — must not block
  // hydrate completion or first paint. Sidebar names update in-place as
  // `_applyExternalTitle` patches arrive (typically within ~1s of hydrate).
  void useStore.getState()._backfillTitles();

  // After (potential) hydration, subscribe to write-through.
  // Perf: the subscriber fires on EVERY store mutation (including hot paths
  // like appendBlocks per stream chunk). We early-bail when none of the
  // top-level fields that actually get persisted have changed, so we never
  // build the snapshot object or hit `schedulePersist`'s debounce timer for
  // mutations that wouldn't change disk state anyway. Fields are checked by
  // reference — every persisted field is either a primitive or an immutable
  // array we replace on update, so reference equality is correct.
  //
  // Both the comparator and the snapshot iterate `PERSISTED_KEYS` (defined
  // in persist.ts) so adding a new persisted field only requires editing
  // that one array.
  let prevSnap: State | null = null;
  useStore.subscribe((s) => {
    if (prevSnap !== null) {
      let changed = false;
      for (const k of PERSISTED_KEYS) {
        if (prevSnap[k] !== s[k]) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
    }
    prevSnap = s;
    const snapshot = { version: 1 as const } as PersistedState;
    for (const k of PERSISTED_KEYS) {
      // The PERSISTED_KEYS list is statically derived from State and matches
      // PersistedState 1:1 (modulo `version`, which is a literal stamped
      // above). The cast keeps the per-key assignment narrow without forcing
      // every call site to spell out the union.
      (snapshot as unknown as Record<string, unknown>)[k] = s[k];
    }
    schedulePersist(snapshot);
  });
}
