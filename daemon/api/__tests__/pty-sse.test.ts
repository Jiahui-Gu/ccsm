/**
 * SSE pipe correctness UT for `daemon/api/pty.ts` — Task #604, PR-6
 * (spec 2026-05-06 v0.3 e2e-cutover §3.2 / §5.3.6).
 *
 * Pins the multi-subscriber + sigkill-reattach guarantees that
 * `attach-replay-from-headless-buffer` (Set A) and `sigkill-reattach`
 * (Set B informational) depend on at the daemon HTTP boundary:
 *
 *   - **G-1** Late-subscriber: a `pty:data` event MUST be delivered to
 *     every SSE response that was open BEFORE the event was emitted.
 *   - **G-2** Snapshot-then-live: the `attach` RPC returns the headless
 *     buffer snapshot; the SSE channel carries strictly the live tail
 *     (no replay of pre-subscribe chunks). `getBufferSnapshot` returns
 *     `{snapshot, seq}` so a late subscriber can dedupe in v0.4.
 *   - **G-3** `pty:exit` MUST fire exactly once per SSE response (not
 *     duplicated across belt-and-braces fan-out paths).
 *   - **G-4** Auto-reconnect (a fresh GET on the same sid) opens a new
 *     subscriber and MUST NOT replay events the first socket already
 *     received — the daemon keeps no per-SSE backlog.
 *
 * Sigkill-reattach: this test exercises the daemon-side contract — a
 * pty exit followed by a fresh spawn for the SAME sid restores
 * attach-replay through the existing v0.2 `getBufferSnapshot` path
 * (no new TTL / cap / cwd / dedup contracts in v0.3 per §3.4.2).
 *
 * Mocking: `daemon/ptyHost` is faked end-to-end so we never spawn
 * node-pty in CI. The fake mirrors the production fan-out contract
 * (subscriber.send invoked once per chunk, once per exit) so the SSE
 * multiplexer is exercised over a real http.Server + EventSource-like
 * client (raw fetch + line parser; EventSource in Node is not bundled
 * in vitest's default env).
 *
 * The handler module is auto-registered via `register(router)` per the
 * production wiring path so coverage exercises the real route table,
 * not a re-implementation.
 */

import { TextDecoder } from "node:util";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { PtyAttachedSubscriber } from "../../ptyHost";

// --- Fake ptyHost bus -------------------------------------------------------
//
// The HTTP layer talks to ptyHost via:
//   spawnPtySession / attachPtySession / detachPtySession / getPtySession
//   listPtySessions / inputPtySession / resizePtySession / killPtySession
//   getBufferSnapshot / registerSubscriber / unregisterSubscriber
//   onPtyExit
// We model a tiny in-memory session map + per-sid subscriber set + an
// onPtyExit listener queue, then drive both pty:data + pty:exit through
// the registered subscribers (mirroring `entryFactory.dispatchPtyChunk`'s
// loop and `p.onExit`'s loop).

interface FakeSession {
  sid: string;
  pid: number;
  cols: number;
  rows: number;
  cwd: string;
  buffer: string;
  seq: number;
  subscribers: Map<string, PtyAttachedSubscriber>;
  exited: boolean;
}

interface SseBus {
  sessions: Map<string, FakeSession>;
  exitListeners: Set<(sid: string, payload: { code: number | null; signal: number | null }) => void>;
}

function bus(): SseBus {
   
  return (globalThis as any).__sseBus as SseBus;
}

