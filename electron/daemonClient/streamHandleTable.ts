// Stream-handle table — debug + cleanup registry for active daemon stream
// subscriptions (PTY subscribe streams, control streams, data streams).
//
// Spec: docs/superpowers/specs/v0.3-fragments/frag-3.7-dev-workflow.md
// §3.7.5 step 1 + Task 7 plan delta (~80 LOC). Used by:
//   - connectClient reconnect path: iterates handles, calls `.cancel()` on
//     each (closes round-2 devx P1-6 — clears client-side heartbeat
//     setInterval timers per frag-3.5.1 §3.5.1.4 so they don't accumulate
//     across nodemon restarts).
//   - T78 e2e probe "reconnect after stream-dead": asserts table empty
//     after stream cleanup.
//   - T68 harness-agent dev mode: debug overlay snapshot.
//   - Future cross-process leak audit.
//
// Single Responsibility — this is a **producer** (snapshot/count) and a
// **registry sink** for handle entries. It does NOT call into PTY/socket
// subsystems itself; the caller registers a `cancel` callback that the
// caller decides how to wire (close socket, clear setInterval, etc.).
// The table just iterates and invokes them on `cancelAll()`.
//
// Design choices:
//   - Factory pattern (`createStreamHandleTable()`), no module-level
//     singleton. Each connectClient instance owns one. Lets tests build
//     fresh tables without mutual contamination.
//   - Caller passes `openedAt` (no clock dep). `snapshot()` sorts by
//     `openedAt` ascending so debug output reads chronologically.
//   - `register()` returns `{ unregister }` for RAII cleanup at the call
//     site. Double-unregister is a no-op (idempotent).
//   - `cancelAll()` calls every registered handle's `cancel` callback,
//     swallowing errors so one bad handle can't strand the rest, then
//     clears the table. This is the operation §3.7.5 step 1 needs.

export type StreamHandleType =
  | 'pty-subscribe'
  | 'control-stream'
  | 'data-stream';

/** Caller-supplied entry payload. `cancel` is invoked by `cancelAll()`. */
export interface StreamHandleRegistration {
  /** Stable identifier the caller owns; used as the table key. */
  handleId: string;
  /** Coarse classification for debug overlays / leak audits. */
  streamType: StreamHandleType;
  /** Session id, when the handle is sid-scoped (PTY/data streams). */
  subId?: string;
  /** Subscriber id, when multiple consumers share a sid (fan-out). */
  subscriberId?: string;
  /** Caller-supplied open timestamp (ms). Keeps the table clock-free. */
  openedAt: number;
  /** Tear-down callback; invoked by `cancelAll()`. May be sync or async. */
  cancel?: () => void | Promise<void>;
}

/** Frozen view returned from `snapshot()`. `cancel` is intentionally omitted. */
export interface StreamHandleSnapshotEntry {
  handleId: string;
  streamType: StreamHandleType;
  subId?: string;
  subscriberId?: string;
  openedAt: number;
}

export interface StreamHandleTable {
  /** Add a handle. Returns `{ unregister }` for RAII cleanup. */
  register(entry: StreamHandleRegistration): { unregister: () => void };
  /** Remove a handle by id. No-op if absent. */
  unregister(handleId: string): void;
  /** Frozen list of current handles, sorted by `openedAt` ascending. */
  snapshot(): readonly StreamHandleSnapshotEntry[];
  /** Current number of registered handles. Cheap; safe in assertions. */
  count(): number;
  /**
   * Invoke every registered handle's `cancel` callback (errors swallowed
   * so a bad handle can't strand the rest), then empty the table.
   * Returns a Promise that resolves after all callbacks settle. This is
   * the operation `connectClient` uses on reconnect (frag-3.7 §3.7.5
   * step 1 — closes round-2 devx P1-6 heartbeat-timer leak).
   */
  cancelAll(): Promise<void>;
  /**
   * Empty the table without invoking any `cancel` callbacks. Test reset
   * helper; production code should use `cancelAll()`.
   */
  clear(): void;
}

interface InternalEntry extends StreamHandleRegistration {}

export function createStreamHandleTable(): StreamHandleTable {
  const handles = new Map<string, InternalEntry>();

  const register: StreamHandleTable['register'] = (entry) => {
    // Last-writer-wins on duplicate handleId; the previous registration's
    // RAII unregister becomes a no-op (idempotent semantics below).
    handles.set(entry.handleId, { ...entry });
    let unregistered = false;
    return {
      unregister: () => {
        if (unregistered) return;
        unregistered = true;
        // Only unregister if the entry in the map is still ours; if a
        // later register() with the same id replaced it, leave the new
        // one alone.
        const current = handles.get(entry.handleId);
        if (current && current.openedAt === entry.openedAt) {
          handles.delete(entry.handleId);
        }
      },
    };
  };

  const unregister: StreamHandleTable['unregister'] = (handleId) => {
    handles.delete(handleId);
  };

  const snapshot: StreamHandleTable['snapshot'] = () => {
    const entries = Array.from(handles.values())
      .sort((a, b) => a.openedAt - b.openedAt)
      .map<StreamHandleSnapshotEntry>((e) => {
        const out: StreamHandleSnapshotEntry = {
          handleId: e.handleId,
          streamType: e.streamType,
          openedAt: e.openedAt,
        };
        if (e.subId !== undefined) out.subId = e.subId;
        if (e.subscriberId !== undefined) out.subscriberId = e.subscriberId;
        return Object.freeze(out);
      });
    return Object.freeze(entries);
  };

  const count: StreamHandleTable['count'] = () => handles.size;

  const cancelAll: StreamHandleTable['cancelAll'] = async () => {
    // Snapshot the cancel callbacks first, then clear the table BEFORE
    // invoking — this way if a `cancel` callback re-enters the table
    // (e.g. registers a fresh handle on its own) it sees a clean slate.
    const cancels: Array<() => void | Promise<void>> = [];
    for (const entry of handles.values()) {
      if (entry.cancel) cancels.push(entry.cancel);
    }
    handles.clear();
    await Promise.all(
      cancels.map(async (cancel) => {
        try {
          await cancel();
        } catch {
          // Swallow: one bad handle MUST NOT strand the rest. Caller can
          // log via its own cancel callback if it wants visibility.
        }
      }),
    );
  };

  const clear: StreamHandleTable['clear'] = () => {
    handles.clear();
  };

  return { register, unregister, snapshot, count, cancelAll, clear };
}
