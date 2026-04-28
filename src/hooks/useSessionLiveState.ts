// Per-session live state from the JSONL tail-watcher (electron/sessionWatcher).
// Subscribes once at app mount and exposes a sid → state map. Components
// read with the `selectorForSid` form to avoid re-rendering the whole
// sidebar when one row changes.

import { useSyncExternalStore } from 'react';
import type { SessionState } from '../session';

type StateMap = Record<string, SessionState>;

let current: StateMap = {};
const subscribers = new Set<() => void>();
let bridgeInstalled = false;
let unsubscribeBridge: (() => void) | null = null;

function notify(): void {
  for (const cb of subscribers) {
    try {
      cb();
    } catch (err) {
      console.error('[useSessionState] subscriber threw', err);
    }
  }
}

function ensureBridge(): void {
  if (bridgeInstalled) return;
  bridgeInstalled = true;
  // `window.ccsmSession` is missing in tests / storybook / mock env. Bail
  // silently — the hook just returns undefined for every sid, which the
  // Sidebar treats as "no dot".
  type Bridge = { onState: (cb: (e: { sid: string; state: SessionState }) => void) => () => void };
  const bridge = (window as unknown as { ccsmSession?: Bridge }).ccsmSession;
  if (!bridge || typeof bridge.onState !== 'function') return;
  unsubscribeBridge = bridge.onState((evt) => {
    const prev = current[evt.sid];
    if (prev === evt.state) return;
    current = { ...current, [evt.sid]: evt.state };
    notify();
  });
}

function subscribe(cb: () => void): () => void {
  ensureBridge();
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
    // Don't tear down the bridge — other subscribers may still want it,
    // and re-subscribing across hot module reloads cheaply replays state
    // from the next watcher tick.
  };
}

const EMPTY: StateMap = {};
function getSnapshot(): StateMap {
  return current;
}
function getServerSnapshot(): StateMap {
  return EMPTY;
}

/**
 * Returns the live state for a single sid, or undefined if no event has
 * been received yet (treated as "unknown" → no dot rendered).
 *
 * Implemented via `useSyncExternalStore` over a module-level map so
 * sibling rows don't re-render when an unrelated session's state flips.
 */
export function useSessionLiveState(sid: string): SessionState | undefined {
  const map = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return map[sid];
}

// Test helpers — never imported by app code.
export function __setForTest(sid: string, state: SessionState): void {
  current = { ...current, [sid]: state };
  notify();
}
export function __resetForTest(): void {
  current = {};
  if (unsubscribeBridge) {
    unsubscribeBridge();
    unsubscribeBridge = null;
  }
  bridgeInstalled = false;
  subscribers.clear();
}