vi.mock("../../ptyHost", () => ({
  spawnPtySession: (sid: string, cwd: string) => {
    const b = bus();
    const existing = b.sessions.get(sid);
    if (existing) {
      // sigkill-reattach: same-sid spawn after exit MUST be idempotent
      // when a session record already exists. v0.2 behaviour returned
      // the existing info (see daemon/ptyHost/lifecycle.ts spawn()).
      existing.exited = false;
      return { sid, pid: existing.pid, cols: existing.cols, rows: existing.rows, cwd: existing.cwd };
    }
    const session: FakeSession = {
      sid,
      pid: 9000 + b.sessions.size,
      cols: 80,
      rows: 24,
      cwd,
      buffer: "",
      seq: 0,
      subscribers: new Map(),
      exited: false,
    };
    b.sessions.set(sid, session);
    return { sid, pid: session.pid, cols: session.cols, rows: session.rows, cwd: session.cwd };
  },
  attachPtySession: (sid: string) => {
    const s = bus().sessions.get(sid);
    if (!s) return null;
    return { snapshot: s.buffer, cols: s.cols, rows: s.rows, pid: s.pid };
  },
  detachPtySession: () => undefined,
  getPtySession: (sid: string) => {
    const s = bus().sessions.get(sid);
    return s ? { sid, pid: s.pid, cols: s.cols, rows: s.rows, cwd: s.cwd } : null;
  },
  listPtySessions: () =>
    Array.from(bus().sessions.values()).map((s) => ({
      sid: s.sid,
      pid: s.pid,
      cols: s.cols,
      rows: s.rows,
      cwd: s.cwd,
    })),
  inputPtySession: () => undefined,
  resizePtySession: () => undefined,
  killPtySession: () => true,
  getBufferSnapshot: async (sid: string) => {
    const s = bus().sessions.get(sid);
    if (!s) return { snapshot: "", seq: 0 };
    return { snapshot: s.buffer, seq: s.seq };
  },
  onPtyExit: (cb: (sid: string, payload: { code: number | null; signal: number | null }) => void) => {
    bus().exitListeners.add(cb);
    return () => bus().exitListeners.delete(cb);
  },
  registerSubscriber: (sid: string, sub: PtyAttachedSubscriber) => {
    const s = bus().sessions.get(sid);
    if (!s || s.exited) return false;
    s.subscribers.set(sub.id, sub);
    return true;
  },
  unregisterSubscriber: (sid: string, subId: string) => {
    const s = bus().sessions.get(sid);
    if (!s) return;
    s.subscribers.delete(subId);
  },
}));

vi.mock("../../ptyHost/claudeResolver", () => ({
  resolveClaude: () => "/usr/bin/claude",
}));

// Imports AFTER vi.mock so the module under test picks up the fakes.
import { Router } from "../../router";
import { startServer, type ServerHandle } from "../../server";
import register, { __resetForTest } from "../pty";

// --- Fixture ----------------------------------------------------------------

let handle: ServerHandle;
let baseUrl: string;

function freshBus(): SseBus {
  return {
    sessions: new Map<string, FakeSession>(),
    exitListeners: new Set(),
  };
}

