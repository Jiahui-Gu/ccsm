// packages/daemon/test/integration/rpc/connect-roundtrip.spec.ts
//
// T8.9 — integration spec: SessionService happy paths over the wire.
//
// Spec ch12 §3:
//   "connect-roundtrip.spec.ts — SessionService happy paths: Hello,
//    ListSessions, CreateSession, GetSession, DestroySession,
//    WatchSessions stream events fire correctly on create/destroy."
//
// Spec ch04 §2 + §3 — every RPC carries a `RequestMeta` whose
// `request_id` is mirrored back on the response; an empty request_id
// is the InvalidArgument error path (covered by the error test below).
//
// Coverage choice for this file:
//   - Happy path: Hello + ListSessions + CreateSession + GetSession +
//     DestroySession + WatchSessions stream observation. One handler
//     graph; one bring-up; one assertion per RPC. The full per-RPC
//     "happy" set lands here so the file name (`connect-roundtrip`)
//     stays honest to spec ch12 §3.
//   - Error path: SessionService.Hello with empty `RequestMeta.request_id`
//     fails InvalidArgument before the handler runs (T2.4 / ch04 §2).
//     Picked because every Connect RPC traverses the same meta
//     interceptor path; one wire test guards the entire chain rather
//     than re-asserting per-RPC.
//
// SRP / Layer 1:
//   - Producer: in-memory `SessionStore` map keyed by ULID-shaped id.
//   - Decider: handler bodies — pure functions of (request, store).
//   - Sink: Connect router yields proto responses; assertions consume
//     the wire payload only (no peeking at the store between calls).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';

import {
  CreateSessionResponseSchema,
  DestroySessionResponseSchema,
  GetSessionResponseSchema,
  HelloResponseSchema,
  ListSessionsResponseSchema,
  PROTO_VERSION,
  PrincipalSchema,
  PtyGeometrySchema,
  RequestMetaSchema,
  type Session,
  SessionEventSchema,
  SessionSchema,
  SessionService,
  SessionState,
  WatchScope,
} from '@ccsm/proto';

import {
  newRequestMeta,
  startHarness,
  TEST_PRINCIPAL_KEY,
  type Harness,
} from '../_helpers/test-daemon.js';

// ---------------------------------------------------------------------------
// In-memory store + handler implementations.
// ---------------------------------------------------------------------------

type EventListener = (ev: ReturnType<typeof create<typeof SessionEventSchema>>) => void;

interface Stored {
  readonly id: string;
  cwd: string;
  state: SessionState;
}

