// Task #265 contract test — `Session.turn_state` wire shape.
//
// What it pins (forever-stable):
//
//   1. `SessionTurnState` enum has the exact 4 members at exact int values
//      (UNSPECIFIED=0, IDLE=1, RUNNING=2, REQUIRES_ACTION=3). Reordering or
//      reusing a slot is a wire break: the 0 slot is the proto3 default
//      ("daemon hasn't inferred yet"); IDLE/RUNNING/REQUIRES_ACTION are the
//      three SDK-authoritative states the renderer's AgentIcon halo branches
//      on (see `src/agent/lifecycle.ts:mapState`).
//
//   2. `Session.turn_state` is `optional` (proto3 field-presence). An unset
//      bit is wire-distinguishable from an explicit `SESSION_TURN_STATE_*`
//      value, so the renderer can tell "daemon hasn't inferred yet" apart
//      from "daemon inferred IDLE". A binary round-trip preserves the
//      presence bit in both directions (set ↔ unset).
//
//   3. The field number is 10 (immediately after `runtime_pid = 9`). Field
//      numbers are forever-stable; this test pins 10 by encoding a Session
//      with `turnState = IDLE` and asserting the binary contains the proto
//      tag for field 10 (varint, wire-type 0 → tag byte = (10<<3)|0 = 0x50).
//
// Out of scope: how the daemon emits `updated` events with `turn_state`
// (handler test lives in `packages/daemon/src/sessions/__tests__/`); how
// the renderer maps to halo on/off (UI test lives in `src/agent/`). This
// is a wire-shape contract test only.

import { describe, expect, it } from 'vitest';
import { create, toBinary, fromBinary } from '@bufbuild/protobuf';
import {
  SessionTurnState,
  SessionState,
  PrincipalSchema,
  LocalUserSchema,
} from '../../gen/ts/ccsm/v1/common_pb.js';
import { SessionSchema } from '../../gen/ts/ccsm/v1/session_pb.js';

describe('SessionTurnState enum (Task #265)', () => {
  it('pins the 4 members at their forever-stable int values', () => {
    // Direct numeric equality — reordering or renaming any of these is a
    // wire break that would silently flip the renderer's halo logic.
    expect(SessionTurnState.UNSPECIFIED).toBe(0);
    expect(SessionTurnState.IDLE).toBe(1);
    expect(SessionTurnState.RUNNING).toBe(2);
    expect(SessionTurnState.REQUIRES_ACTION).toBe(3);
  });
});

describe('Session.turn_state field-presence (Task #265)', () => {
  function makeSession(
    overrides: Partial<{ turnState: SessionTurnState | undefined }> = {},
  ): ReturnType<typeof create<typeof SessionSchema>> {
    return create(SessionSchema, {
      id: 'sid-test',
      owner: create(PrincipalSchema, {
        kind: {
          case: 'localUser',
          value: create(LocalUserSchema, { uid: '1000', displayName: 'tester' }),
        },
      }),
      state: SessionState.RUNNING,
      cwd: '/tmp',
      createdUnixMs: 1n,
      lastActiveUnixMs: 1n,
      ...overrides,
    });
  }

  it('round-trips an UNSET turn_state as undefined', () => {
    const original = makeSession();
    expect(original.turnState).toBeUndefined();
    const wire = toBinary(SessionSchema, original);
    const decoded = fromBinary(SessionSchema, wire);
    expect(decoded.turnState).toBeUndefined();
  });

  it('round-trips an explicit IDLE turn_state', () => {
    const original = makeSession({ turnState: SessionTurnState.IDLE });
    const wire = toBinary(SessionSchema, original);
    const decoded = fromBinary(SessionSchema, wire);
    expect(decoded.turnState).toBe(SessionTurnState.IDLE);
  });

  it('round-trips REQUIRES_ACTION distinctly from RUNNING', () => {
    const a = fromBinary(
      SessionSchema,
      toBinary(SessionSchema, makeSession({ turnState: SessionTurnState.REQUIRES_ACTION })),
    );
    const b = fromBinary(
      SessionSchema,
      toBinary(SessionSchema, makeSession({ turnState: SessionTurnState.RUNNING })),
    );
    expect(a.turnState).toBe(SessionTurnState.REQUIRES_ACTION);
    expect(b.turnState).toBe(SessionTurnState.RUNNING);
    expect(a.turnState).not.toBe(b.turnState);
  });

  it('preserves wire-distinguishability between unset and explicit UNSPECIFIED', () => {
    // Proto3 field-presence: an `optional` field set to its zero value
    // (UNSPECIFIED = 0) MUST encode the presence bit, so the wire bytes
    // for "unset" and "explicit zero" differ. Without this, the renderer
    // could not tell "daemon hasn't inferred yet" from "daemon inferred
    // UNSPECIFIED" — the spec-wired UX distinction collapses.
    const unset = makeSession();
    const explicitZero = makeSession({ turnState: SessionTurnState.UNSPECIFIED });
    const unsetWire = toBinary(SessionSchema, unset);
    const explicitWire = toBinary(SessionSchema, explicitZero);
    expect(unsetWire.length).toBeLessThan(explicitWire.length);
    // Decoded shape: unset stays undefined, explicit zero comes back as 0.
    expect(fromBinary(SessionSchema, unsetWire).turnState).toBeUndefined();
    expect(fromBinary(SessionSchema, explicitWire).turnState).toBe(
      SessionTurnState.UNSPECIFIED,
    );
  });

  it('encodes turn_state at field number 10 (varint tag 0x50)', () => {
    // Pin the field number on the wire — moving turn_state to a different
    // field number would silently desync producers/consumers built against
    // different snapshots of session.proto. Encode an IDLE turn_state and
    // assert the proto tag byte appears in the output.
    //
    // Tag = (field_number << 3) | wire_type. For an enum (varint),
    // wire_type = 0, field_number = 10 → tag = 0x50.
    const wire = toBinary(SessionSchema, makeSession({ turnState: SessionTurnState.IDLE }));
    // IDLE = 1, varint = 0x01. So bytes [..., 0x50, 0x01, ...] must appear.
    let found = false;
    for (let i = 0; i < wire.length - 1; i++) {
      if (wire[i] === 0x50 && wire[i + 1] === 0x01) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});
