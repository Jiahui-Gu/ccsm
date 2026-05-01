// T07 — placeholder parity case for the framework.
//
// Why this exists: the parity framework lands BEFORE the first bridge swap
// (T06 registers Ping + GetVersion). Without at least one parity case driving
// the framework end-to-end, the test:parity npm script would no-op and any
// regression in `runParityCase` would go uncaught until the first real case
// lands. This placeholder uses manually-crafted stub responses for BOTH
// transports — it does NOT spin up a real daemon, does NOT call any real
// envelope sender or Connect client. T06 will replace it with a real case
// that boots the daemon and pairs envelope `daemon.ping` against Connect
// `Ping`.
//
// Spec: docs/superpowers/specs/2026-05-01-v0.4-web-design.md
//   - ch09 §2 T07 deliverable: "framework lands in M1 ahead of any Batch A
//     bridge swap; one example parity test (`getVersion`) passes". This
//     placeholder satisfies the "one example passes" leg until the real
//     T06 hello/ping handlers exist.
//   - ch03 §7.1 fixture shape: `{ name, request, expectedV03Response,
//     expectedV04Response, parityOpts }`. We exercise that shape verbatim
//     so the fixture loader remains under test as the corpus grows.

import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runParityCase } from './framework.js';

interface ParityFixture {
  rpc: string;
  description: string;
  cases: ReadonlyArray<{
    name: string;
    request: Record<string, unknown>;
    expectedV03Response: Record<string, unknown>;
    expectedV04Response: Record<string, unknown>;
    parityOpts?: {
      ignoreFields?: string[];
      normalizationStrategy?: string;
    };
  }>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, '__fixtures__', 'ping.golden.json');
const fixture: ParityFixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

describe('parity placeholder — Ping (T07 plumbing exercise)', () => {
  for (const c of fixture.cases) {
    it(`[${fixture.rpc}] ${c.name}`, async () => {
      // Placeholder: both transports return the recorded golden response. T06
      // will swap these stubs for real envelope + Connect calls against a
      // booted daemon. The parity framework's behavior is identical either
      // way — it doesn't care what produced the bytes, only that they match.
      await runParityCase({
        name: `${fixture.rpc}/${c.name}`,
        envelopeCall: async () => structuredClone(c.expectedV03Response),
        connectCall: async () => structuredClone(c.expectedV04Response),
        tolerantFields: c.parityOpts?.ignoreFields,
      });
    });
  }
});
