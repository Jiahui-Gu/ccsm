// T6.7 — React Context + hook for the renderer's daemon connection.
//
// Spec ref: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
// chapter 08 §6 (renderer error contract) + §6.1 (cold-start UX) + ch03
// §3.3 (boot_id verification).
//
// Responsibilities (sink-side wiring only — pure logic lives in
// `hello.ts` + `reconnect.ts`):
//
//   1. On mount: drive `runWithReconnect(performHello, ...)` until the
//      first Hello succeeds. State machine starts in `connecting`.
//   2. On success: pin the `bootId` for the connection lifetime; flip
//      state to `connected`. Build the `CcsmClients` bundle once and
//      expose it via context. (T6.6 boot wiring composes this provider
//      INSIDE the existing `<ClientsProvider>` from T6.3 — see
//      `react-entry-example.tsx` siblings of this file.)
//   3. On `HelloVersionMismatchError`: flip to `version-mismatch`; do
//      NOT loop. Caller's UI renders the blocking modal per ch08 §6.
//   4. On any other error: keep retrying via the backoff schedule;
//      surface "Reconnecting..." via state.
//   5. On reconnect (transport dropped): re-call `performHello`. If the
//      new `bootId` differs from the pinned one → daemon restarted →
//      invalidate ALL React Query caches (`queryClient.invalidateQueries(
//      { queryKey: ['ccsm'] })` per T6.3 cache-key shape) AND fire the
//      `onDaemonRestart` callback so the call site can show the
//      "reconnected after daemon restart" toast.
//   6. On unmount: abort the in-flight attempt + the backoff sleep.
//
// Why a hook + context, not a Zustand store: T6.3 already pins React
// Context as the DI seam (`<ClientsProvider>` / `useClients`); adding a
// store here would be a second source of truth for "is the daemon up".
// One mechanism, audited by the existing useClients() guard.
//
// Single responsibility:
//   - producer: the connection state events (state transitions).
//   - decider: deferred to `hello.ts` / `reconnect.ts` (pure).
//   - sink: React state setters + queryClient.invalidateQueries.
//
// What this file deliberately does NOT do:
//   - Build the Connect transport (caller injects `buildTransport`; T6.6
//     stitches in `connect-web`'s `createConnectTransport`).
//   - Construct `QueryClient` (renderer entry owns it).
//   - Render the cold-start modal or toast (the call site does — this
//     hook surfaces state; UX renders it).

import * as React from 'react';
import type { Transport } from '@connectrpc/connect';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';

import {
  performHello,
  HelloVersionMismatchError,
  type HelloResult,
  type PerformHelloDeps,
} from './hello.js';
import { runWithReconnect } from './reconnect.js';
import type { DescriptorV1 } from '../../main/protocol-app.js';

/** Discriminated state of the renderer ↔ daemon connection. */
export type ConnectionState =
  | { readonly kind: 'connecting'; readonly attempt: number }
  | {
      readonly kind: 'connected';
      readonly bootId: string;
      readonly daemonVersion: string;
      readonly protoVersion: number;
      readonly listenerId: string;
    }
  | {
      readonly kind: 'reconnecting';
      readonly attempt: number;
      readonly nextDelayMs: number;
      readonly previousBootId: string | null;
    }
  | {
      readonly kind: 'version-mismatch';
      readonly daemonProtoVersion: number | null;
      readonly clientMinVersion: number;
    };

/** Events emitted by the connection driver — used by the toast surface. */
export interface ConnectionEvents {
  /** Daemon's boot_id changed across a reconnect → caches were nuked. */
  readonly onDaemonRestart?: (params: {
    readonly previousBootId: string;
    readonly currentBootId: string;
  }) => void;
  /** First successful Hello after mount. Useful for telemetry. */
  readonly onConnected?: (result: HelloResult) => void;
  /** Each backoff schedule tick. Useful for "Reconnecting..." banner. */
  readonly onBackoff?: (delayMs: number, attempt: number) => void;
}

/** Public hook return — what consumers read. */
export interface UseConnectionResult {
  readonly state: ConnectionState;
  /** Force an immediate reconnect (resets attempt counter). */
  readonly retryNow: () => void;
}

const ConnectionContext = React.createContext<UseConnectionResult | null>(null);

/** Read the connection state from context. Throws if no provider mounted. */
export function useConnection(): UseConnectionResult {
  const ctx = React.useContext(ConnectionContext);
  if (ctx === null) {
    throw new Error(
      '[ccsm/renderer/connection] useConnection() called outside ' +
        '<ConnectionProvider>; wrap renderer tree with one inside ' +
        '<QueryClientProvider>.',
    );
  }
  return ctx;
}

/** Props for `<ConnectionProvider>`. */
export interface ConnectionProviderProps {
  /** Build a Connect transport from the latest descriptor. */
  readonly buildTransport: (descriptor: DescriptorV1) => Transport;
  /** Override descriptor fetch; defaults to `defaultFetchDescriptor`. */
  readonly fetchDescriptor?: PerformHelloDeps['fetchDescriptor'];
  /** Toast / telemetry hooks. */
  readonly events?: ConnectionEvents;
  /** Override the `QueryClient` (defaults to nearest `useQueryClient()`). */
  readonly queryClient?: QueryClient;
  readonly children?: React.ReactNode;
}

