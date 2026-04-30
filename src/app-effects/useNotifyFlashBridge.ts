import { useEffect } from 'react';
import { useStore } from '../stores/store';

/**
 * Pipe `notify:flash` IPC events from main into the store. The flash sink
 * (`electron/notify/sinks/flashSink.ts`) sets `flashStates[sid] = true`
 * for transient pulses driven by the 7-rule decider — Rule 2 (foreground
 * active sid + short task) is flash-only with no toast, so the AgentIcon
 * halo MUST react to this signal in addition to `state === 'waiting'`.
 * Auto-clear is driven by main's 4s timer, which pushes `{on:false}`.
 *
 * Extracted from App.tsx for SRP under Task #758 Phase C. Reaches into
 * `useStore.getState()._setFlash` directly (not via injected dep) to
 * preserve the original mount-once `[]` dependency semantics — the
 * store's setter identity is stable for the app lifetime.
 */
export function useNotifyFlashBridge(): void {
  useEffect(() => {
    type Bridge = { onFlash?: (cb: (e: { sid: string; on: boolean }) => void) => () => void };
    const bridge = (window as unknown as { ccsmNotify?: Bridge }).ccsmNotify;
    if (!bridge || typeof bridge.onFlash !== 'function') return;
    return bridge.onFlash((evt) => {
      if (!evt || typeof evt.sid !== 'string' || evt.sid.length === 0) return;
      useStore.getState()._setFlash(evt.sid, evt.on === true);
    });
  }, []);
}
