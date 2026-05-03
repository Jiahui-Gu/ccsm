// packages/daemon/test/supervisor/contract.spec.ts
//
// FOREVER-STABLE per docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
// chapter 15 §3 forbidden-pattern item #9 — "Changing the Supervisor HTTP
// endpoint URLs or response shapes." The forbidden-pattern entry names this
// file as the mechanical reviewer checklist:
//
//   "supervisor/contract.spec.ts table-tests the four endpoints
//    (/healthz, /hello, /shutdown, peer-cred path) against checked-in golden
//    response bodies; chapter 03 §7 + chapter 02 §2 fix the URL strings as
//    `as const`."
//
// Body shapes (chapter 03 §7 + chapter 04 §3 / packages/proto/src/ccsm/v1/
// supervisor.proto):
//   - GET /healthz   -> { ready, version, uptimeS, boot_id }
//   - POST /hello    -> SupervisorHelloResponse  { meta, daemon_version, boot_id }
//   - POST /shutdown -> ShutdownResponse         { meta, accepted, grace_ms }
//   - peer-cred reject path: HTTP 403, no body shape from proto (transport-
//     level rejection per chapter 03 §7.1 / supervisor.proto comment); the
//     golden is a placeholder shape the daemon's middleware will produce in
//     T1.7 / T1.8.
//
// The Supervisor binary impl lands in T1.7 (see packages/daemon/src/index.ts
// "TODO(T1.7): flip Supervisor /healthz to 200"). Until that ships, this spec
// is a fixture-loader against the JSON files in
// `packages/daemon/test/supervisor/golden/`. Once T1.7 lands, the integration
// tests under `packages/daemon/test/integration/supervisor/` (see chapter 12
// §3 `peer-cred-rejection.spec.ts` etc.) will assert real responses against
// the same goldens; this file's job is only to lock the goldens themselves
// so a v0.4 PR cannot quietly mutate them. Both layers depend on the same
// JSON files — that's the whole point of the table-test contract.
//
// Why goldens are JSON files, not inline literals: ch15 §3 #9 demands "checked
// in golden response bodies" plural; storing each body in its own file means a
// PR diff that mutates a body shape shows up as a one-line edit to the named
// fixture, which reviewers can spot without reading TypeScript. Implementation
// code (T1.7) imports the same files for response generation if it wishes;
// drift between impl and contract becomes a single-source-of-truth question.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// URL constants — chapter 03 §7 + chapter 02 §2 require these to be `as const`
// so any v0.4 PR that retypes them as plain `string` (or otherwise loosens the
// surface) trips the type-checker. The same import will be consumed by the
// Supervisor HTTP server in T1.7 — single source of truth.
// ---------------------------------------------------------------------------

export const SUPERVISOR_URLS = {
  healthz: '/healthz',
  hello: '/hello',
  shutdown: '/shutdown',
} as const;

// Locked HTTP method per endpoint (chapter 03 §7).
export const SUPERVISOR_METHODS = {
  healthz: 'GET',
  hello: 'POST',
  shutdown: 'POST',
} as const;

// ---------------------------------------------------------------------------
// Golden fixture loader
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GOLDEN_DIR = join(__dirname, 'golden');

function loadGoldenRaw(name: string): string {
  return readFileSync(join(GOLDEN_DIR, `${name}.json`), 'utf8');
}

function loadGolden<T = unknown>(name: string): T {
  return JSON.parse(loadGoldenRaw(name)) as T;
}

// ---------------------------------------------------------------------------
// Table-tests — four endpoints (chapter 15 §3 #9)
// ---------------------------------------------------------------------------

interface ContractCase {
  readonly endpoint: string;
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly golden: string;
  readonly requiredFields: readonly string[];
  readonly fieldTypes: Readonly<Record<string, 'string' | 'number' | 'boolean' | 'object'>>;
}

