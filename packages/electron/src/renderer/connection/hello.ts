// T6.7 — Renderer Hello flow + boot_id verification.
//
// Spec ref: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
// chapter 02 §3 (startup ordering) + chapter 03 §3.3 (Hello-echo boot_id
// verification) + chapter 08 §6 (renderer error contract).
//
// Sequence (one connect attempt):
//
//   1. Re-read the descriptor from `app://ccsm/listener-descriptor.json`
//      (NOT a cached in-memory copy — the spec at ch03 §3.3 step 5 is
//      explicit: every reconnect re-reads the file so a daemon restart
//      with a new boot_id is detected on the very first attempt).
//   2. Build a Connect transport against the descriptor's `address`
//      (the bridge endpoint the main process injected per ch08 §4.1+§4.2).
//   3. Construct typed clients via `createClients` from T6.3.
//   4. Call `SessionService.Hello` with the renderer's `proto_min_version`.
//      This is the FIRST RPC over the connection per ch03 §3.3 step 3.
//   5. On `FAILED_PRECONDITION` → version mismatch; surface as the
//      blocking-modal-worthy error (caller decides UX). NOT retried.
//   6. On any other Connect error → throw; caller's reconnect loop
//      backs off and retries from step 1.
//   7. On success → resolve with `{ descriptorBootId, daemonVersion,
//      protoVersion, principal, listenerId }`. The caller compares the
//      `descriptorBootId` against the previously-pinned value to detect a
//      daemon restart (boot_id mismatch → invalidate all React Query
//      caches + surface "reconnected after daemon restart" toast).
//
// boot_id sourcing — important distinction from the spec narrative:
//
//   The spec at ch03 §3.3 step 4 reads "if the descriptor's boot_id does
//   NOT equal the Hello response's boot_id, ...". As of v0.3 freeze, the
//   proto `HelloResponse` (session.proto) does NOT carry a `boot_id` field
//   — only `daemon_version` / `proto_version` / `principal` / `listener_id`.
//   The `boot_id` lives in `SupervisorHelloResponse` (UDS-only, not reachable
//   from the renderer per ch02 §4) and on disk in `listener-a.json` / served
//   to renderer via `app://ccsm/listener-descriptor.json` per ch08 §4.1.
//
//   The spec intent (lines 386-388) is "renderer detects daemon restart on
//   reconnect". The mechanism this module implements:
//     - On every reconnect we re-fetch the descriptor URL. Electron main's
//       `protocol.handle('app', ...)` reads the on-disk file fresh on every
//       request (Cache-Control: no-store; see protocol-app.ts), so the
//       renderer sees the current daemon's boot_id every time.
//     - A successful Hello against the descriptor's address proves the
//       daemon at that address is reachable + version-compatible.
//     - If the freshly-read descriptorBootId differs from the previously-
//       pinned one, the daemon restarted — caller invalidates caches.
//   Foreign-process spoofing (ch03 §3.3 sub-bullet "Foreign process bound
//   to the recorded address") is detected at the bridge layer for UDS /
//   named-pipe (peer-cred middleware on Listener A; ch03 §4) and at the
//   transport-bridge `:authority` enforcement for loopback-TCP. A foreign
//   process speaking Connect-RPC on the daemon's port but NOT serving
//   `SessionService.Hello` would surface as a Connect `Unimplemented` /
//   `Unavailable` error — caught by the reconnect driver, retried from
//   re-reading the descriptor.
//
//   When proto v2+ adds `HelloResponse.boot_id` (additive, ch15 §3
//   forever-stable rule allows new fields), this module flips one line —
//   `descriptorBootId` becomes `helloResponse.bootId` — without changing
//   the public surface. The `HelloResult` field is named `bootId` precisely
//   so the call site doesn't care which side produced it.

import { create } from '@bufbuild/protobuf';
import { ConnectError, Code, type Transport } from '@connectrpc/connect';
import { PROTO_VERSION } from '@ccsm/proto';
import { HelloRequestSchema } from '@ccsm/proto';

import { createClients } from '../../rpc/clients.js';
import type { DescriptorV1 } from '../../main/protocol-app.js';

/**
 * Renderer's minimum acceptable daemon `proto_version`. Embedded at build
 * time per ch02 §6 (one-directional version negotiation: client decides).
 *
 * v0.3: 1. Bumped in lockstep with proto-breaking changes per ch11 §7.
 * Sourced from `@ccsm/proto`'s `PROTO_VERSION` so a single bump propagates
 * everywhere.
 */
