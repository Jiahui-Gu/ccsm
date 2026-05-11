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
//
// R-57 (Task #181): `hostConfig` is now `HostConfig | null`. When null the
// SPA main shell still renders (AppShell / Sidebar / MainPane), but the
// daemon is not Ready yet — so api calls reject with `Error('daemon not
// ready')` instead of hitting a phantom 127.0.0.1:0, and the runtime is a
// minimal stub that no-ops attach/get/sendInput. Consumers (Sidebar New
// Session button, MainPane xterm, useBootstrap) check `useHostReady()` to
// decide between active behaviour and "waiting for daemon" placeholders.
// This is the architectural fix for the black-screen / full-screen-overlay
// bug logged in Task #181: SPA UI no longer depends on daemon Ready.

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
  /**
   * Whether the daemon handshake has resolved and the runtime is wired to a
   * real HTTP base. Components use this to render placeholders (Sidebar New
   * Session disabled, MainPane "[waiting for daemon…]") instead of firing
   * doomed fetches.
   */
  hostReady: boolean;
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null);

export interface RuntimeProviderProps {
  /**
   * R-57: nullable. When null the runtime + api are stubs that reject every
   * call with `Error('daemon not ready')`; the shell tree still mounts so
   * the user sees the sidebar / status chip / sign-in panel immediately.
   */
  hostConfig: HostConfig | null;
  children: ReactNode;
}

/**
 * R-57: error thrown by every BoundApi method when hostConfig is null. Stable
 * message so callers (Sidebar, useBootstrap, MainPane) can match on it if
 * they ever need to distinguish from a real network failure.
 */
export const DAEMON_NOT_READY_ERROR = 'daemon not ready';

function makeNotReadyApi(): BoundApi {
  const reject = (): Promise<never> =>
    Promise.reject(new Error(DAEMON_NOT_READY_ERROR));
  return {
    createSession: reject,
    deleteSession: reject,
    listSessions: reject,
    resumeSession: reject,
  };
}

export function RuntimeProvider({
  hostConfig,
  children,
}: RuntimeProviderProps) {
  // useMemo so re-renders that don't change `hostConfig` reuse the same
  // runtime + api objects — critical because components subscribe long-
  // lived listeners to the runtime (MainPane.subscribeOutput) and we MUST
  // NOT throw their references away on every render.
  //
  // R-57: when hostConfig is null we still build a SessionRuntime, but with
  // a sentinel httpBase. The runtime's pub-sub (subscribeOutput / get /
  // attach) keeps working as a no-op surface so consumers don't have to
  // null-check at every call site; the api wrapper rejects every fetch so
  // no traffic is sent to the sentinel. The moment the daemon Ready event
  // lands the shell re-renders with a real hostConfig and useMemo mints a
  // fresh runtime (previous one reset() by the unmount effect below).
  const value = useMemo<RuntimeContextValue>(() => {
    const ready = hostConfig !== null;
    const httpBase = hostConfig?.httpBase ?? 'http://daemon-not-ready.invalid';
    const runtime = new SessionRuntime({
      hostBase: {
        httpBase,
        ...(hostConfig?.wsPath !== undefined ? { wsPath: hostConfig.wsPath } : {}),
      },
      statusSink: (sid, status) => {
        useStore.getState().setSessionStatus(sid, status);
      },
    });
    const api: BoundApi = ready
      ? (() => {
          const baseOpts = { baseUrl: hostConfig.httpBase };
          return {
            createSession: (token, body = {}) =>
              coreCreateSession(token, body, baseOpts),
            deleteSession: (token, sid) =>
              coreDeleteSession(token, sid, baseOpts),
            listSessions: (token) => coreListSessions(token, baseOpts),
            resumeSession: (token, sid) =>
              coreResumeSession(token, sid, baseOpts),
          };
        })()
      : makeNotReadyApi();
    return {
      runtime,
      api,
      getToken: hostConfig?.getToken ?? (() => null),
      hostReady: ready,
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

/**
 * R-57: whether the daemon is Ready and the runtime / api are live. Returns
 * false while the daemon is starting, exited, awaiting auth, or failed to
 * spawn. Components consult this to render disabled / placeholder UI
 * instead of firing fetches that the api wrapper would reject anyway.
 */
export function useHostReady(): boolean {
  const ctx = useContext(RuntimeContext);
  if (!ctx) {
    throw new Error('useHostReady must be used inside <RuntimeProvider>');
  }
  return ctx.hostReady;
}

export { HttpError };
