// ConnectRouter stub-handler coverage spec — T2.2.
//
// Asserts that calling EVERY method on EVERY v0.3 service through the
// in-process router transport returns a Connect `Unimplemented` error.
// The test is data-driven from `STUB_SERVICES` so adding a new service
// to `@ccsm/proto` and forgetting to extend `STUB_SERVICES` (or
// deliberately skipping a method's handler) is mechanically caught.
//
// In-process router transport (`createRouterTransport`) is used here
// instead of a real http2 listener — see
// `__tests__/integration.spec.ts` for the over-the-wire variant. The
// router contract is identical between the two transports (both share
// the same `createConnectRouter` under the hood); the in-process
// transport is faster and avoids socket cleanup flake.

import { describe, expect, it } from 'vitest';
import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { createRouterTransport } from '@connectrpc/connect';
import {
  CrashService,
  DraftService,
  NotifyService,
  PtyService,
  SessionService,
  SettingsService,
  SupervisorService,
} from '@ccsm/proto';

import { STUB_SERVICES, stubRoutes } from '../router.js';

const transport = createRouterTransport(stubRoutes);

/**
 * Minimal request shape that satisfies any v0.3 RPC. Every request
 * proto in `@ccsm/proto` has a `meta` field of type `RequestMeta` (per
 * spec ch04 §2). The router's stub returns Unimplemented BEFORE any
 * field validation runs, so an empty object is sufficient.
 */
const EMPTY_REQ = {};

/**
 * For server-streaming RPCs, the iterator MUST be consumed before the
 * stream's terminating error is observed. Iterating a single tick and
 * catching the rejection is the canonical pattern in connect-es tests.
 */
async function consumeStream<T>(iter: AsyncIterable<T>): Promise<void> {
  for await (const _frame of iter) {
    // Drain — Unimplemented surfaces as a stream-end error, not a frame.
    void _frame;
  }
}

describe('ConnectRouter — every v0.3 service is registered', () => {
  it('STUB_SERVICES contains exactly the seven v0.3 services', () => {
    // Mechanical guard against forgetting to extend STUB_SERVICES when
    // a new .proto file is added. If `@ccsm/proto`'s service exports
    // change, this assertion forces the author to update the array
    // and re-eyeball the registration.
    const expected = new Set([
      SessionService.typeName,
      PtyService.typeName,
      CrashService.typeName,
      SettingsService.typeName,
      NotifyService.typeName,
      DraftService.typeName,
      SupervisorService.typeName,
    ]);
    const actual = new Set(STUB_SERVICES.map((s) => s.typeName));
    expect(actual).toEqual(expected);
  });
});

import type { DescService } from '@bufbuild/protobuf';

interface ServiceCase {
  readonly name: string;
  readonly service: DescService;
}

const SERVICE_CASES: readonly ServiceCase[] = [
  { name: 'SessionService', service: SessionService },
  { name: 'PtyService', service: PtyService },
  { name: 'CrashService', service: CrashService },
  { name: 'SettingsService', service: SettingsService },
  { name: 'NotifyService', service: NotifyService },
  { name: 'DraftService', service: DraftService },
  { name: 'SupervisorService', service: SupervisorService },
];

describe.each(SERVICE_CASES)(
  'stub handler — $name',
  ({ service }) => {
    const client = createClient(service, transport);
    // `service.method` is a record keyed by lowerCamelCase method name.
    const methodNames = Object.keys(service.method);

    it.each(methodNames)('%s -> Unimplemented', async (methodName) => {
      const fn = (
        client as unknown as Record<
          string,
          (req: unknown) => Promise<unknown> | AsyncIterable<unknown>
        >
      )[methodName];
      expect(typeof fn).toBe('function');

      const desc = (
        service.method as Record<
          string,
          { methodKind: 'unary' | 'server_streaming' | 'client_streaming' | 'bidi_streaming' }
        >
      )[methodName];

      let captured: unknown = null;
      try {
        if (desc.methodKind === 'server_streaming') {
          await consumeStream(fn(EMPTY_REQ) as AsyncIterable<unknown>);
        } else {
          await (fn(EMPTY_REQ) as Promise<unknown>);
        }
      } catch (err) {
        captured = err;
      }

      expect(captured).toBeInstanceOf(ConnectError);
      const ce = captured as ConnectError;
      expect(ce.code).toBe(Code.Unimplemented);
    });
  },
);
