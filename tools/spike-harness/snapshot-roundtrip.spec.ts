// snapshot-roundtrip.spec.ts — vitest property runner for SnapshotV1 codec.
//
// Spike-harness fixture pinned by spec ch14 §1.B (forever-stable contract).
// Used by ch14 §1.8 (snapshot byte-equality fuzz). Property:
//
//   For all SnapshotV1 inputs `s`:
//     decode(encode(s)) ≈ s              (semantic equality)
//     encode(decode(encode(s))) === encode(s)  (byte equality)
//
// Contract (FOREVER-STABLE — v0.4 may add cases, never rename/remove the spec):
//
//   - Test file path: tools/spike-harness/snapshot-roundtrip.spec.ts
//   - Spec name:      "SnapshotV1 round-trip"
//   - Imports the codec from packages/snapshot-codec (pinned by ch06 §1603 of
//     the design spec).
//
// STATUS: describe.skip until T4.6 (SnapshotV1 codec) lands. The test body
// is intentionally hollow — what matters TODAY is that the file exists at
// this path so downstream T9.8 wiring can `vitest run tools/spike-harness/`
// and see the skipped-with-TODO marker. Once T4.6 ships, flip describe.skip
// to describe and import the real codec.

import { describe, it, expect } from 'vitest';

// TODO(T4.6): uncomment once packages/snapshot-codec exports {encode, decode}.
// import { encode, decode } from '@ccsm/snapshot-codec';

describe.skip('SnapshotV1 round-trip (TODO: T4.6 codec)', () => {
  it('decode(encode(s)) is semantically equal to s', () => {
    // TODO: implement when T4.6 lands.
    expect(true).toBe(true);
  });

  it('encode(decode(encode(s))) is byte-identical to encode(s)', () => {
    // TODO: implement when T4.6 lands. Use vt-grammar.mjs corpus + W1-W6
    // replay corpus per ch14 §1.8 corpus (C2) and (C3).
    expect(true).toBe(true);
  });
});
