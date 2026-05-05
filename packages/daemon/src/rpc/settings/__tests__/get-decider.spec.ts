// packages/daemon/src/rpc/settings/__tests__/get-decider.spec.ts
//
// Task #434 (T8.14b-4) — rpc/ coverage push for the pure
// `decideGetSettings` decider in `../get.ts`. Spec #337 §4.1 +
// settings.proto:36: scope UNSPECIFIED + GLOBAL proceed; PRINCIPAL
// rejects with InvalidArgument in v0.3 (additively allowed in v0.4).
// The Connect handler sink is exercised by the daemon-boot e2e — these
// specs lock the per-scope verdict so the v0.4 additive widen-to-allow
// for PRINCIPAL is a single-line change with a single-line test diff.

import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';

import {
  GetSettingsRequestSchema,
  SettingsScope,
} from '@ccsm/proto';

import { decideGetSettings } from '../get.js';

describe('decideGetSettings (Task #434 — pure decider, spec #337 §4.1)', () => {
  it('returns ok for UNSPECIFIED and GLOBAL scopes (hot path)', () => {
    const reqUnspecified = create(GetSettingsRequestSchema, {
      scope: SettingsScope.UNSPECIFIED,
    });
    expect(decideGetSettings(reqUnspecified)).toEqual({ kind: 'ok' });

    const reqGlobal = create(GetSettingsRequestSchema, {
      scope: SettingsScope.GLOBAL,
    });
    expect(decideGetSettings(reqGlobal)).toEqual({ kind: 'ok' });
  });

  it('rejects PRINCIPAL scope (v0.4 only) with reject_scope verdict carrying the offending value', () => {
    // Error branch: v0.3 acceptance §7 #4 — PRINCIPAL is reserved for
    // v0.4 additive widening. The decider returns the verdict tagged
    // with the rejected enum value so the sink can format an
    // InvalidArgument message without re-deriving it.
    const req = create(GetSettingsRequestSchema, {
      scope: SettingsScope.PRINCIPAL,
    });
    expect(decideGetSettings(req)).toEqual({
      kind: 'reject_scope',
      scope: SettingsScope.PRINCIPAL,
    });
  });
});