beforeAll(async () => {
  // The SSE handler module installs its module-level `onPtyExit` listener
  // on first `register()` call (idempotent guard inside ensureFanoutInstalled).
  // Seed the bus BEFORE register so the mocked onPtyExit can record the
  // close-loop callback.
   
  (globalThis as any).__sseBus = freshBus();
  const router = new Router();
  register(router);
  handle = await startServer({ router });
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => {
  await handle.close();
});

beforeEach(() => {
  // Keep the exitListeners Set across tests — the SSE handler registers
  // its close-loop callback once at module load (ensureFanoutInstalled
  // is idempotent). Resetting the Set would orphan that callback. Only
  // the per-test session map needs a clean slate.
   
  (globalThis as any).__sseBus.sessions = new Map<string, FakeSession>();
});

afterEach(() => {
  __resetForTest();
});

// --- Helpers ----------------------------------------------------------------

interface SseEvent { event: string; data: unknown }

interface OpenedSse {
  events: SseEvent[];
  /** Resolves the next time `predicate(events)` returns true. */
  waitFor: (predicate: (events: SseEvent[]) => boolean, timeoutMs?: number) => Promise<void>;
  close: () => void;
  done: Promise<void>;
}

/**
 * Open an SSE stream against the daemon. Returns an `OpenedSse` whose
 * `events` array fills as `event:` / `data:` lines arrive. We parse SSE
 * by hand because Node's WHATWG fetch streams give us a chunked
 * `ReadableStream<Uint8Array>` and the EventSource polyfills disagree
 * on import shape across vitest setups.
 */
async function openSse(sid: string): Promise<OpenedSse> {
  const ctrl = new AbortController();
  const res = await fetch(`${baseUrl}/api/events/pty?sid=${encodeURIComponent(sid)}`, {
    signal: ctrl.signal,
  });
  if (!res.ok || !res.body) throw new Error(`SSE open failed: HTTP ${res.status}`);

  const events: SseEvent[] = [];
  const waiters: Array<{ predicate: (e: SseEvent[]) => boolean; resolve: () => void }> = [];

  function notify(): void {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].predicate(events)) {
        const w = waiters[i];
        waiters.splice(i, 1);
        w.resolve();
      }
    }
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let pendingEvent = "";

  const done = (async () => {
    try {
       
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        // SSE message terminator is a blank line (\n\n); split on \n and
        // accumulate lines until we hit an empty one.
        let nlIdx: number;
         
        while ((nlIdx = buffered.indexOf("\n")) !== -1) {
          const line = buffered.slice(0, nlIdx).replace(/\r$/, "");
          buffered = buffered.slice(nlIdx + 1);
          if (line === "") {
            // dispatch boundary; nothing here because we push as we go
            continue;
          }
          if (line.startsWith(":")) continue; // comment (initial flush)
          if (line.startsWith("event: ")) {
            pendingEvent = line.slice("event: ".length);
            continue;
          }
          if (line.startsWith("data: ")) {
            const raw = line.slice("data: ".length);
            let parsed: unknown;
            try { parsed = JSON.parse(raw); } catch { parsed = raw; }
            events.push({ event: pendingEvent || "message", data: parsed });
            pendingEvent = "";
            notify();
          }
        }
      }
    } catch {
      /* socket aborted */
    }
  })();

  return {
    events,
    waitFor(predicate, timeoutMs = 2000) {
      return new Promise<void>((resolve, reject) => {
        if (predicate(events)) { resolve(); return; }
        const t = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.resolve === resolve);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`waitFor timed out after ${timeoutMs}ms; got events=${JSON.stringify(events)}`));
        }, timeoutMs);
        waiters.push({
          predicate,
          resolve: () => { clearTimeout(t); resolve(); },
        });
      });
    },
    close() {
      try { ctrl.abort(); } catch { /* already aborted */ }
    },
    done,
  };
}

/** Drive a chunk through every subscriber attached to `sid`, mirroring
 *  the `dispatchPtyChunk` loop. Bumps seq + appends to fake buffer first
 *  so a follow-up `getBufferSnapshot` reflects the chunk. */
function emitChunk(sid: string, chunk: string): void {
  const s = bus().sessions.get(sid);
  if (!s) return;
  s.seq += 1;
  s.buffer += chunk;
  for (const sub of s.subscribers.values()) {
    if (!sub.isDestroyed()) {
      try { sub.send("pty:data", { sid, chunk, seq: s.seq }); } catch { /* sub gone */ }
    }
  }
}

/** Drive an exit through every subscriber + module-level onPtyExit, mirroring
 *  `entryFactory`'s `p.onExit`. Subscribers receive ONE `pty:exit`; the
 *  module-level fan-out then closes the SSE response (no second emit). */
function emitExit(sid: string, payload: { code: number | null; signal: number | null }): void {
  const s = bus().sessions.get(sid);
  if (!s) return;
  s.exited = true;
  for (const sub of s.subscribers.values()) {
    if (!sub.isDestroyed()) {
      try {
        sub.send("pty:exit", { sessionId: sid, code: payload.code, signal: payload.signal });
      } catch { /* sub gone */ }
    }
  }
  for (const cb of [...bus().exitListeners]) {
    try { cb(sid, payload); } catch { /* listener gone */ }
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await r.json()) as T;
}

