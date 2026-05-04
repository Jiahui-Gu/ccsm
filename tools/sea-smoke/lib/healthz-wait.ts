// tools/sea-smoke/lib/healthz-wait.ts
//
// Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
//       chapter 10 §7 step 2 — "Poll Supervisor /healthz (per-OS UDS path
//       from chapter 02 §2) for HTTP 200 within 10 s; fail otherwise".
//
// SRP: producer (issues HTTP probes) + decider (timeout vs 200) wrapped
// behind a single waitForHealthz() async function. No service-manager
// commands here — that lives in service-log.ts; no transport dialing —
// that lives in main.ts. This file owns ONE concern: "supervisor said
// ready within budget". Re-callable from any caller (the CI smoke,
// post-install scripts in the future) without dragging the smoke graph.
//
// Implementation note: node:http's request() accepts `socketPath` for
// both POSIX UDS files and Windows named pipes (libuv binds either to
// the same uv_pipe_t). The Host: header value is irrelevant for UDS but
// node:http requires SOMETHING — we pass 'localhost'. This mirrors the
// production probe in packages/daemon/build/install/post-install-healthz.sh
// (curl --unix-socket) and the Windows raw-pipe variant in
// post-install-healthz.ps1 (which can't use Invoke-WebRequest because
// PowerShell lacks named-pipe transport in IWR).

import { request as httpRequest } from 'node:http';

/**
 * Result of a single /healthz probe. `status: 0` means "no response"
 * (connection refused, ENOENT on the socket path, per-probe timeout, etc.) —
 * distinguishable from a real HTTP failure status like 503.
 */
export interface HealthzProbeResult {
  readonly status: number;
  readonly body: string;
}

export interface WaitForHealthzOptions {
  /**
   * Supervisor UDS path on POSIX, named-pipe path on Windows
   * (`\\.\pipe\ccsm-supervisor`). Per spec ch03 §7 the supervisor is
   * UDS-only on every OS — there is no loopback-TCP fallback.
   */
  readonly address: string;
  /** Total budget in ms. Spec ch10 §7 step 2 mandates 10s. */
  readonly timeoutMs?: number;
  /** Per-probe interval in ms. Defaults to 500ms (20 probes per 10s budget). */
  readonly intervalMs?: number;
  /** Per-probe socket connect/read timeout. Defaults to 1000ms. */
  readonly perProbeTimeoutMs?: number;
  /** Optional progress sink — receives one line per probe. */
  readonly onProbe?: (attempt: number, status: number, elapsedMs: number) => void;
}

/**
 * Issue a single HTTP GET /healthz over the given socket path. Resolves
 * with the parsed status code + body. Never throws — connection failures
 * surface as `{ status: 0, body: '' }` so the polling loop above can keep
 * retrying without try/catch noise.
 */
export function probeHealthz(
  address: string,
  perProbeTimeoutMs: number,
): Promise<HealthzProbeResult> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        socketPath: address,
        method: 'GET',
        path: '/healthz',
        // node:http requires a host header when using socketPath; the
        // supervisor server ignores its value (UDS / pipe is the auth
        // boundary, not the Host: line).
        headers: { host: 'localhost' },
        timeout: perProbeTimeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', () => resolve({ status: 0, body: '' }));
      },
    );
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '' });
    });
    req.end();
  });
}

/**
 * Poll Supervisor /healthz until either (a) HTTP 200 is observed, or
 * (b) the wall-clock budget elapses. Returns the final probe result.
 *
 * Spec ch10 §7 step 2: budget is 10s; on timeout the caller MUST capture
 * the per-OS service-manager log (service-log.ts) and exit non-zero.
 */
export async function waitForHealthz(
  opts: WaitForHealthzOptions,
): Promise<HealthzProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 500;
  const perProbeTimeoutMs = opts.perProbeTimeoutMs ?? 1_000;
  const start = Date.now();
  let attempt = 0;
  let last: HealthzProbeResult = { status: 0, body: '' };

  while (Date.now() - start < timeoutMs) {
    attempt += 1;
    last = await probeHealthz(opts.address, perProbeTimeoutMs);
    if (opts.onProbe) {
      opts.onProbe(attempt, last.status, Date.now() - start);
    }
    if (last.status === 200) {
      return last;
    }
    // Sleep until the next interval boundary OR the deadline, whichever
    // comes first. Avoids a final useless sleep past the budget.
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }

  return last;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
