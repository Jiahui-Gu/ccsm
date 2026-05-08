// R-14 (Task #34) — HTTP probe stable readiness window.
//
// Why: stdout-sniffing is not a real handshake. wrangler dev / wrangler pages
// dev print "Ready on http://…" once the listener is up, but they may then
// reparse config (`_redirects`, `wrangler.toml`) and reload the runtime —
// during which a TCP `ECONNRESET` / `ECONNREFUSED` window briefly opens. The
// next page.goto in playwright can land in that window and fail with
// `net::ERR_CONNECTION_RESET`. (See research-33 line 39-46/122-130/136 for
// the wrangler reparser warning loop that fingerprinted this.)
//
// Fix: after the readyMatch substring lands on stdout, poll the HTTP listener
// every 200ms; consider the server "stable" only after `stableForMs` of
// consecutive successful probes (status in 200..499 — the upper-bound 5xx
// excludes the wrangler-reload window which surfaces as 502/503 / TCP reset
// / ECONNREFUSED). Throw on overall timeout with last-status / errno context
// so the caller's runStage marker fingerprints which probe got stuck.
//
// We use Node 22's global `fetch` (web platform standard, no new dep). 200ms
// poll cadence is a tradeoff: short enough that a 3000ms stable window means
// at least 15 consecutive successful probes (a 1-2 reload bounce is not
// silently absorbed); long enough that wrangler does not get hammered.
//
// R-15 (Task #37) — observability layer. dev-36 verify exposed a stage 1
// 60s timeout with `lastStatus=null lastErrno=UND_ERR_HEADERS_TIMEOUT`: TCP
// accept passed, but GET / never returned headers. The previous helper only
// logged on timeout, so we could not tell whether (a) wrangler cold-started
// and the first probe never got headers, (b) every probe stuck the same
// way, or (c) headers arrived and stalled mid-body. We now emit a one-shot
// `start` line and a per-attempt line **only when (status, errno) changes**
// — naive per-poll logging would emit ~300 lines per 60s stage and bury
// signal. Timeout summary still prints the final state for grep-ability.

export interface WaitForHttpStableOptions {
  /** Total budget before the helper rejects, ms. */
  timeout: number;
  /** Required consecutive-success window before resolving, ms. */
  stableForMs: number;
  /** Poll interval between probes, ms. Default 200ms. */
  pollIntervalMs?: number;
  /**
   * Optional override for the fetch implementation. Tests use this to inject a
   * stub; production passes nothing and we fall back to globalThis.fetch.
   */
  fetchImpl?: typeof fetch;
  /**
   * Optional clock injection for tests so we can drive `Date.now` and
   * `setTimeout` deterministically. Production paths use real timers.
   */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * R-15 (Task #37) — sink for per-attempt observability. Defaults to
   * process.stderr.write so smoke logs fingerprint a stuck wrangler probe
   * (UND_ERR_HEADERS_TIMEOUT, ECONNREFUSED, …) without flipping behavior.
   * Tests inject a spy to assert the change-only log cadence.
   */
  log?: (line: string) => void;
}

const DEFAULT_POLL_MS = 200;

interface ProbeOutcome {
  ok: boolean;
  status: number | null;
  errno: string | null;
}

async function probeOnce(url: string, fetchImpl: typeof fetch): Promise<ProbeOutcome> {
  try {
    const res = await fetchImpl(url, { method: 'GET' });
    // Drain so the connection can be reused / closed cleanly. wrangler will
    // log a warning if we leave the body unread on every probe.
    try { await res.arrayBuffer(); } catch { /* ignore */ }
    const ok = res.status >= 200 && res.status < 500;
    return { ok, status: res.status, errno: null };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException };
    const errno = e.code ?? e.cause?.code ?? e.message ?? 'UNKNOWN';
    return { ok: false, status: null, errno };
  }
}

/**
 * Resolve once the HTTP listener at `url` has been reachable continuously for
 * `stableForMs`. Reject if the total budget `timeout` elapses first.
 *
 * "Reachable" = HTTP status in [200, 500). 5xx + TCP error + DNS error count
 * as failures and reset the consecutive-success window — this is what catches
 * the wrangler-reparser reload race.
 */
export async function waitForHttpStable(
  url: string,
  opts: WaitForHttpStableOptions,
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const log = opts.log ?? ((line) => process.stderr.write(line));

  if (typeof fetchImpl !== 'function') {
    throw new Error('waitForHttpStable: no fetch implementation available');
  }

  const start = now();
  const deadline = start + opts.timeout;
  let stableSince: number | null = null;
  let lastStatus: number | null = null;
  let lastErrno: string | null = null;
  // R-15 (Task #37) — change-only attempt logging. With pollIntervalMs=200
  // and timeout=60_000, naive per-attempt logging would emit 300 lines per
  // stage; we only emit when (status, errno) transitions, plus the first
  // attempt and the timeout summary. This is enough to fingerprint
  // UND_ERR_HEADERS_TIMEOUT vs ECONNREFUSED vs partial-headers-then-stuck
  // without burying real signal under poll noise.
  let attempt = 0;
  let prevKey: string | null = null;
  log(`[wait-http-stable ${url}] start poll=${pollIntervalMs}ms stableForMs=${opts.stableForMs} timeout=${opts.timeout}\n`);

  while (now() < deadline) {
    const outcome = await probeOnce(url, fetchImpl);
    lastStatus = outcome.status;
    lastErrno = outcome.errno;
    attempt += 1;
    const key = `${outcome.status ?? 'null'}|${outcome.errno ?? 'null'}`;
    if (prevKey === null || prevKey !== key) {
      log(
        `[wait-http-stable ${url}] attempt=${attempt} elapsed=${now() - start}ms ` +
        `status=${outcome.status ?? 'null'} errno=${outcome.errno ?? 'null'}\n`,
      );
      prevKey = key;
    }

    if (outcome.ok) {
      const t = now();
      if (stableSince === null) stableSince = t;
      if (t - stableSince >= opts.stableForMs) return;
    } else {
      stableSince = null;
    }

    await sleep(pollIntervalMs);
  }

  const summary =
    `waitForHttpStable(${url}) timed out after ${opts.timeout}ms ` +
    `(stableForMs=${opts.stableForMs}, lastStatus=${lastStatus ?? 'null'}, lastErrno=${lastErrno ?? 'null'})`;
  log(`[wait-http-stable ${url}] timeout attempts=${attempt} ${summary}\n`);
  throw new Error(summary);
}