const CASES: readonly ContractCase[] = [
  {
    endpoint: 'healthz',
    url: SUPERVISOR_URLS.healthz,
    method: SUPERVISOR_METHODS.healthz,
    golden: 'healthz',
    // chapter 03 §7 literal text:
    //   {"ready": true, "version": "0.3.x", "uptimeS": N, "boot_id": "<uuid>"}
    requiredFields: ['ready', 'version', 'uptimeS', 'boot_id'],
    fieldTypes: {
      ready: 'boolean',
      version: 'string',
      uptimeS: 'number',
      boot_id: 'string',
    },
  },
  {
    endpoint: 'hello',
    url: SUPERVISOR_URLS.hello,
    method: SUPERVISOR_METHODS.hello,
    golden: 'hello',
    // SupervisorHelloResponse — packages/proto/src/ccsm/v1/supervisor.proto
    requiredFields: ['meta', 'daemon_version', 'boot_id'],
    fieldTypes: {
      meta: 'object',
      daemon_version: 'string',
      boot_id: 'string',
    },
  },
  {
    endpoint: 'shutdown',
    url: SUPERVISOR_URLS.shutdown,
    method: SUPERVISOR_METHODS.shutdown,
    golden: 'shutdown',
    // ShutdownResponse — packages/proto/src/ccsm/v1/supervisor.proto
    requiredFields: ['meta', 'accepted', 'grace_ms'],
    fieldTypes: {
      meta: 'object',
      accepted: 'boolean',
      grace_ms: 'number',
    },
  },
  {
    endpoint: 'peer-cred-rejected',
    // Path-agnostic — the rejection happens before any handler dispatches
    // (chapter 03 §7.1 peer-cred middleware). Both /hello and /shutdown reach
    // it. The golden carries the HTTP status + a stable rejection-reason
    // string the daemon middleware emits.
    url: SUPERVISOR_URLS.shutdown,
    method: SUPERVISOR_METHODS.shutdown,
    golden: 'peer-cred-rejected',
    requiredFields: ['status', 'reason'],
    fieldTypes: {
      status: 'number',
      reason: 'string',
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

describe('Supervisor HTTP contract (forever-stable per ch15 §3 #9)', () => {
  describe('URL constants', () => {
    it('locks /healthz, /hello, /shutdown as const literals', () => {
      // Type-level: SUPERVISOR_URLS.healthz must be the literal '/healthz'.
      // Runtime: assert the values too so a stray edit (e.g. '/health') trips.
      expect(SUPERVISOR_URLS.healthz).toBe('/healthz');
      expect(SUPERVISOR_URLS.hello).toBe('/hello');
      expect(SUPERVISOR_URLS.shutdown).toBe('/shutdown');
    });

    it('locks per-endpoint HTTP methods (chapter 03 §7)', () => {
      expect(SUPERVISOR_METHODS.healthz).toBe('GET');
      expect(SUPERVISOR_METHODS.hello).toBe('POST');
      expect(SUPERVISOR_METHODS.shutdown).toBe('POST');
    });
  });

  describe.each(CASES)('endpoint $endpoint', (c) => {
    it(`golden file ${c.golden}.json exists and parses as JSON`, () => {
      expect(() => loadGolden(c.golden)).not.toThrow();
    });

    it('golden has every required top-level field', () => {
      const body = loadGolden<Record<string, unknown>>(c.golden);
      for (const field of c.requiredFields) {
        expect(body, `missing field "${field}"`).toHaveProperty(field);
      }
    });

    it('golden has no extra top-level fields (closed shape)', () => {
      const body = loadGolden<Record<string, unknown>>(c.golden);
      const actualKeys = Object.keys(body).sort();
      const expectedKeys = [...c.requiredFields].sort();
      expect(actualKeys).toEqual(expectedKeys);
    });

    it('golden field types match the locked schema', () => {
      const body = loadGolden<Record<string, unknown>>(c.golden);
      for (const [field, expectedType] of Object.entries(c.fieldTypes)) {
        const actual = body[field];
        if (expectedType === 'object') {
          expect(actual).toBeTypeOf('object');
          expect(actual).not.toBeNull();
        } else {
          expect(actual).toBeTypeOf(expectedType);
        }
      }
    });

    it('golden round-trips JSON.parse → JSON.stringify lossless-shape', () => {
      // Catches non-JSON characters (BOM, trailing commas, comments) snuck
      // into a hand-edited golden file.
      const raw = loadGoldenRaw(c.golden);
      const reSerialized = JSON.stringify(JSON.parse(raw));
      // The re-serialized form drops whitespace; assert the parsed values
      // round-trip equal (semantic identity, not byte identity).
      expect(JSON.parse(reSerialized)).toEqual(JSON.parse(raw));
    });
  });

  describe('healthz golden — literal spec body (chapter 03 §7)', () => {
    // Spec literal:
    //   {"ready": true, "version": "0.3.x", "uptimeS": N, "boot_id": "<uuid>"}
    // The golden encodes N=0 and a zero-UUID as canonical placeholder values
    // so the contract is byte-stable; the daemon impl substitutes real values
    // at runtime, but the SHAPE pinned here is forever-stable.
    const healthz = loadGolden<{
      ready: boolean;
      version: string;
      uptimeS: number;
      boot_id: string;
    }>('healthz');

    it('ready === true (the spec literal pins true; impl flips to true at READY phase)', () => {
      expect(healthz.ready).toBe(true);
    });

    it('version matches spec literal "0.3.x"', () => {
      expect(healthz.version).toBe('0.3.x');
    });

    it('boot_id is a UUIDv4-shaped string (chapter 03 §7 — matches listener-a.json boot_id)', () => {
      expect(healthz.boot_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it('uptimeS is a non-negative integer', () => {
      expect(Number.isInteger(healthz.uptimeS)).toBe(true);
      expect(healthz.uptimeS).toBeGreaterThanOrEqual(0);
    });
  });

  describe('shutdown golden — grace_ms budget (chapter 02 §4: <= 5000)', () => {
    const shutdown = loadGolden<{ accepted: boolean; grace_ms: number }>(
      'shutdown',
    );

    it('accepted === true on the success path', () => {
      expect(shutdown.accepted).toBe(true);
    });

    it('grace_ms is an integer in [0, 5000] per chapter 02 §4', () => {
      expect(Number.isInteger(shutdown.grace_ms)).toBe(true);
      expect(shutdown.grace_ms).toBeGreaterThanOrEqual(0);
      expect(shutdown.grace_ms).toBeLessThanOrEqual(5000);
    });
  });

  describe('peer-cred-rejected golden — HTTP 403 (chapter 03 §7.1)', () => {
    const rejected = loadGolden<{ status: number; reason: string }>(
      'peer-cred-rejected',
    );

    it('status === 403 (locked by chapter 03 §7.1)', () => {
      expect(rejected.status).toBe(403);
    });

    it('reason is a non-empty string for log correlation', () => {
      expect(rejected.reason).toBeTypeOf('string');
      expect(rejected.reason.length).toBeGreaterThan(0);
    });
  });
});
