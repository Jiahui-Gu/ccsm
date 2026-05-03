// packages/daemon/test/descriptor/schema.spec.ts
//
// Validates the listener-A connection descriptor (ch03 §3.2) against the
// frozen v1 JSON Schema at packages/daemon/schemas/listener-a.schema.json,
// using ajv as the de-facto JSON-Schema-Draft-07 validator.
//
// Two invariants this spec exists to guard:
//
//   1. The bytes produced by writeDescriptor (PR #863, T1.6) validate
//      under the v1 schema. Any future writer change that drifts the
//      on-disk shape (added field, renamed key, type change) makes this
//      test fail loudly — which is the point: the descriptor is part of
//      the wire contract Electron speaks to (ch03 §3.2 forever-stable),
//      so silent drift would break older Electron builds against newer
//      daemons (ch15 §3 forbidden-pattern 8).
//
//   2. The schema file itself is FROZEN. We assert byte-equal between the
//      writer's output and a checked-in golden file. Any whitespace /
//      key-order / value change in the writer that survived ajv (e.g.
//      switching from `JSON.stringify(_, null, 2)` to compact form) is
//      caught here. Reverse-verify: edit the golden by 1 byte → spec
//      fails with a unified diff in the assertion message.
//
// Why ajv (and not a hand-rolled type-guard): ajv is the standard
// Draft-07 validator in the Node ecosystem (zero-dep at runtime besides
// its own AST). Hand-rolling validation here would re-implement
// `additionalProperties: false`, enum closure, and pattern checks —
// all of which the schema spells out declaratively.

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ajv 8 ships as a single CJS bundle (`main: dist/ajv.js`). Its `.d.ts`
// declares both `export class Ajv` and `export default Ajv` and is loaded
// via TS NodeNext as an ES module. That synthesizes the default export as
// the namespace itself rather than the class, so `new Ajv()` from a
// `import Ajv from 'ajv'` does not type-check (TS2351). The wildcard
// import + `.default` lookup with a fallback to the namespace is the
// portable form that works under both NodeNext typecheck AND vitest's
// esbuild interop without per-tool config gymnastics.
import * as AjvNs from 'ajv';
const Ajv =
  (AjvNs as unknown as {
    default?: typeof AjvNs.Ajv;
    Ajv: typeof AjvNs.Ajv;
  }).default ?? AjvNs.Ajv;

import { describe, expect, it } from 'vitest';

import {
  type DescriptorV1,
  descriptorTmpPath,
  writeDescriptor,
} from '../../src/listeners/descriptor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Repo paths anchored on this spec file (parent of test/descriptor =
// daemon package root). Resolving relative to import.meta.url keeps the
// spec runnable regardless of cwd / vitest workspace layout.
const PKG_ROOT = join(__dirname, '..', '..');
const SCHEMA_PATH = join(PKG_ROOT, 'schemas', 'listener-a.schema.json');
const GOLDEN_PATH = join(__dirname, 'listener-a.golden.json');

// Sample MUST stay byte-identical to the values baked into
// listener-a.golden.json. Any drift is the whole point of the byte-equal
// assertion — fix the drift, do NOT regenerate the golden silently.
const SAMPLE: DescriptorV1 = {
  version: 1,
  transport: 'KIND_TCP_LOOPBACK_H2_TLS',
  address: '127.0.0.1:51820',
  tlsCertFingerprintSha256:
    'a3b1c2d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  supervisorAddress: '/run/ccsm/supervisor.sock',
  boot_id: '550e8400-e29b-41d4-a716-446655440000',
  daemon_pid: 4242,
  listener_addr: '127.0.0.1:51820',
  protocol_version: 1,
  bind_unix_ms: 1714600000000,
};