// Allow the SSE handler's synchronous `registerSubscriber` to land before
// we drive the fake — the open in `fetch` resolves once headers are
// flushed, but the per-sid subscriber is `set()` on the same tick. One
// macrotask is enough to be safe across Node http internals.
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

// ----------------------------------------------------------------------------
// G-1: snapshot-then-live + late-subscriber receives every post-subscribe chunk
// ----------------------------------------------------------------------------

describe("SSE G-1 — late subscriber gets every post-subscribe pty:data", () => {
  it("subscriber that opens AFTER pre-subscribe chunks receives ONLY post-subscribe chunks", async () => {
    await postJson<{ ok: true }>("/api/pty/spawn", { sid: "g1", cwd: "/work" });

    // Pre-subscribe activity — these chunks land in the headless buffer
    // but no SSE client is wired, so nothing is delivered over the wire.
    emitChunk("g1", "pre-1");
    emitChunk("g1", "pre-2");

    // Late subscriber attaches. G-2: the attach RPC carries the snapshot
    // of pre-subscribe activity; the SSE stream is "live tail only."
    const attach = await postJson<{ ok: true; attach: { snapshot: string; pid: number } | null }>(
      "/api/pty/attach",
      { sid: "g1" },
    );
    expect(attach.attach?.snapshot).toBe("pre-1pre-2");

    const sse = await openSse("g1");
    await tick();

    // Post-subscribe live tail — these MUST be delivered.
    emitChunk("g1", "live-1");
    emitChunk("g1", "live-2");
    await sse.waitFor((e) => e.filter((x) => x.event === "pty:data").length >= 2);

    const datas = sse.events
      .filter((e) => e.event === "pty:data")
      .map((e) => (e.data as { chunk: string; seq: number }));
    expect(datas).toEqual([
      { sid: "g1", chunk: "live-1", seq: 3 },
      { sid: "g1", chunk: "live-2", seq: 4 },
    ]);
    // Pre-subscribe chunks MUST NOT appear on the SSE wire.
    expect(datas.find((d) => d.chunk.startsWith("pre"))).toBeUndefined();

    sse.close();
    await sse.done;
  });
});

// ----------------------------------------------------------------------------
// G-2: getBufferSnapshot returns {snapshot, seq} so dedupe is possible
// ----------------------------------------------------------------------------