export const RENDERER_PROTO_MIN_VERSION = PROTO_VERSION;

/** `client_kind` value the renderer self-identifies as in `HelloRequest`. */
export const RENDERER_CLIENT_KIND = 'electron' as const;

/** Result of a successful Hello. */
export interface HelloResult {
  /**
   * The boot_id pinned for this connection's lifetime. Sourced from the
   * descriptor (see file header — proto HelloResponse does not carry it
   * in v0.3). Caller compares against previously-pinned value to detect
   * daemon restart.
   */
  readonly bootId: string;
  /** Daemon semver, e.g. "0.3.0". Surface in About / status UI. */
  readonly daemonVersion: string;
  /** Daemon's wire protocol minor; >= RENDERER_PROTO_MIN_VERSION on success. */
  readonly protoVersion: number;
  /** Listener id the daemon served the Hello on; v0.3 always "A". */
  readonly listenerId: string;
}

/**
 * Thrown when the daemon rejects the renderer's `proto_min_version`. Carries
 * the daemon's reported version so the caller's UI can display the actual
 * upgrade ask. Not retried by the reconnect driver (`shouldRetry` returns
 * false for this class).
 */
export class HelloVersionMismatchError extends Error {
  override readonly name = 'HelloVersionMismatchError';
  constructor(
    readonly daemonProtoVersion: number | null,
    readonly clientMinVersion: number,
    readonly daemonVersion: string | null,
    cause?: unknown,
  ) {
    super(
      `daemon proto_version ${
        daemonProtoVersion ?? '<unknown>'
      } incompatible with this Electron build (min ${clientMinVersion})`,
    );
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * Thrown when the descriptor URL fetch / parse fails. The renderer's
 * reconnect driver retries this class (it usually means descriptor not yet
 * served because main's `protocol.handle` is still wiring up).
 */
export class DescriptorFetchError extends Error {
  override readonly name = 'DescriptorFetchError';
  constructor(message: string, cause?: unknown) {
    super(message);
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/** Dependencies for `performHello` — every external surface is injected. */
export interface PerformHelloDeps {
  /**
   * Re-fetch the descriptor from `app://ccsm/listener-descriptor.json`.
   * Returns the parsed descriptor. Tests inject a fake.
   *
   * Default (production): `defaultFetchDescriptor()` below — uses the global
   * `fetch` against `DESCRIPTOR_URL` from `protocol-app.ts`.
   */
  readonly fetchDescriptor: () => Promise<DescriptorV1>;
  /**
   * Build a Connect `Transport` from the descriptor. Caller-injected so the
   * renderer's `connect-web` import lives at the boot site (T6.6) and tests
   * can supply a stub transport that records calls.
   */
  readonly buildTransport: (descriptor: DescriptorV1) => Transport;
  /** Renderer's proto floor; defaults to `RENDERER_PROTO_MIN_VERSION`. */
  readonly protoMinVersion?: number;
  /** `client_kind`; defaults to `RENDERER_CLIENT_KIND`. */
  readonly clientKind?: string;
  /** AbortSignal to cancel the Hello mid-flight. */
  readonly signal?: AbortSignal;
}

/**
 * One-shot Hello attempt. The reconnect driver calls this per attempt.
 *
 * Throws on:
 *   - DescriptorFetchError: descriptor URL unreachable / unparseable.
 *   - HelloVersionMismatchError: daemon rejected with FailedPrecondition,
 *     OR daemon's reported `protoVersion < RENDERER_PROTO_MIN_VERSION`.
 *   - ConnectError (any other code): transport / daemon error; caller
 *     should back off and retry.
 */
export async function performHello(
  deps: PerformHelloDeps,
): Promise<HelloResult> {
  const protoMinVersion = deps.protoMinVersion ?? RENDERER_PROTO_MIN_VERSION;
  const clientKind = deps.clientKind ?? RENDERER_CLIENT_KIND;

  // (1) Re-read descriptor — never trust an in-memory cached copy across
  // reconnects (spec ch03 §3.3 step 5).
  let descriptor: DescriptorV1;
  try {
    descriptor = await deps.fetchDescriptor();
  } catch (err) {
    throw new DescriptorFetchError(
      `failed to fetch descriptor: ${(err as Error).message ?? String(err)}`,
      err,
    );
  }

  // (2) Build transport + clients fresh against the descriptor's bridge
  // address. `createClients` is cheap (no I/O), so building per-attempt
  // costs nothing and keeps the post-reconnect state pristine.
  const transport = deps.buildTransport(descriptor);
  const clients = createClients(transport);

  // (3) Call Hello as the first RPC.
  const request = create(HelloRequestSchema, {
    clientKind,
    protoMinVersion,
  });

  let response;
  try {
    response = await clients.session.hello(request, { signal: deps.signal });
  } catch (err) {
    // FailedPrecondition (Code 9) on Hello = version mismatch per ch02 §6
    // + ch08 §6. Surface as a typed non-retryable error so the call site
    // can render the blocking modal. Any other Connect code → rethrow as-is
    // for the reconnect driver to handle (default: retry).
    if (err instanceof ConnectError && err.code === Code.FailedPrecondition) {
      // Best-effort extraction of the daemon's reported version from
      // `ErrorDetail.extra["daemon_proto_version"]` per ch04 §2 / ch02 §6.
      // If extraction fails we still surface the mismatch with `null`.
      const daemonProtoVersion = extractDaemonProtoVersion(err);
      throw new HelloVersionMismatchError(
        daemonProtoVersion,
        protoMinVersion,
        null,
        err,
      );
    }
    throw err;
  }

  // (4) Defensive client-side floor check. Belt + suspenders: the daemon
  // SHOULD have rejected if `protoVersion < protoMinVersion`, but if a
  // misconfigured daemon returned 200 we still detect the mismatch here.
  if (response.protoVersion < protoMinVersion) {
    throw new HelloVersionMismatchError(
      response.protoVersion,
      protoMinVersion,
      response.daemonVersion,
    );
  }

  return {
    bootId: descriptor.boot_id,
    daemonVersion: response.daemonVersion,
    protoVersion: response.protoVersion,
    listenerId: response.listenerId,
  };
}

/**
 * Extract `extra["daemon_proto_version"]` from a FailedPrecondition error.
 * Returns `null` if the daemon did not include the structured detail (older
 * daemon, or transport stripped trailers). Pure helper, no side effects.
 */
function extractDaemonProtoVersion(err: ConnectError): number | null {
  // ConnectError.metadata is a Headers; the structured detail (per ch04 §2)
  // travels in the trailers. We do not parse the binary `error_details_pb`
  // here to keep this module dep-light — the call site can render the raw
  // error if richer detail is needed. v0.4 may add a parsed-detail accessor
  // when it ships the cf-access principal switcher; until then `null` is
  // honest about not knowing.
  void err;
  return null;
}

// ---------------------------------------------------------------------------
// Default descriptor fetcher
// ---------------------------------------------------------------------------

/**
 * Default `fetchDescriptor` impl — runs against the global `fetch` and the
 * locked `DESCRIPTOR_URL`. Lives here (not in the call site) so tests of
 * call-site code can pass `defaultFetchDescriptor` if they want the real
 * path, while unit tests of `performHello` inject a fake.
 */
export async function defaultFetchDescriptor(): Promise<DescriptorV1> {
  // Locked URL per spec ch08 §4.1 step 3 (mirrors `DESCRIPTOR_URL` in
  // `../../main/protocol-app.ts`). Duplicated as a literal here rather
  // than dynamically imported because `protocol-app.ts` pulls in
  // `node:fs/promises` + `node:path` for the main-process descriptor
  // path helpers — modules a renderer bundle (webpack target: web)
  // cannot resolve. Drift between the two literals is impossible to
  // ship: the descriptor handler in main keys against the same string,
  // so a typo here surfaces as a 404 in the renderer's first fetch.
  const DESCRIPTOR_URL = 'app://ccsm/listener-descriptor.json';
  const res = await fetch(DESCRIPTOR_URL);
  if (!res.ok) {
    throw new DescriptorFetchError(
      `descriptor URL ${DESCRIPTOR_URL} returned HTTP ${res.status}`,
    );
  }
  const text = await res.text();
  // Avoid importing the parser (it asserts every field) — the main process
  // already validated; trust the structurally-typed JSON. This keeps the
  // renderer free of `node:fs` / `node:path` transitive deps.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new DescriptorFetchError(
      `descriptor URL returned non-JSON: ${(err as Error).message}`,
      err,
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { boot_id?: unknown }).boot_id !== 'string' ||
    typeof (parsed as { address?: unknown }).address !== 'string'
  ) {
    throw new DescriptorFetchError(
      `descriptor URL ${DESCRIPTOR_URL} returned malformed payload (missing boot_id/address)`,
    );
  }
  return parsed as DescriptorV1;
}