/**
 * Drive the renderer ↔ daemon connection lifecycle. Renders children
 * unconditionally — the call site reads `useConnection()` to decide
 * whether to show the cold-start modal / "Reconnecting..." banner /
 * the real UI.
 *
 * Why unconditional render: the renderer's `<App>` typically has UI that
 * is ALWAYS visible (window chrome, settings) regardless of daemon
 * status. Gating render here would prevent that. The blocking-modal UX
 * from ch08 §6.1 is a portal layered on top, not a tree replacement.
 */
export function ConnectionProvider(
  props: ConnectionProviderProps,
): React.ReactElement {
  // Resolve the QueryClient at render time so tests can pass an explicit one.
  // The hook MUST be called unconditionally per react-hooks rules; we
  // discriminate after the call.
  const ctxQueryClient = useQueryClient();
  const queryClient = props.queryClient ?? ctxQueryClient;

  const [state, setState] = React.useState<ConnectionState>({
    kind: 'connecting',
    attempt: 0,
  });

  // Pin the bootId across reconnects so we can detect daemon restart.
  // Stored in a ref because changes here MUST NOT trigger re-render — only
  // the resulting setState calls do.
  const pinnedBootIdRef = React.useRef<string | null>(null);

  // Trigger ref — bumping forces the effect to re-run (used by retryNow).
  const [retryToken, setRetryToken] = React.useState(0);

  // Stash mutable callbacks in a ref so the effect doesn't re-run when the
  // caller passes inline closures.
  const eventsRef = React.useRef(props.events);
  eventsRef.current = props.events;

  const buildTransportRef = React.useRef(props.buildTransport);
  buildTransportRef.current = props.buildTransport;

  const fetchDescriptorRef = React.useRef(props.fetchDescriptor);
  fetchDescriptorRef.current = props.fetchDescriptor;

  React.useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      try {
        const result = await runWithReconnect<HelloResult>({
          signal: controller.signal,
          shouldRetry: (err) => !(err instanceof HelloVersionMismatchError),
          onBackoff: (delayMs, attemptIdx) => {
            if (cancelled) return;
            // attemptIdx is the index that JUST failed; the next attempt is
            // attemptIdx + 1. Surface the upcoming wait so the UI banner
            // can render "Reconnecting in Xs..." accurately.
            setState({
              kind: 'reconnecting',
              attempt: attemptIdx + 1,
              nextDelayMs: delayMs,
              previousBootId: pinnedBootIdRef.current,
            });
            eventsRef.current?.onBackoff?.(delayMs, attemptIdx);
          },
          attempt: async (attemptIdx) => {
            if (cancelled) throw new DOMException('Aborted', 'AbortError');
            // First attempt of a fresh mount/retry: state is 'connecting';
            // subsequent failures will have flipped via onBackoff already.
            if (attemptIdx === 0) {
              setState({ kind: 'connecting', attempt: 0 });
            }
            const fetchDescriptor =
              fetchDescriptorRef.current ??
              (await import('./hello.js')).defaultFetchDescriptor;
            return performHello({
              fetchDescriptor,
              buildTransport: buildTransportRef.current,
              signal: controller.signal,
            });
          },
        });

        if (cancelled) return;

        // (5) boot_id mismatch detection. `pinnedBootIdRef.current` is
        // null on the FIRST successful connect (no prior to compare against).
        const previousBootId = pinnedBootIdRef.current;
        pinnedBootIdRef.current = result.bootId;

        if (previousBootId !== null && previousBootId !== result.bootId) {
          // Daemon restarted between our last connect and this one. Per
          // T6.3 cache-key shape: every CCSM hook keys under `['ccsm', ...]`.
          // Invalidating that prefix nukes ALL cached daemon state in one
          // call so stale data (PIDs, session lists, settings) cannot be
          // served from the previous daemon's view.
          queryClient.invalidateQueries({ queryKey: ['ccsm'] });
          eventsRef.current?.onDaemonRestart?.({
            previousBootId,
            currentBootId: result.bootId,
          });
        }

        setState({
          kind: 'connected',
          bootId: result.bootId,
          daemonVersion: result.daemonVersion,
          protoVersion: result.protoVersion,
          listenerId: result.listenerId,
        });
        eventsRef.current?.onConnected?.(result);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (err instanceof HelloVersionMismatchError) {
          setState({
            kind: 'version-mismatch',
            daemonProtoVersion: err.daemonProtoVersion,
            clientMinVersion: err.clientMinVersion,
          });
          return;
        }
        // Should be unreachable — runWithReconnect's default `shouldRetry`
        // only stops on the version-mismatch class above. Defensive log.
        // eslint-disable-next-line no-console
        console.error(
          '[ccsm/renderer/connection] runWithReconnect surfaced unexpected error:',
          err,
        );
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // queryClient identity is stable across renders inside one
    // QueryClientProvider; retryToken bump forces a fresh attempt loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryToken, queryClient]);

  const retryNow = React.useCallback(() => {
    setRetryToken((n) => n + 1);
  }, []);

  const value = React.useMemo<UseConnectionResult>(
    () => ({ state, retryNow }),
    [state, retryNow],
  );

  return React.createElement(
    ConnectionContext.Provider,
    { value },
    props.children,
  );
}
