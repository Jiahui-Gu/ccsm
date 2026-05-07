// RuntimeProvider — single React-side wiring point for @ccsm/ui.
//
// Wave-2 T6 (#686). Owns:
//   - one @ccsm/core SessionRuntime instance, constructed with the shell's
//     HostConfig and a statusSink that fans WsStatus edges into our zustand
//     store (useStore.getState().setSessionStatus).
//   - bound REST API helpers (createSession / deleteSession / listSessions
//     / resumeSession + HttpError) with the shell's baseUrl pre-injected,
//     so component code doesn't see SessionsApiOptions.
//
// Both shells (frontend-web today, frontend-tauri at T10) wrap their root
// in a single <RuntimeProvider hostConfig={...}>, then components consume
// the runtime + api via `useRuntime()` / `useApi()`. Provider keeps the
// runtime singleton-per-mount (one instance per <RuntimeProvider>) so a
// shell that re-mounts (e.g. Tauri reload after handshake redo) gets a
// fresh runtime; the previous one is reset on unmount.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import {
  HttpError,
  SessionRuntime,
  createSession as coreCreateSession,
  deleteSession as coreDeleteSession,
  listSessions as coreListSessions,
  resumeSession as coreResumeSession,
} from '@ccsm/core';
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  DeleteSessionResponse,
  ListSessionsResponse,
} from '@ccsm/shared';
import { useStore } from './store';
import type { HostConfig } from './types';

export interface BoundApi {
  createSession: (
    token: string,
    body?: CreateSessionRequest,
  ) => Promise<CreateSessionResponse>;
  deleteSession: (
    token: string,
    sid: string,
  ) => Promise<DeleteSessionResponse>;
  listSessions: (token: string) => Promise<ListSessionsResponse>;
  resumeSession: (token: string, sid: string) => Promise<{ ok: true }>;
}

export interface RuntimeContextValue {
  runtime: SessionRuntime;
  api: BoundApi;
  /** Read-through to HostConfig.getToken — components call this at action time. */
  getToken: () => string | null;
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null);

export interface RuntimeProviderProps {
  hostConfig: HostConfig;
  children: ReactNode;
}

export function RuntimeProvider({
  hostConfig,
  children,
}: RuntimeProviderProps) {
  // useMemo so re-renders that don't change `hostConfig` reuse the same
  // runtime + api objects — critical because components subscribe long-
  // lived listeners to the runtime (MainPane.subscribeOutput) and we MUST
  // NOT throw their references away on every render.
  const value = useMemo<RuntimeContextValue>(() => {
    const runtime = new SessionRuntime({
      hostBase: { httpBase: hostConfig.httpBase },
      statusSink: (sid, status) => {
        useStore.getState().setSessionStatus(sid, status);
      },
    });
    const baseOpts = { baseUrl: hostConfig.httpBase };
    const api: BoundApi = {
      createSession: (token, body = {}) =>
        coreCreateSession(token, body, baseOpts),
      deleteSession: (token, sid) => coreDeleteSession(token, sid, baseOpts),
      listSessions: (token) => coreListSessions(token, baseOpts),
      resumeSession: (token, sid) => coreResumeSession(token, sid, baseOpts),
    };
    return {
      runtime,
      api,
      getToken: hostConfig.getToken,
    };
  }, [hostConfig]);

  // Tear the runtime down on unmount: closes every ws, clears reconnect
  // timers, drops scrollback. A fresh <RuntimeProvider> mount will mint a
  // new runtime via useMemo above.
  useEffect(() => {
    const r = value.runtime;
    return () => {
      r.reset();
    };
  }, [value]);

  return (
    <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>
  );
}

export function useRuntime(): SessionRuntime {
  const ctx = useContext(RuntimeContext);
  if (!ctx) {
    throw new Error('useRuntime must be used inside <RuntimeProvider>');
  }
  return ctx.runtime;
}

export function useApi(): BoundApi {
  const ctx = useContext(RuntimeContext);
  if (!ctx) {
    throw new Error('useApi must be used inside <RuntimeProvider>');
  }
  return ctx.api;
}

export function useGetToken(): () => string | null {
  const ctx = useContext(RuntimeContext);
  if (!ctx) {
    throw new Error('useGetToken must be used inside <RuntimeProvider>');
  }
  return ctx.getToken;
}

export { HttpError };
