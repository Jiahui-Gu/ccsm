// Unit tests for `PtyService.SendInput` Connect handler — Task #543 /
// STEP-3.1a / spec docs/superpowers/specs/2026-05-05-v03-test-shells.md
// §2.1.
//
// Verbatim shell names (DO NOT rename — reviewer greps these literals):
//   - 'forwards utf-8 bytes to pty-host writer in order'
//   - 'rejects with NOT_FOUND when sid is unknown'
//   - 'rejects with PERMISSION_DENIED when principal mismatch'
//
// Tests construct fakes directly (no mocking framework) — matches the
// deps-injection precedent established by `pty-attach.ts`.

import { create } from '@bufbuild/protobuf';
import {
  Code,
  createClient,
  createRouterTransport,
  ConnectError,
} from '@connectrpc/connect';
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';

import {
  PtyService,
  RequestMetaSchema,
  SendInputRequestSchema,
} from '@ccsm/proto';

import { PRINCIPAL_KEY, type Principal as AuthPrincipal } from '../../auth/index.js';
import type { SessionRow } from '../../sessions/types.js';
import { SessionState } from '../../sessions/types.js';
import type { HostToChildMessage } from '../../pty-host/types.js';

import {
  makeSendInputHandler,
  type PtyHostSender,
  type SendInputDeps,
  type SessionFinder,
} from '../pty-sendinput.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALICE: AuthPrincipal = {
  kind: 'local-user',
  uid: '1000',
  displayName: 'alice',
};
const BOB: AuthPrincipal = {
  kind: 'local-user',
  uid: '1001',
  displayName: 'bob',
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

function newMeta(requestId = '11111111-2222-3333-4444-555555555555') {
  return create(RequestMetaSchema, { requestId });
}

function makeBoundTransport(
  deps: SendInputDeps,
  principal: AuthPrincipal | null = ALICE,
) {
  return createRouterTransport(
    (router) => {
      router.service(PtyService, {
        sendInput: makeSendInputHandler(deps),
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

describe('PtyService.SendInput handler', () => {
  it('forwards utf-8 bytes to pty-host writer in order', async () => {
    const sess = aliceSession();
    const sender = recordingSender();
    const findSession: SessionFinder = (id) =>
      id === sess.id ? sess : undefined;
    const deps: SendInputDeps = {
      findSession,
      getPtyHost: (id) => (id === sess.id ? sender : undefined),
    };
    const transport = makeBoundTransport(deps);
    const client = createClient(PtyService, transport);

    // Spec ch04 §6: bytes are an opaque payload the daemon writes to
    // the PTY master verbatim. Test with a UTF-8 multi-byte string so
    // a future regression that re-encodes (e.g. .toString('utf8') ->
    // Buffer.from(..., 'latin1')) would mangle the bytes.
    const payloads = [
      new Uint8Array(Buffer.from('hello ', 'utf8')),
      new Uint8Array(Buffer.from('世界\n', 'utf8')),
      new Uint8Array(Buffer.from('\x1b[A', 'utf8')), // up arrow
    ];
    for (const data of payloads) {
      await client.sendInput(
        create(SendInputRequestSchema, {
          meta: newMeta(),
          sessionId: sess.id,
          data,
        }),
      );
    }

    expect(sender.sent).toHaveLength(payloads.length);
    for (let i = 0; i < payloads.length; i++) {
      const msg = sender.sent[i];
      expect(msg.kind).toBe('send-input');
      // Bytes are forwarded by reference (same Uint8Array contents).
      // Compare via Array.from for a deep equality that doesn't depend
      // on instance identity (Connect-ES may copy through the loopback
      // transport). The KEY assertion is the BYTE SEQUENCE matches and
      // the ORDER matches the call sequence.
      if (msg.kind === 'send-input') {
        expect(Array.from(msg.bytes)).toEqual(Array.from(payloads[i]));
      }
    }
  });

  it('rejects with NOT_FOUND when sid is unknown', async () => {
    // findSession returns undefined => NOT_FOUND per test shell §2.1.
    // Distinct from PERMISSION_DENIED (principal mismatch case below);
    // the two outcomes MUST be wire-distinguishable per the test shell
    // spec. (See pty-sendinput.ts header for rationale on why we don't
    // collapse via SessionManager.get.)
    const deps: SendInputDeps = {
      findSession: () => undefined,
      getPtyHost: () => undefined,
    };
    const transport = makeBoundTransport(deps);
    const client = createClient(PtyService, transport);

    await expect(
      client.sendInput(
        create(SendInputRequestSchema, {
          meta: newMeta(),
          sessionId: 'unknown-sid',
          data: new Uint8Array([0x61]),
        }),
      ),
    ).rejects.toMatchObject({ code: Code.NotFound });
  });

  it('rejects with PERMISSION_DENIED when principal mismatch', async () => {
    // Session is owned by ALICE but BOB is calling — ch05 §5
    // assertOwnership rule (sessionRow.owner_id !==
    // principalKey(caller)) -> Code.PermissionDenied.
    const sess = aliceSession();
    const sender = recordingSender();
    const deps: SendInputDeps = {
      findSession: (id) => (id === sess.id ? sess : undefined),
      getPtyHost: () => sender,
    };
    const transport = makeBoundTransport(deps, BOB);
    const client = createClient(PtyService, transport);

    let err: unknown;
    try {
      await client.sendInput(
        create(SendInputRequestSchema, {
          meta: newMeta(),
          sessionId: sess.id,
          data: new Uint8Array([0x61]),
        }),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe(Code.PermissionDenied);
    // Pty-host writer MUST NOT have been called — security boundary
    // would be defeated if bytes were forwarded before the auth
    // check completed.
    expect(sender.sent).toHaveLength(0);
  });
});