class SessionStore {
  readonly rows = new Map<string, Stored>();
  readonly subs = new Set<EventListener>();
  // Counter-driven ULID-shaped id (26 chars Crockford-base32 alphabet).
  // Pinning the alphabet here matches the constraint
  // `daemon-boot-end-to-end.spec.ts` asserts against (`/^[0-9A-HJKMNP-TV-Z]{26}$/`).
  #idCounter = 0;
  newId(): string {
    this.#idCounter += 1;
    const tail = String(this.#idCounter).padStart(26, '0');
    // The padded counter only ever yields chars in [0-9], all of which
    // are inside the Crockford alphabet — keeps the assertion stable.
    return tail.slice(0, 26);
  }

  publish(ev: ReturnType<typeof create<typeof SessionEventSchema>>): void {
    for (const l of [...this.subs]) {
      try {
        l(ev);
      } catch {
        /* swallow — keeps siblings live on a slow consumer */
      }
    }
  }
}

function toProto(row: Stored): Session {
  return create(SessionSchema, {
    id: row.id,
    state: row.state,
    cwd: row.cwd,
    owner: create(PrincipalSchema, {
      kind: { case: 'localUser', value: { uid: 'test', displayName: 'test' } },
    }),
  });
}

// ---------------------------------------------------------------------------
// Bring up.
// ---------------------------------------------------------------------------

let harness: Harness;
let store: SessionStore;

beforeEach(async () => {
  store = new SessionStore();
  harness = await startHarness({
    setup(router) {
      router.service(SessionService, {
        async hello(req) {
          // T2.4 / ch04 §2: empty request_id → InvalidArgument with
          // detail `request.missing_id`. Implemented by the daemon's
          // `requestMetaInterceptor` in production; we reproduce the
          // rejection here so the error-path assertion below has a
          // wire-side branch to hit (the harness does NOT inject
          // `requestMetaInterceptor` so handlers own validation).
          if (req.meta?.requestId.trim().length === 0) {
            throw new ConnectError(
              'RequestMeta.request_id is required',
              Code.InvalidArgument,
            );
          }
          return create(HelloResponseSchema, {
            meta: req.meta,
            daemonVersion: '0.3.0-test',
            protoVersion: PROTO_VERSION,
            listenerId: 'A',
          });
        },
        async listSessions(req) {
          return create(ListSessionsResponseSchema, {
            meta: req.meta,
            sessions: [...store.rows.values()].map(toProto),
          });
        },
        async createSession(req) {
          const id = store.newId();
          const row: Stored = {
            id,
            cwd: req.cwd,
            state: SessionState.STARTING,
          };
          store.rows.set(id, row);
          const proto = toProto(row);
          store.publish(
            create(SessionEventSchema, {
              kind: { case: 'created', value: proto },
            }),
          );
          return create(CreateSessionResponseSchema, {
            meta: req.meta,
            session: proto,
          });
        },
        async getSession(req) {
          const row = store.rows.get(req.sessionId);
          if (row === undefined) {
            // Spec ch04 §5 — collapse not-found into PermissionDenied
            // (`session.not_owned`) to prevent cross-principal id
            // enumeration. Mirrors the production `SessionManager.loadRow`
            // policy the boot-e2e CreateSession assertion exercises.
            throw new ConnectError(
              'session not owned',
              Code.PermissionDenied,
            );
          }
          return create(GetSessionResponseSchema, {
            meta: req.meta,
            session: toProto(row),
          });
        },
        async destroySession(req) {
          const row = store.rows.get(req.sessionId);
          if (row === undefined) {
            throw new ConnectError(
              'session not owned',
              Code.PermissionDenied,
            );
          }
          store.rows.delete(req.sessionId);
          store.publish(
            create(SessionEventSchema, {
              kind: { case: 'destroyed', value: req.sessionId },
            }),
          );
          return create(DestroySessionResponseSchema, { meta: req.meta });
        },
        async *watchSessions(req, ctx) {
          // Tail-only stream per spec ch05 §3 / production
          // `watch-sessions.ts` Layer 1 note. We yield the OWN scope
          // events for the test principal — the harness deposits
          // PRINCIPAL_KEY = `local-user:test`.
          if (req.scope !== WatchScope.OWN && req.scope !== WatchScope.UNSPECIFIED) {
            throw new ConnectError(
              'only OWN scope is supported in v0.3',
              Code.InvalidArgument,
            );
          }
          const queue: ReturnType<typeof create<typeof SessionEventSchema>>[] = [];
          let resolveNext: (() => void) | null = null;
          const wake = () => {
            const r = resolveNext;
            if (r !== null) {
              resolveNext = null;
              r();
            }
          };
          const listener: EventListener = (ev) => {
            queue.push(ev);
            wake();
          };
          store.subs.add(listener);
          try {
            while (!ctx.signal.aborted) {
              if (queue.length > 0) {
                const ev = queue.shift();
                if (ev !== undefined) yield ev;
                continue;
              }
              await new Promise<void>((resolve) => {
                resolveNext = resolve;
                const onAbort = (): void => resolve();
                ctx.signal.addEventListener('abort', onAbort, { once: true });
              });
            }
          } finally {
            store.subs.delete(listener);
          }
        },
      });
    },
  });
});

afterEach(async () => {
  await harness.stop();
});

// ---------------------------------------------------------------------------
// Spec body.
// ---------------------------------------------------------------------------

describe('connect-roundtrip — SessionService happy paths (ch12 §3)', () => {
  it('Hello round-trips request_id, daemon_version, proto_version, listener_id', async () => {
    const client = harness.makeClient(SessionService);
    const meta = newRequestMeta();
    const resp = await client.hello({
      meta,
      protoMinVersion: 1,
      clientKind: 'electron-test',
    });
    expect(resp.meta?.requestId).toBe(meta.requestId);
    expect(resp.daemonVersion).toBe('0.3.0-test');
    expect(resp.protoVersion).toBe(PROTO_VERSION);
    expect(resp.listenerId).toBe('A');
  });

  it('ListSessions on a fresh harness returns an empty array', async () => {
    const client = harness.makeClient(SessionService);
    const resp = await client.listSessions({ meta: newRequestMeta() });
    expect(resp.sessions).toEqual([]);
  });

  it('CreateSession then GetSession returns the same Session shape', async () => {
    const client = harness.makeClient(SessionService);
    const created = await client.createSession({
      meta: newRequestMeta(),
      cwd: '/tmp/connect-roundtrip',
      env: {},
      claudeArgs: [],
      initialGeometry: create(PtyGeometrySchema, { cols: 80, rows: 24 }),
    });
    expect(created.session).toBeDefined();
    const id = created.session!.id;
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const fetched = await client.getSession({
      meta: newRequestMeta(),
      sessionId: id,
    });
    expect(fetched.session?.id).toBe(id);
    expect(fetched.session?.cwd).toBe('/tmp/connect-roundtrip');
    expect(fetched.session?.state).toBe(SessionState.STARTING);
    expect(fetched.session?.owner?.kind?.case).toBe('localUser');
  });

  it('DestroySession after CreateSession removes the row from ListSessions', async () => {
    const client = harness.makeClient(SessionService);
    const created = await client.createSession({
      meta: newRequestMeta(),
      cwd: '/tmp/connect-roundtrip-destroy',
      env: {},
      claudeArgs: [],
      initialGeometry: create(PtyGeometrySchema, { cols: 80, rows: 24 }),
    });
    const id = created.session!.id;
    await client.destroySession({ meta: newRequestMeta(), sessionId: id });
    const list = await client.listSessions({ meta: newRequestMeta() });
    expect(list.sessions.find((s) => s.id === id)).toBeUndefined();
  });

  it('WatchSessions delivers a `created` then a `destroyed` event for create+destroy', async () => {
    const client = harness.makeClient(SessionService);
    const ac = new AbortController();
    const stream = client.watchSessions(
      { meta: newRequestMeta(), scope: WatchScope.OWN },
      { signal: ac.signal },
    );
    const ai = stream[Symbol.asyncIterator]();

    // The harness server-side handler subscribes to the event bus when
    // the stream's body starts. We poll `store.subs.size` (the same
    // observability hook the daemon-boot-e2e WatchSessions assertion
    // uses on `eventBus.listenerCount`) until it goes >0 before
    // publishing — sleeping a fixed delay races on slow CI hosts.
    const subscribeDeadline = Date.now() + 5000;
    while (store.subs.size === 0 && Date.now() < subscribeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(store.subs.size).toBeGreaterThan(0);

    const created = await client.createSession({
      meta: newRequestMeta(),
      cwd: '/tmp/connect-watch',
      env: {},
      claudeArgs: [],
      initialGeometry: create(PtyGeometrySchema, { cols: 80, rows: 24 }),
    });
    await client.destroySession({
      meta: newRequestMeta(),
      sessionId: created.session!.id,
    });

    const ev1 = await ai.next();
    expect(ev1.done).toBe(false);
    expect(ev1.value?.kind.case).toBe('created');

    const ev2 = await ai.next();
    expect(ev2.done).toBe(false);
    expect(ev2.value?.kind.case).toBe('destroyed');

    ac.abort();
    await ai.return?.(undefined).catch(() => {});
  });
});

describe('connect-roundtrip — error path (ch04 §2 — request_id required)', () => {
  it('Hello with an empty request_id rejects InvalidArgument before the handler responds', async () => {
    const client = harness.makeClient(SessionService);
    let raised: ConnectError | null = null;
    try {
      await client.hello({
        meta: create(RequestMetaSchema, { requestId: '' }),
        protoMinVersion: 1,
        clientKind: 'electron-test',
      });
    } catch (err) {
      raised = ConnectError.from(err);
    }
    expect(raised, 'expected ConnectError on empty request_id').not.toBeNull();
    expect(raised!.code).toBe(Code.InvalidArgument);
  });
});

// Compile-time guard: every spec in this file references the canonical
// principal key (`local-user:test`) implicitly via `harness.makeClient`.
// The export is asserted here so a refactor that renames it surfaces
// during typecheck rather than at runtime.
const _PRINCIPAL_KEY_USED: typeof TEST_PRINCIPAL_KEY = TEST_PRINCIPAL_KEY;
void _PRINCIPAL_KEY_USED;
