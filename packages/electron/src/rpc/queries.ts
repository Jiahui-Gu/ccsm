// T6.3 — React Query hook layer over Connect-ES clients.
//
// Spec ref: `docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md`
// chapter 08 §6.2 ("React Query renderer state layer").
//
// Forever-stable surface (per ch08 §6.2 + ch15 §3 zero-rework):
//   - Unary RPCs:          `use<MethodName>(input?, options?)`         → useQuery-shaped result
//   - Server-stream RPCs:  `useWatch<MethodName>(input?, options?)`    → same {data, error, isPending} shape
//   - Mutations:           `use<MethodName>Mutation(options?)`         → useMutation-shaped result
//
// All hooks return the canonical React Query result shape so v0.4 web/iOS
// can mechanically port. v0.4 web client may either move this file to
// `packages/shared-renderer/` (additive) or duplicate it; either is fine
// because the abstraction shape is locked. v0.4 iOS uses native SwiftUI
// state but maps "one hook per RPC" to a parallel Swift module.
//
// Implementation strategy:
//   - Two small generic factories (`makeUnaryHook`, `makeWatchHook`) build
//     hooks from a `(clients, input) => Promise|AsyncIterable` selector.
//     This avoids 30+ near-identical hook bodies AND keeps every RPC strongly
//     typed end-to-end (selector inference flows the message types from
//     `@ccsm/proto` through to the hook return).
//   - A `<ClientsProvider>` injects the typed clients bundle into context.
//     Hooks read it via `useClients()`. Tests can mock by wrapping with a
//     custom provider (no module-level singletons — multi-instance Electron
//     windows / web tabs / iOS scenes each get their own clients).
//   - Cache keys are derived as `[serviceName, methodName, input]` — same
//     shape across all hooks so devtools / cache invalidation stay uniform.
//
// What this file deliberately does NOT do:
//   - Construct a `Transport` (lives in main per ch08 §4.2 / T6.2).
//   - Build the `QueryClient` instance (the renderer entry wires that once).
//   - Implement reconnect/backoff (ch08 §6 has the locked schedule; React
//     Query's `retry` + `retryDelay` express it; specifics land at the boot
//     wiring site so the policy is tunable per-environment).
//   - Wrap `Hello` boot-time verification (T6.6 boot wiring owns it; the
//     unary hook surface is reused there).

