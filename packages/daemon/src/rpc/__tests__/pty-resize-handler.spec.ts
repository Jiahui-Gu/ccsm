// Unit tests for `PtyService.Resize` Connect handler — Task #543 /
// STEP-3.2a / spec docs/superpowers/specs/2026-05-05-v03-test-shells.md
// §2.2.
//
// Verbatim shell names (DO NOT rename — reviewer greps these literals):
//   - 'forwards (cols, rows) to pty-host resize()'
//   - 'rejects with INVALID_ARGUMENT when cols/rows ≤ 0'
//   - 'rejects with NOT_FOUND when sid is unknown'

import { create } from '@bufbuild/protobuf';
import {
  Code,
  createClient,
  createRouterTransport,
  ConnectError,
} from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';

import {
  PtyGeometrySchema,
  PtyService,
  RequestMetaSchema,
  ResizeRequestSchema,
} from '@ccsm/proto';

import { PRINCIPAL_KEY, type Principal as AuthPrincipal } from '../../auth/index.js';
import type { SessionRow } from '../../sessions/types.js';
import { SessionState } from '../../sessions/types.js';
import type { HostToChildMessage } from '../../pty-host/types.js';

import type { PtyHostSender, SessionFinder } from '../pty-sendinput.js';
import {
  makeResizeHandler,
  type ResizeDeps,
  validateGeometry,
} from '../pty-resize.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALICE: AuthPrincipal = {
  kind: 'local-user',
  uid: '1000',
  displayName: 'alice',
};

function aliceSession(id = 'sess-alice'): SessionRow {
  return {
    id,
    owner_id: 'local-user:1000',
    state: SessionState.RUNNING,
    cwd: '/home/alice',
    env_json: '{}',
    claude_args_json: '[]',
    geometry_cols: 80,
    geometry_rows: 24,
    exit_code: -1,
    created_ms: 1,
    last_active_ms: 1,
    should_be_running: 1,
  };
}

function recordingSender(): PtyHostSender & {
  readonly sent: HostToChildMessage[];
} {
  const sent: HostToChildMessage[] = [];
  return {
    sent,
    send(msg) {
      sent.push(msg);
    },
  };
}

function newMeta() {
  return create(RequestMetaSchema, {
    requestId: '11111111-2222-3333-4444-555555555555',
  });
}

function makeBoundTransport(
  deps: ResizeDeps,
  principal: AuthPrincipal | null = ALICE,
) {
  return createRouterTransport(
    (router) => {
      router.service(PtyService, {
        resize: makeResizeHandler(deps),
      });
    },
    {
      router: {
        interceptors: [
          (next) => async (req) => {
            req.contextValues.set(PRINCIPAL_KEY, principal);
            return next(req);
          },
        ],
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PtyService.Resize handler', () => {
  it('forwards (cols, rows) to pty-host resize()', async () => {
    const sess = aliceSession();
    const sender = recordingSender();
    const findSession: SessionFinder = (id) =>
      id === sess.id ? sess : undefined;
    const deps: ResizeDeps = {
      findSession,
      getPtyHost: (id) => (id === sess.id ? sender : undefined),
    };
    const transport = makeBoundTransport(deps);
    const client = createClient(PtyService, transport);

    await client.resize(
      create(ResizeRequestSchema, {
        meta: newMeta(),
        sessionId: sess.id,
        geometry: create(PtyGeometrySchema, { cols: 132, rows: 50 }),
      }),
    );

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toEqual({ kind: 'resize', cols: 132, rows: 50 });
  });

  it('rejects with INVALID_ARGUMENT when cols/rows ≤ 0', async () => {
    // Pure decider verification first — exercises the boundary
    // independently of the Connect plumbing.
    expect(validateGeometry(0, 24)).not.toBeNull();
    expect(validateGeometry(80, 0)).not.toBeNull();
    expect(validateGeometry(-1, 24)).not.toBeNull();
    expect(validateGeometry(80, -1)).not.toBeNull();
    expect(validateGeometry(80, 24)).toBeNull();

    // Then assert the wire-level Code mapping. Three rejection cases
    // (cols=0, rows=0, both negative) all collapse to InvalidArgument.
    const sess = aliceSession();
    const sender = recordingSender();
    const deps: ResizeDeps = {
      findSession: (id) => (id === sess.id ? sess : undefined),
      getPtyHost: () => sender,
    };
    const transport = makeBoundTransport(deps);
    const client = createClient(PtyService, transport);

    const cases: Array<{ cols: number; rows: number }> = [
      { cols: 0, rows: 24 },
      { cols: 80, rows: 0 },
      { cols: -1, rows: -1 },
    ];
    for (const c of cases) {
      let err: unknown;
      try {
        await client.resize(
          create(ResizeRequestSchema, {
            meta: newMeta(),
            sessionId: sess.id,
            geometry: create(PtyGeometrySchema, c),
          }),
        );
      } catch (e) {
        err = e;
      }
      expect(err, `cols=${c.cols} rows=${c.rows}`).toBeInstanceOf(ConnectError);
      expect((err as ConnectError).code).toBe(Code.InvalidArgument);
    }
    // Pty-host MUST NOT have been called for any rejected geometry.
    expect(sender.sent).toHaveLength(0);
  });

  it('rejects with NOT_FOUND when sid is unknown', async () => {
    const sender = recordingSender();
    const deps: ResizeDeps = {
      findSession: () => undefined,
      getPtyHost: () => sender,
    };
    const transport = makeBoundTransport(deps);
    const client = createClient(PtyService, transport);

    await expect(
      client.resize(
        create(ResizeRequestSchema, {
          meta: newMeta(),
          sessionId: 'unknown-sid',
          geometry: create(PtyGeometrySchema, { cols: 80, rows: 24 }),
        }),
      ),
    ).rejects.toMatchObject({ code: Code.NotFound });
    expect(sender.sent).toHaveLength(0);
  });
});