async function loadSchema(): Promise<Record<string, unknown>> {
  const raw = await readFile(SCHEMA_PATH, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function makeValidator(schema: Record<string, unknown>) {
  // strict: false silences ajv's warnings about non-standard keywords like
  // `description` (which we use heavily for ops docs in the schema). All
  // standard Draft-07 validation behavior is preserved.
  const ajv = new Ajv({ strict: false, allErrors: true });
  return ajv.compile(schema);
}

describe('listener-a.schema.json (frozen v1)', () => {
  it('accepts a writer-produced descriptor (TLS transport sample)', async () => {
    const validate = makeValidator(await loadSchema());
    const ok = validate(SAMPLE);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('accepts every closed-enum transport (UDS, named pipe, h2c, h2-tls)', async () => {
    const validate = makeValidator(await loadSchema());
    const transports: DescriptorV1['transport'][] = [
      'KIND_UDS',
      'KIND_NAMED_PIPE',
      'KIND_TCP_LOOPBACK_H2C',
      'KIND_TCP_LOOPBACK_H2_TLS',
    ];
    for (const t of transports) {
      const payload: DescriptorV1 = {
        ...SAMPLE,
        transport: t,
        // tlsCertFingerprintSha256 is only set for the TLS transport;
        // every other transport carries `null` (ch03 §3.2).
        tlsCertFingerprintSha256:
          t === 'KIND_TCP_LOOPBACK_H2_TLS'
            ? SAMPLE.tlsCertFingerprintSha256
            : null,
      };
      expect(
        validate(payload),
        `transport=${t} errors=${JSON.stringify(validate.errors)}`,
      ).toBe(true);
    }
  });

  it('rejects an unknown transport (closed enum, no v0.4 widening here)', async () => {
    const validate = makeValidator(await loadSchema());
    const bad = { ...SAMPLE, transport: 'KIND_GRPC_OVER_QUIC' };
    expect(validate(bad)).toBe(false);
  });

  it('rejects a missing required field (boot_id)', async () => {
    const validate = makeValidator(await loadSchema());
    const { boot_id: _omit, ...rest } = SAMPLE;
    expect(validate(rest)).toBe(false);
  });

  it('rejects an unknown extra property (additionalProperties:false)', async () => {
    const validate = makeValidator(await loadSchema());
    const bad = { ...SAMPLE, surprise_field: 'nope' };
    expect(validate(bad)).toBe(false);
  });

  it('rejects version !== 1 (forever-stable schema marker)', async () => {
    const validate = makeValidator(await loadSchema());
    const bad = { ...SAMPLE, version: 2 };
    expect(validate(bad)).toBe(false);
  });

  it('rejects a non-UUIDv4 boot_id', async () => {
    const validate = makeValidator(await loadSchema());
    const bad = { ...SAMPLE, boot_id: 'not-a-uuid' };
    expect(validate(bad)).toBe(false);
  });
});

describe('writer ↔ schema round-trip (PR #863 output)', () => {
  it('the writer-produced bytes validate AND match the checked-in golden file', async () => {
    // Write via the real production path so any drift in writeDescriptor
    // (e.g. switching to compact JSON, reordering keys, dropping the
    // trailing newline) breaks this test. Using a real tmp dir keeps the
    // fsync / rename / wx semantics covered by the writer's own spec
    // (descriptor.spec.ts) — we only assert the bytes here.
    const dir = await mkdtemp(join(tmpdir(), 'ccsm-schema-roundtrip-'));
    try {
      const path = join(dir, 'listener-a.json');
      await writeDescriptor(path, SAMPLE);
      // Sanity: temp file must be gone (rename succeeded).
      await expect(stat(descriptorTmpPath(path))).rejects.toMatchObject({
        code: 'ENOENT',
      });

      const writtenBytes = await readFile(path, 'utf8');
      const goldenBytes = await readFile(GOLDEN_PATH, 'utf8');

      // Byte-equal assertion: schema is FROZEN. If a writer change makes
      // this fail, decide whether the wire format genuinely changed
      // (then bump `version` to 2 in a NEW schema file per ch15 §3) or
      // whether the writer drift is a regression (then revert it). Do
      // NOT silently regenerate the golden.
      expect(writtenBytes).toBe(goldenBytes);

      // And the bytes must validate under the v1 schema.
      const validate = makeValidator(await loadSchema());
      const parsed = JSON.parse(writtenBytes) as unknown;
      const ok = validate(parsed);
      expect(validate.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
