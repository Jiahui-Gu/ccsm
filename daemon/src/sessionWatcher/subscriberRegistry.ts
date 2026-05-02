// Multi-subscriber fan-out for `SubscribeSessionEvents` (daemon-side).
//
// Task #106. Mirrors the v0.3 PTY `fanout-registry.ts` shape but with
// two key differences:
//
//   1. Subscribers may be PER-SESSION (subscribe to one sessionId) or
//      FIRESHOSE (subscribe to "" → receive every session's events).
//      Per-session subscribers are routed by sessionId; firehose
//      subscribers receive everything.
//
//   2. Backpressure is owner-managed: the Connect handler tracks its
//      own per-subscriber outbound queue length and decides when to
//      apply the snapshot-replay budget (frag-3.5.1 res-P0-1 §3.5.1.4
//      generalized). The registry is fan-out-only.
//
// SRP:
//   - Producer: `broadcast(evt)` invoked by the state machine's `emit`
//     callback.
//   - Sink: per-subscriber `deliver(evt)` (sync, try/catch wrapped).
//   - Knows nothing about Connect, proto, or HTTP/2.

import type { SessionEventPojo } from './sessionState.js';

export interface SessionSubscriber {
  /** Invoked once per matching event. MUST NOT throw to caller — the
   *  registry catches and logs so one slow subscriber cannot poison
   *  others (mirrors PTY fanout-registry §3.5.1.5). */
  deliver(evt: SessionEventPojo): void;
  /** Invoked once when the registry drains this subscriber. Reasons
   *  match the proto-side end-reason vocabulary plus the registry-
   *  internal `daemon-shutdown`. */
  close(reason: SessionDrainReason): void;
}

export type SessionDrainReason =
  | { kind: 'session-removed'; sessionId: string }
  | { kind: 'daemon-shutdown' }
  | { kind: 'caller-cancel' };

interface RegistryEntry {
  subscriber: SessionSubscriber;
  /** "" → firehose; non-empty → only events for this sessionId. */
  filter: string;
}

export interface SessionSubscriberRegistry {
  /** Subscribe `subscriber` to events for `sessionId`. Pass empty
   *  string for firehose (every session). Returns an unsubscribe
   *  function (idempotent — calling it twice is a no-op). */
  subscribe(sessionId: string, subscriber: SessionSubscriber): () => void;
  /** Synchronously fan-out one event to every matching subscriber.
   *  Iteration is over a snapshot taken at call entry, so subscribers
   *  added/removed mid-broadcast do not affect this broadcast. */
  broadcast(evt: SessionEventPojo): void;
  /** Bulk-close every subscriber for `sessionId`. Each subscriber's
   *  `close()` is invoked exactly once. Firehose subscribers are NOT
   *  closed by this — they survive per-session removal. */
  drainSession(sessionId: string): void;
  /** Bulk-close every subscriber across all sessions. Used at daemon
   *  shutdown. */
  drainAll(): void;
  /** Test seam: subscriber count, optionally filtered by sessionId
   *  (or "" for firehose-only). */
  size(sessionId?: string): number;
}

export interface SessionSubscriberRegistryOptions {
  /** Optional logger for caught subscriber errors. Defaults to
   *  `console.warn`. */
  onSubscriberError?: (
    err: unknown,
    ctx: { sessionId: string; phase: 'deliver' | 'close' },
  ) => void;
}

export function createSessionSubscriberRegistry(
  opts: SessionSubscriberRegistryOptions = {},
): SessionSubscriberRegistry {
  const onError =
    opts.onSubscriberError ??
    ((err, ctx): void => {
      console.warn(
        `[sessionWatcher] subscriber ${ctx.phase} threw for sid=${ctx.sessionId}:`,
        err instanceof Error ? err.message : err,
      );
    });

  const entries = new Set<RegistryEntry>();

  function subscribe(
    sessionId: string,
    subscriber: SessionSubscriber,
  ): () => void {
    const entry: RegistryEntry = { subscriber, filter: sessionId };
    entries.add(entry);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      entries.delete(entry);
    };
  }

  function broadcast(evt: SessionEventPojo): void {
    const evtSid = sessionIdOf(evt);
    // Snapshot first so concurrent subscribe/unsubscribe doesn't
    // perturb this iteration.
    const snapshot = [...entries];
    for (const e of snapshot) {
      if (e.filter !== '' && e.filter !== evtSid) continue;
      try {
        e.subscriber.deliver(evt);
      } catch (err) {
        onError(err, { sessionId: evtSid, phase: 'deliver' });
      }
    }
  }

  function drainSession(sessionId: string): void {
    const snapshot = [...entries];
    for (const e of snapshot) {
      // Only close per-session subscribers for this session. Firehose
      // subscribers (filter='') survive.
      if (e.filter !== sessionId) continue;
      entries.delete(e);
      try {
        e.subscriber.close({ kind: 'session-removed', sessionId });
      } catch (err) {
        onError(err, { sessionId, phase: 'close' });
      }
    }
  }

  function drainAll(): void {
    const snapshot = [...entries];
    entries.clear();
    for (const e of snapshot) {
      try {
        e.subscriber.close({ kind: 'daemon-shutdown' });
      } catch (err) {
        onError(err, { sessionId: e.filter, phase: 'close' });
      }
    }
  }

  function size(sessionId?: string): number {
    if (sessionId === undefined) return entries.size;
    let n = 0;
    for (const e of entries) if (e.filter === sessionId) n += 1;
    return n;
  }

  return { subscribe, broadcast, drainSession, drainAll, size };
}

function sessionIdOf(evt: SessionEventPojo): string {
  switch (evt.kind) {
    case 'snapshot':
      return evt.snapshot.sessionId;
    case 'delta':
    case 'heartbeat':
    case 'boot_changed':
      return evt.sessionId;
  }
}
