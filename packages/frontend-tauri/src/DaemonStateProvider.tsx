// Task #112-T3: DaemonStateProvider — listens to the unified `daemon-state`
// Tauri event channel (T1, daemon_state.rs) and exposes the latest payload
// to descendants via React context.
//
// Bootstrap is non-blocking: `main.tsx` mounts React immediately with a
// default `notSpawned` state; this provider attaches the listener inside a
// useEffect so the first render does not block on Tauri IPC. Stale events
// from previous bootstraps are filtered by the monotonic `generation`
// counter — we never roll back generation.

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type PropsWithChildren,
} from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { DaemonPhase, DaemonStatePayload } from './types';

const INITIAL_STATE: DaemonStatePayload = {
  generation: 0,
  phase: 'notSpawned',
};

export const DaemonStateContext =
  createContext<DaemonStatePayload>(INITIAL_STATE);

export function DaemonStateProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<DaemonStatePayload>(INITIAL_STATE);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    void listen<DaemonStatePayload>('daemon-state', (e) => {
      const payload = e.payload;
      // Drop stale events: generation is monotonic (daemon_state.rs bumps on
      // every transition), so any payload with a lower generation than what
      // we already have is from a previous bootstrap or out-of-order delivery.
      setState((prev) =>
        payload.generation >= prev.generation ? payload : prev,
      );
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return (
    <DaemonStateContext.Provider value={state}>
      {children}
    </DaemonStateContext.Provider>
  );
}

export function useDaemonState(): DaemonStatePayload {
  return useContext(DaemonStateContext);
}

export function useDaemonPhase(): DaemonPhase {
  const { generation: _g, ...rest } = useContext(DaemonStateContext);
  // The context value is `{ generation } & DaemonPhase` (a flattened union),
  // so stripping `generation` yields the discriminated union.
  return rest as DaemonPhase;
}
