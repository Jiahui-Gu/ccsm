import { useEffect, type RefObject } from 'react';
import { ensureTerminal } from './xtermSingleton';

/**
 * Mount-once hook: instantiates the module-singleton xterm against the
 * provided host div on first render. Idempotent across remounts — calls
 * `ensureTerminal` which itself caches.
 *
 * The singleton (term, addons, key handler, selection→clipboard auto-copy,
 * `window.__ccsmTerm` probe handle) is created lazily inside the effect so
 * we never run xterm constructors at import time (would explode in non-DOM
 * test environments).
 *
 * Spec #592 T-4 / Task #603 (PR-4): xterm pin order — instantiation MUST
 * wait for the pty-host wire (`window.ccsmPty`) so the constructor never
 * runs against a half-initialised renderer. The host div mounts
 * unconditionally (TerminalPane), but xterm itself is gated on
 * `enabled` (caller passes `true` only after sid + pty bridge are ready).
 * When `enabled` is false the hook is a no-op and re-runs on the next
 * dependency flip, so the singleton is created exactly once at the
 * first moment both gates are open.
 */
export function useXtermSingleton(
  hostRef: RefObject<HTMLDivElement | null>,
  enabled: boolean = true,
): void {
  // No deps: we run after every render and rely on ensureTerminal's
  // module-singleton cache for idempotence. Pin order needs both gates
  // (`enabled` and `window.ccsmPty`) to be open at the same render, but
  // those flips don't always show up in the dep array — e.g. the pty
  // bridge is installed by the preload script before any renderer
  // module evaluates in production but, in tests / late-wire scenarios,
  // can land between renders without the `enabled` flag changing. A
  // no-dep effect makes the bring-up moment the first render where both
  // gates are open, independent of which gate flipped last.
  useEffect(() => {
    if (!enabled) return;
    if (!hostRef.current) return;
    // Pty-host wire gate: never instantiate xterm before the preload
    // bridge is in place. The pin order is documented in spec #592 T-4
    // PR-4 — wire-then-instantiate, never the other way around.
    if (typeof window === 'undefined' || !window.ccsmPty) return;
    ensureTerminal(hostRef.current);
  });
}
