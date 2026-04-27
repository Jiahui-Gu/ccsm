// Per-session composer drafts persisted across app restarts.
//
// Drafts live in the same `app_state` table as the main store snapshot but
// under their own key (`drafts`) so they evolve independently and don't bloat
// the main snapshot's debounced write path. Stored shape is just a flat
// Record<sessionId, string>.
//
// Lifecycle:
//   - hydrateDrafts() on app boot, before the InputBar mounts.
//   - setDraft(sessionId, text) on every keystroke.
//   - clearDraft(sessionId) on send / slash-command commit.
//   - getDraft(sessionId) for InputBar's initial value.
//
// Writes are debounced so per-keystroke disk traffic stays cheap.

const STATE_KEY = 'drafts';
const WRITE_DEBOUNCE_MS = 250;

const cache = new Map<string, string>();
let hydrated = false;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

export async function hydrateDrafts(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  if (!window.ccsm) return;
  try {
    const raw = await window.ccsm.loadState(STATE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { version: 1; drafts: Record<string, string> };
    if (parsed.version !== 1 || !parsed.drafts) return;
    for (const [k, v] of Object.entries(parsed.drafts)) {
      if (typeof v === 'string' && v.length > 0) cache.set(k, v);
    }
  } catch {
    /* corrupt blob — start clean */
  }
}

export function getDraft(sessionId: string): string {
  return cache.get(sessionId) ?? '';
}

export function setDraft(sessionId: string, text: string): void {
  if (text) cache.set(sessionId, text);
  else cache.delete(sessionId);
  schedulePersist();
}

export function clearDraft(sessionId: string): void {
  if (!cache.has(sessionId)) return;
  cache.delete(sessionId);
  schedulePersist();
}

/** Snapshot the draft for one session so it can be restored after a soft
 *  delete + undo. Returns empty string when no draft exists. */
export function snapshotDraft(sessionId: string): string {
  return cache.get(sessionId) ?? '';
}

/** Restore a draft captured by `snapshotDraft`. Empty strings are no-ops. */
export function restoreDraft(sessionId: string, text: string): void {
  if (!text) return;
  cache.set(sessionId, text);
  schedulePersist();
}

export function deleteDrafts(sessionIds: string[]): void {
  let changed = false;
  for (const id of sessionIds) {
    if (cache.delete(id)) changed = true;
  }
  if (changed) schedulePersist();
}

function schedulePersist(): void {
  if (!window.ccsm) return;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const drafts: Record<string, string> = {};
    for (const [k, v] of cache.entries()) drafts[k] = v;
    void window.ccsm!.saveState(STATE_KEY, JSON.stringify({ version: 1, drafts })).catch(
      () => {
        /* persist failures are non-fatal; we'll retry on the next edit */
      }
    );
  }, WRITE_DEBOUNCE_MS);
}

// Test-only — not exported through any barrel; reach in via the module path.
export function _resetForTests(): void {
  cache.clear();
  hydrated = false;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = null;
}

// E2E debug affordance — mirrors `window.__ccsmStore` / `window.__ccsmI18n`.
// Themed harnesses run multiple cases inside one Electron process; the
// module-scope `cache` survives the per-case store reset, so a draft typed
// during case N (e.g. the "n" keypress in casePermissionPrompt) leaks into
// the InputBar's initial value for case N+1, focuses the composer, and steals
// focus from the next permission prompt (see PR #320 root-cause writeup).
// Exposing `_resetForTests` on the window lets the harness scrub the cache
// without going through DOM input events that introduce focus races.
if (typeof window !== 'undefined') {
  (window as unknown as { __ccsmDrafts?: { _resetForTests: () => void } }).__ccsmDrafts = {
    _resetForTests
  };
}