describe("SSE G-2 — attach-replay surface (snapshot-then-live)", () => {
  it("getBufferSnapshot returns {snapshot, seq} and tracks emitChunk activity", async () => {
    await postJson<{ ok: true }>("/api/pty/spawn", { sid: "g2", cwd: "/work" });
    emitChunk("g2", "ABC");
    emitChunk("g2", "DEF");

    const r = await postJson<{ ok: true; snapshot: string; seq: number }>(
      "/api/pty/getBufferSnapshot",
      { sid: "g2" },
    );
    expect(r.snapshot).toBe("ABCDEF");
    expect(r.seq).toBe(2);
  });

  it("attach RPC for unknown sid returns attach:null (not 404, not throw)", async () => {
    const r = await postJson<{ ok: true; attach: unknown }>("/api/pty/attach", { sid: "ghost" });
    expect(r.attach).toBeNull();
  });

  it("getBufferSnapshot for unknown sid returns {snapshot:'', seq:0}", async () => {
    const r = await postJson<{ ok: true; snapshot: string; seq: number }>(
      "/api/pty/getBufferSnapshot",
      { sid: "ghost" },
    );
    expect(r.snapshot).toBe("");
    expect(r.seq).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// G-3: pty:exit fires exactly once per subscriber, even with N subscribers
// ----------------------------------------------------------------------------

describe("SSE G-3 — pty:exit fires exactly once per subscriber", () => {
  it("two subscribers each receive every pty:data and exactly one pty:exit", async () => {
    await postJson("/api/pty/spawn", { sid: "g3", cwd: "/work" });

    const a = await openSse("g3");
    const b = await openSse("g3");
    await tick();

    emitChunk("g3", "shared-1");
    emitChunk("g3", "shared-2");
    await a.waitFor((e) => e.filter((x) => x.event === "pty:data").length >= 2);
    await b.waitFor((e) => e.filter((x) => x.event === "pty:data").length >= 2);

    emitExit("g3", { code: 0, signal: null });
    await a.waitFor((e) => e.some((x) => x.event === "pty:exit"));
    await b.waitFor((e) => e.some((x) => x.event === "pty:exit"));
    // Allow the module-level onPtyExit close-loop to settle — it MUST NOT
    // emit a second pty:exit on either response.
    await tick();
    await tick();

    const aExits = a.events.filter((e) => e.event === "pty:exit");
    const bExits = b.events.filter((e) => e.event === "pty:exit");
    expect(aExits.length).toBe(1);
    expect(bExits.length).toBe(1);
    expect(aExits[0].data).toEqual({ sessionId: "g3", code: 0, signal: null });

    const aData = a.events.filter((e) => e.event === "pty:data").map((e) => (e.data as { chunk: string }).chunk);
    const bData = b.events.filter((e) => e.event === "pty:data").map((e) => (e.data as { chunk: string }).chunk);
    expect(aData).toEqual(["shared-1", "shared-2"]);
    expect(bData).toEqual(["shared-1", "shared-2"]);

    await Promise.all([a.done, b.done]);
  });

  it("subscriber unsubscribes mid-stream — sibling unaffected", async () => {
    await postJson("/api/pty/spawn", { sid: "g3b", cwd: "/work" });
    const a = await openSse("g3b");
    const b = await openSse("g3b");
    await tick();

    emitChunk("g3b", "both-1");
    await a.waitFor((e) => e.filter((x) => x.event === "pty:data").length >= 1);
    await b.waitFor((e) => e.filter((x) => x.event === "pty:data").length >= 1);

    a.close();
    await a.done;

    // Sibling keeps streaming; the closed subscriber MUST be removed
    // from the per-entry attached map by closeSseClient → unregisterSubscriber.
    emitChunk("g3b", "b-only");
    await b.waitFor((e) => e.filter((x) => x.event === "pty:data").length >= 2);

    const aData = a.events.filter((e) => e.event === "pty:data").map((e) => (e.data as { chunk: string }).chunk);
    const bData = b.events.filter((e) => e.event === "pty:data").map((e) => (e.data as { chunk: string }).chunk);
    expect(aData).toEqual(["both-1"]);
    expect(bData).toEqual(["both-1", "b-only"]);

    b.close();
    await b.done;
  });
});

// ----------------------------------------------------------------------------
// G-4: reconnect = fresh subscriber, no replay of pre-reconnect events
// ----------------------------------------------------------------------------

describe("SSE G-4 — reconnect opens a fresh tail (no daemon-side replay)", () => {
  it("close + re-open the same sid: new socket sees only post-reconnect chunks", async () => {
    await postJson("/api/pty/spawn", { sid: "g4", cwd: "/work" });
    const first = await openSse("g4");
    await tick();
    emitChunk("g4", "before-1");
    emitChunk("g4", "before-2");
    await first.waitFor((e) => e.filter((x) => x.event === "pty:data").length >= 2);
    first.close();
    await first.done;

    // Reconnect — fresh GET on the same sid.
    const second = await openSse("g4");
    await tick();
    emitChunk("g4", "after-1");
    await second.waitFor((e) => e.filter((x) => x.event === "pty:data").length >= 1);

    const secondData = second.events
      .filter((e) => e.event === "pty:data")
      .map((e) => (e.data as { chunk: string; seq: number }));
    // The new socket MUST NOT receive the pre-reconnect events even
    // though they are still in the daemon's headless buffer (those are
    // for `getBufferSnapshot`, not the SSE backlog).
    expect(secondData.find((d) => d.chunk.startsWith("before"))).toBeUndefined();
    expect(secondData).toEqual([{ sid: "g4", chunk: "after-1", seq: 3 }]);
    // seq is monotonic across reconnects (per-entry counter, not per-socket).
    expect(secondData[0].seq).toBeGreaterThan(2);

    second.close();
    await second.done;
  });

  it("opening SSE for a sid that already exited returns synthetic pty:exit + closes", async () => {
    await postJson("/api/pty/spawn", { sid: "g4b", cwd: "/work" });
    emitExit("g4b", { code: 0, signal: null });
    // Force the session to look gone for registerSubscriber.
    bus().sessions.delete("g4b");

    const sse = await openSse("g4b");
    await sse.waitFor((e) => e.some((x) => x.event === "pty:exit"));
    const exits = sse.events.filter((e) => e.event === "pty:exit");
    expect(exits.length).toBe(1);
    expect(exits[0].data).toEqual({ sessionId: "g4b", code: null, signal: null });
    await sse.done;
  });
});

// ----------------------------------------------------------------------------
// sigkill-reattach v0.2 baseline — restore (not extend)
// ----------------------------------------------------------------------------

describe("sigkill-reattach v0.2 baseline (HP-8) — attach-replay only, no new TTL/cap/cwd", () => {
  it("after SIGKILL exit + same-sid spawn + attach: snapshot still serves prior buffer (v0.2 path)", async () => {
    // 1. Spawn + drive some output.
    await postJson("/api/pty/spawn", { sid: "sk", cwd: "/work" });
    emitChunk("sk", "history-A");
    emitChunk("sk", "history-B");

    // 2. SIGKILL — deliver pty:exit (signal:'SIGKILL' shape per
    //    daemon/api/pty.ts). v0.2 daemon retains the headless buffer
    //    until the renderer re-spawns; the fake mirrors that.
    emitExit("sk", { code: null, signal: 9 });

    // 3. Renderer issues a fresh spawn for the SAME sid (v0.2 idempotent).
    const respawn = await postJson<{ ok: true; sid: string }>("/api/pty/spawn", {
      sid: "sk",
      cwd: "/work",
    });
    expect(respawn.ok).toBe(true);

    // 4. Attach → snapshot replay. v0.3 contract: NO new shape — the
    //    existing v0.2 `attach` envelope returns the snapshot string;
    //    the renderer paints, then opens SSE for the live tail.
    const attach = await postJson<{ ok: true; attach: { snapshot: string } | null }>(
      "/api/pty/attach",
      { sid: "sk" },
    );
    expect(attach.attach?.snapshot).toBe("history-Ahistory-B");
  });

  it("post-respawn SSE delivers fresh pty:data for the new pty (no cross-talk)", async () => {
    await postJson("/api/pty/spawn", { sid: "sk2", cwd: "/work" });
    emitChunk("sk2", "old-output");
    emitExit("sk2", { code: null, signal: 9 });
    await postJson("/api/pty/spawn", { sid: "sk2", cwd: "/work" });

    const sse = await openSse("sk2");
    await tick();
    emitChunk("sk2", "fresh-after-respawn");
    await sse.waitFor((e) => e.filter((x) => x.event === "pty:data").length >= 1);

    const datas = sse.events
      .filter((e) => e.event === "pty:data")
      .map((e) => (e.data as { chunk: string }).chunk);
    expect(datas).toEqual(["fresh-after-respawn"]);
    // Old chunks remain in the snapshot (verified above) but MUST NOT
    // be replayed on the SSE wire — that's the G-4 invariant repeated
    // in the sigkill flow.
    expect(datas).not.toContain("old-output");

    sse.close();
    await sse.done;
  });
});