import * as React from 'react';
import {
  useMutation,
  useQuery,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query';

import {
  CrashService,
  DraftService,
  NotifyService,
  PtyService,
  SessionService,
  SettingsService,
  SupervisorService,
  type CcsmClients,
} from './clients.js';

// ---------------------------------------------------------------------------
// Context — clients DI
// ---------------------------------------------------------------------------

const ClientsContext = React.createContext<CcsmClients | null>(null);

/**
 * Provider that injects a `CcsmClients` bundle (built once at boot from the
 * descriptor + transport). Wrap the renderer tree with one of these inside
 * `<QueryClientProvider>`. Tests pass a synthetic bundle here.
 */
export function ClientsProvider(props: {
  readonly clients: CcsmClients;
  readonly children?: React.ReactNode;
}): React.ReactElement {
  return React.createElement(
    ClientsContext.Provider,
    { value: props.clients },
    props.children,
  );
}

/**
 * Read the clients bundle from context. Throws if no provider is mounted —
 * a missing provider is a programming error (you forgot to wrap the tree),
 * not a runtime condition to swallow.
 */
export function useClients(): CcsmClients {
  const ctx = React.useContext(ClientsContext);
  if (ctx === null) {
    throw new Error(
      '[ccsm/rpc/queries] useClients() called outside <ClientsProvider>; ' +
        'wrap the renderer tree with <ClientsProvider clients={createClients(transport)}> ' +
        'inside <QueryClientProvider>.',
    );
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Cache-key shape — uniform across all hooks
// ---------------------------------------------------------------------------

/**
 * Cache key shape: `['ccsm', serviceName, methodName, input?]`. Uniform so
 * React Query devtools group by service, and so callers can invalidate all
 * queries for a service via `queryClient.invalidateQueries({ queryKey: ['ccsm', 'session'] })`.
 *
 * The `input` slot is the request message (or the explicit `null` sentinel
 * when an RPC takes no meaningful input — empty-message RPCs still serialize
 * to `{}` so the key is stable across calls).
 */
export type CcsmQueryKey = readonly [
  'ccsm',
  serviceName: string,
  methodName: string,
  input: unknown,
];

export function buildCcsmQueryKey(
  serviceName: string,
  methodName: string,
  input: unknown,
): CcsmQueryKey {
  // Normalize undefined → null so JSON.stringify-based key equality matches.
  return ['ccsm', serviceName, methodName, input ?? null];
}

// ---------------------------------------------------------------------------
// Generic factories
// ---------------------------------------------------------------------------

/**
 * Selector type: pulls a unary client method and invokes it. Generic over
 * the input/output message shapes so each hook keeps its proto-derived
 * types end-to-end without manual annotation.
 */
type UnarySelector<TInput, TOutput> = (
  clients: CcsmClients,
  input: TInput,
  signal: globalThis.AbortSignal,
) => Promise<TOutput>;

/**
 * Build a typed `useFoo(input, options)` hook from a unary selector. The
 * caller supplies the service + method names (used for the cache key) and
 * the selector closure. Type inference flows: `(input) => clients.session.listSessions(input)`
 * yields `useListSessions(input): UseQueryResult<ListSessionsResponse, ConnectError>`
 * with no further annotation.
 */
export function makeUnaryHook<TInput, TOutput>(
  serviceName: string,
  methodName: string,
  selector: UnarySelector<TInput, TOutput>,
): (
  input: TInput,
  options?: Omit<
    UseQueryOptions<TOutput, Error, TOutput, CcsmQueryKey>,
    'queryKey' | 'queryFn'
  >,
) => UseQueryResult<TOutput, Error> {
  return function useUnary(input, options) {
    const clients = useClients();
    return useQuery<TOutput, Error, TOutput, CcsmQueryKey>({
      queryKey: buildCcsmQueryKey(serviceName, methodName, input),
      queryFn: ({ signal }) => selector(clients, input, signal),
      ...options,
    });
  };
}

/**
 * Mutation factory — same selector signature, returns a `useMutation` hook.
 * Used for write RPCs where the caller drives invocation imperatively
 * (e.g., `useRenameSessionMutation().mutate({ sessionId, name })`).
 */
type MutationSelector<TInput, TOutput> = (
  clients: CcsmClients,
  input: TInput,
) => Promise<TOutput>;

export function makeMutationHook<TInput, TOutput>(
  selector: MutationSelector<TInput, TOutput>,
): (
  options?: UseMutationOptions<TOutput, Error, TInput>,
) => UseMutationResult<TOutput, Error, TInput> {
  return function useMutationHook(options) {
    const clients = useClients();
    return useMutation<TOutput, Error, TInput>({
      mutationFn: (input) => selector(clients, input),
      ...options,
    });
  };
}

/**
 * Server-stream selector: returns the AsyncIterable directly from the proto
 * client (Connect-ES v2 server-stream methods return `AsyncIterable<Out>`).
 */
type WatchSelector<TInput, TOutput> = (
  clients: CcsmClients,
  input: TInput,
  signal: globalThis.AbortSignal,
) => AsyncIterable<TOutput>;

/**
 * Build a typed `useWatchFoo(input, options)` hook from a server-stream
 * selector. Surface-shape parity with unary hooks (`{data, error, isPending}`)
 * so downstream UI doesn't branch on RPC kind.
 *
 * Behaviour:
 *   - Subscribes on mount via an `AbortController`-backed `for await` loop.
 *   - Each yielded message replaces `data` (the renderer typically wants
 *     the latest event; ordered-history needs are met by the server-side
 *     replay/seq machinery from ch04, not by accumulating events here).
 *   - On unmount, aborts the controller — Connect cancels the underlying
 *     stream and the `for await` loop exits cleanly.
 *   - Any thrown error sets `error` and stops the loop; the caller can
 *     remount (changing the `enabled` option) to retry. Reconnect/backoff
 *     policy is enforced at the transport / boot wiring layer (ch08 §6).
 *
 * The state shape mirrors `UseQueryResult` minus the React Query-specific
 * fields that don't apply to a stream (no `refetch`, no `isFetching`).
 */
export interface UseWatchResult<TOutput> {
  readonly data: TOutput | undefined;
  readonly error: Error | null;
  readonly isPending: boolean;
}

export interface UseWatchOptions {
  /** When false, the hook does not subscribe. Default: true. */
  readonly enabled?: boolean;
}

export function makeWatchHook<TInput, TOutput>(
  // Service / method names are accepted for parity with `makeUnaryHook` and
  // future cache integration (e.g., pushing events into a query key); the
  // current implementation does not use them but keeping the signature
  // uniform avoids a churn at v0.4 hookup time.
  _serviceName: string,
  _methodName: string,
  selector: WatchSelector<TInput, TOutput>,
): (input: TInput, options?: UseWatchOptions) => UseWatchResult<TOutput> {
  return function useWatchHook(input, options) {
    const clients = useClients();
    const enabled = options?.enabled ?? true;
    const [data, setData] = React.useState<TOutput | undefined>(undefined);
    const [error, setError] = React.useState<Error | null>(null);
    const [isPending, setIsPending] = React.useState<boolean>(enabled);

    // Stable JSON of input for effect dependency — the input object identity
    // changes every render even when contents don't, and we cannot rely on
    // structural equality in deps.
    const inputKey = React.useMemo(() => JSON.stringify(input ?? null), [input]);

    React.useEffect(() => {
      if (!enabled) {
        setIsPending(false);
        return undefined;
      }
      let cancelled = false;
      const controller = new AbortController();
      setIsPending(true);
      setError(null);

      (async () => {
        try {
          const stream = selector(clients, input, controller.signal);
          for await (const msg of stream) {
            if (cancelled) break;
            setData(msg);
            setIsPending(false);
          }
        } catch (err) {
          if (cancelled) return;
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsPending(false);
        }
      })();

      return () => {
        cancelled = true;
        controller.abort();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clients, inputKey, enabled]);

    return { data, error, isPending };
  };
}

// ---------------------------------------------------------------------------
// Per-RPC named hooks — one per spec ch08 §6.2
//
// Each block groups by service. The factory pattern keeps every hook a
// one-liner; type inference handles the rest. Adding a new RPC in v0.4 is
// "add one line below" — the proto regen exposes the method on the client,
// the selector picks it up, the hook is named per the convention.
// ---------------------------------------------------------------------------

// --- SessionService ---

export const useHello = makeUnaryHook(
  'session',
  'hello',
  (c, input: Parameters<CcsmClients['session']['hello']>[0], signal) =>
    c.session.hello(input, { signal }),
);

export const useListSessions = makeUnaryHook(
  'session',
  'listSessions',
  (c, input: Parameters<CcsmClients['session']['listSessions']>[0], signal) =>
    c.session.listSessions(input, { signal }),
);

export const useGetSession = makeUnaryHook(
  'session',
  'getSession',
  (c, input: Parameters<CcsmClients['session']['getSession']>[0], signal) =>
    c.session.getSession(input, { signal }),
);

export const useCreateSessionMutation = makeMutationHook(
  (c, input: Parameters<CcsmClients['session']['createSession']>[0]) =>
    c.session.createSession(input),
);

export const useDestroySessionMutation = makeMutationHook(
  (c, input: Parameters<CcsmClients['session']['destroySession']>[0]) =>
    c.session.destroySession(input),
);

export const useWatchSessions = makeWatchHook(
  'session',
  'watchSessions',
  (c, input: Parameters<CcsmClients['session']['watchSessions']>[0], signal) =>
    c.session.watchSessions(input, { signal }),
);

export const useRenameSessionMutation = makeMutationHook(
  (c, input: Parameters<CcsmClients['session']['renameSession']>[0]) =>
    c.session.renameSession(input),
);

export const useGetSessionTitle = makeUnaryHook(
  'session',
  'getSessionTitle',
  (c, input: Parameters<CcsmClients['session']['getSessionTitle']>[0], signal) =>
    c.session.getSessionTitle(input, { signal }),
);

export const useListProjectSessions = makeUnaryHook(
  'session',
  'listProjectSessions',
  (
    c,
    input: Parameters<CcsmClients['session']['listProjectSessions']>[0],
    signal,
  ) => c.session.listProjectSessions(input, { signal }),
);

export const useListImportableSessions = makeUnaryHook(
  'session',
  'listImportableSessions',
  (
    c,
    input: Parameters<CcsmClients['session']['listImportableSessions']>[0],
    signal,
  ) => c.session.listImportableSessions(input, { signal }),
);

export const useImportSessionMutation = makeMutationHook(
  (c, input: Parameters<CcsmClients['session']['importSession']>[0]) =>
    c.session.importSession(input),
);

// --- PtyService ---
//
// PtyService.Attach is server-stream + carries the snapshot as the first
// frame (per ch08 §3 mapping for `pty:getBufferSnapshot`). Renderer terminal
// consumes via `useWatchAttach` and discriminates `frame.kind`.

export const useWatchAttach = makeWatchHook(
  'pty',
  'attach',
  (c, input: Parameters<CcsmClients['pty']['attach']>[0], signal) =>
    c.pty.attach(input, { signal }),
);

export const useSendInputMutation = makeMutationHook(
  (c, input: Parameters<CcsmClients['pty']['sendInput']>[0]) =>
    c.pty.sendInput(input),
);

export const useResizeMutation = makeMutationHook(
  (c, input: Parameters<CcsmClients['pty']['resize']>[0]) =>
    c.pty.resize(input),
);

export const useAckPtyMutation = makeMutationHook(
  (c, input: Parameters<CcsmClients['pty']['ackPty']>[0]) =>
    c.pty.ackPty(input),
);

export const useCheckClaudeAvailable = makeUnaryHook(
  'pty',
  'checkClaudeAvailable',
  (
    c,
    input: Parameters<CcsmClients['pty']['checkClaudeAvailable']>[0],
    signal,
  ) => c.pty.checkClaudeAvailable(input, { signal }),
);

// --- CrashService ---

export const useGetCrashLog = makeUnaryHook(
  'crash',
  'getCrashLog',
  (c, input: Parameters<CcsmClients['crash']['getCrashLog']>[0], signal) =>
    c.crash.getCrashLog(input, { signal }),
);

export const useWatchCrashLog = makeWatchHook(
  'crash',
  'watchCrashLog',
  (c, input: Parameters<CcsmClients['crash']['watchCrashLog']>[0], signal) =>
    c.crash.watchCrashLog(input, { signal }),
);

export const useWatchRawCrashLog = makeWatchHook(
  'crash',
  'getRawCrashLog',
  (c, input: Parameters<CcsmClients['crash']['getRawCrashLog']>[0], signal) =>
    c.crash.getRawCrashLog(input, { signal }),
);

// --- SettingsService ---

export const useGetSettings = makeUnaryHook(
  'settings',
  'getSettings',
  (c, input: Parameters<CcsmClients['settings']['getSettings']>[0], signal) =>
    c.settings.getSettings(input, { signal }),
);

export const useUpdateSettingsMutation = makeMutationHook(
  (c, input: Parameters<CcsmClients['settings']['updateSettings']>[0]) =>
    c.settings.updateSettings(input),
);

// --- NotifyService ---

export const useWatchNotifyEvents = makeWatchHook(
  'notify',
  'watchNotifyEvents',
  (
    c,
    input: Parameters<CcsmClients['notify']['watchNotifyEvents']>[0],
    signal,
  ) => c.notify.watchNotifyEvents(input, { signal }),
);

export const useMarkUserInputMutation = makeMutationHook(
  (c, input: Parameters<CcsmClients['notify']['markUserInput']>[0]) =>
    c.notify.markUserInput(input),
);

export const useSetActiveSidMutation = makeMutationHook(
  (c, input: Parameters<CcsmClients['notify']['setActiveSid']>[0]) =>
    c.notify.setActiveSid(input),
);

export const useSetFocusedMutation = makeMutationHook(
  (c, input: Parameters<CcsmClients['notify']['setFocused']>[0]) =>
    c.notify.setFocused(input),
);

// --- DraftService ---

export const useGetDraft = makeUnaryHook(
  'draft',
  'getDraft',
  (c, input: Parameters<CcsmClients['draft']['getDraft']>[0], signal) =>
    c.draft.getDraft(input, { signal }),
);

export const useUpdateDraftMutation = makeMutationHook(
  (c, input: Parameters<CcsmClients['draft']['updateDraft']>[0]) =>
    c.draft.updateDraft(input),
);

// --- SupervisorService ---

export const useHealthCheck = makeUnaryHook(
  'supervisor',
  'healthCheck',
  (
    c,
    input: Parameters<CcsmClients['supervisor']['healthCheck']>[0],
    signal,
  ) => c.supervisor.healthCheck(input, { signal }),
);

export const useSupervisorHello = makeUnaryHook(
  'supervisor',
  'supervisorHello',
  (
    c,
    input: Parameters<CcsmClients['supervisor']['supervisorHello']>[0],
    signal,
  ) => c.supervisor.supervisorHello(input, { signal }),
);

export const useShutdownMutation = makeMutationHook(
  (c, input: Parameters<CcsmClients['supervisor']['shutdown']>[0]) =>
    c.supervisor.shutdown(input),
);

// Service descriptor re-export sentinels keep the eslint-allowed import
// surface ergonomic for downstream code that needs raw descriptors (e.g.,
// custom prefetch helpers built outside the hook layer).
export {
  CrashService,
  DraftService,
  NotifyService,
  PtyService,
  SessionService,
  SettingsService,
  SupervisorService,
};
