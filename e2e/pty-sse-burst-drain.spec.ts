/**
 * pty-sse-burst-drain — Set B informational e2e (Task #604, PR-6).
 *
 * Spec: 2026-05-06 v0.3 e2e-cutover §3.2.4 / §3.7 F-7 / §5.3.6.
 *
 * Set assignment: **Set B (informational, v0.3)** per §3.7 F-7. The
 * latency / throughput targets and the formal drain-budget assertions
 * are deferred to v0.4. v0.3 only commits to the G-1..G-5 correctness
 * contract (covered by `daemon/api/__tests__/pty-sse.test.ts`); this
 * spec is the informational drain probe — it MUST NOT block PR-6
 * merge or v0.3 release.
 *
 * What it asserts (when enabled):
 *   - A burst of N pty:data emissions over a single SSE socket all
 *     arrive in order, with monotonic per-entry seq, and `pty:exit`
 *     fires once.
 *   - The drain wall-clock is logged for v0.4 reliability spec
 *     baseline gathering — NO threshold assertion in v0.3.
 *
 * Wire model: this spec uses the same ptyHost mock path as
 * `pty-sse.test.ts` — the burst is driven through the fake's
 * subscriber loop, so it exercises the daemon HTTP/SSE pipe end-to-end
 * (real socket, real chunked text/event-stream parsing) without a
 * real node-pty. The combination is appropriate for "drain probe":
 * the bottleneck under test is the SSE multiplexer, not pty I/O.
 *
 * Set-B gating: `describe.skipIf(!process.env.CCSM_SET_B)`. Run via
 * `CCSM_SET_B=1 npx vitest run e2e/pty-sse-burst-drain.spec.ts`.
 */

import { TextDecoder } from "node:util";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { PtyAttachedSubscriber } from "../daemon/ptyHost";

const SET_B_ENABLED = process.env.CCSM_SET_B === "1";

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

interface BurstBus {
  sessions: Map<string, FakeSession>;
  exitListeners: Set<(sid: string, p: { code: number | null; signal: number | null }) => void>;
}

function bus(): BurstBus {
   
  return (globalThis as any).__burstBus as BurstBus;
}

vi.mock("../daemon/ptyHost", () => ({
  spawnPtySession: (sid: string, cwd: string) => {
    const b = bus();
    const existing = b.sessions.get(sid);
    if (existing) {
      existing.exited = false;
      return { sid, pid: existing.pid, cols: existing.cols, rows: existing.rows, cwd: existing.cwd };
    }
    const s: FakeSession = {
      sid, pid: 1234, cols: 80, rows: 24, cwd,
      buffer: "", seq: 0, subscribers: new Map(), exited: false,
    };
    b.sessions.set(sid, s);
    return { sid, pid: s.pid, cols: s.cols, rows: s.rows, cwd: s.cwd };
  },
  attachPtySession: (sid: string) => {
    const s = bus().sessions.get(sid);
    return s ? { snapshot: s.buffer, cols: s.cols, rows: s.rows, pid: s.pid } : null;
  },
  detachPtySession: () => undefined,
  getPtySession: () => null,
  listPtySessions: () => [],
  inputPtySession: () => undefined,
  resizePtySession: () => undefined,
  killPtySession: () => true,
  getBufferSnapshot: async (sid: string) => {
    const s = bus().sessions.get(sid);
    return s ? { snapshot: s.buffer, seq: s.seq } : { snapshot: "", seq: 0 };
  },
  onPtyExit: (cb: (sid: string, p: { code: number | null; signal: number | null }) => void) => {
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
    if (s) s.subscribers.delete(subId);
  },
}));

vi.mock("../daemon/ptyHost/claudeResolver", () => ({
  resolveClaude: () => "/usr/bin/claude",
}));

import { Router } from "../daemon/router";
import { startServer, type ServerHandle } from "../daemon/server";

describe.skipIf(!SET_B_ENABLED)("pty-sse-burst-drain (Set B informational, v0.3)", () => {
  let handle: ServerHandle;
  let baseUrl: string;
  let registerFn: (router: Router) => void;
  let resetFn: () => void;

  beforeAll(async () => {
     
    (globalThis as any).__burstBus = {
      sessions: new Map<string, FakeSession>(),
      exitListeners: new Set(),
    } satisfies BurstBus;
    const mod = await import("../daemon/api/pty");
    registerFn = mod.default;
    resetFn = mod.__resetForTest;
    const router = new Router();
    registerFn(router);
    handle = await startServer({ router });
    baseUrl = `http://127.0.0.1:${handle.port}`;
  });

  afterAll(async () => {
    if (resetFn) resetFn();
    if (handle) await handle.close();
  });

  it("informational: 256 chunks burst over one SSE socket — all arrive, ordered, single pty:exit", async () => {
    const sid = "burst-1";
    await fetch(`${baseUrl}/api/pty/spawn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sid, cwd: "/work" }),
    });

    const ctrl = new AbortController();
    const res = await fetch(`${baseUrl}/api/events/pty?sid=${sid}`, { signal: ctrl.signal });
    expect(res.ok).toBe(true);
    if (!res.body) throw new Error("no body");

    const events: Array<{ event: string; data: unknown }> = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let pendingEvent = "";

    let exitSeen = false;
    const drainPromise = (async () => {
      try {
         
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          let idx: number;
           
          while ((idx = buffered.indexOf("\n")) !== -1) {
            const line = buffered.slice(0, idx).replace(/\r$/, "");
            buffered = buffered.slice(idx + 1);
            if (line.startsWith(":")) continue;
            if (line === "") continue;
            if (line.startsWith("event: ")) { pendingEvent = line.slice(7); continue; }
            if (line.startsWith("data: ")) {
              let d: unknown;
              try { d = JSON.parse(line.slice(6)); } catch { d = line.slice(6); }
              events.push({ event: pendingEvent || "message", data: d });
              if (pendingEvent === "pty:exit") exitSeen = true;
              pendingEvent = "";
            }
          }
        }
      } catch { /* aborted */ }
    })();

    // Let SSE handler register the subscriber.
    await new Promise((r) => setImmediate(r));

    // Burst of 256 chunks.
    const N = 256;
    const session = bus().sessions.get(sid)!;
    const t0 = Date.now();
    for (let i = 0; i < N; i += 1) {
      session.seq += 1;
      session.buffer += `c${i}|`;
      for (const sub of session.subscribers.values()) {
        sub.send("pty:data", { sid, chunk: `c${i}|`, seq: session.seq });
      }
    }
    // Drive exit so the SSE socket closes and the reader loop exits.
    session.exited = true;
    for (const sub of session.subscribers.values()) {
      sub.send("pty:exit", { sessionId: sid, code: 0, signal: null });
    }
    for (const cb of [...bus().exitListeners]) cb(sid, { code: 0, signal: null });

    // Wait for drain (no hard threshold — informational).
    const start = Date.now();
    while (!exitSeen && Date.now() - start < 5_000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    ctrl.abort();
    await drainPromise;

    const t1 = Date.now();
    const datas = events.filter((e) => e.event === "pty:data");
    const exits = events.filter((e) => e.event === "pty:exit");
    console.warn(
      `[setB pty-sse-burst-drain] N=${N} chunks, deliveredOverWire=${datas.length}, ` +
      `exits=${exits.length}, wallMs=${t1 - t0}, burstToFirstChunkMs=N/A, ` +
      `(informational — no threshold; v0.4 reliability spec pins target)`,
    );

    // Soft assertions only — Set B informational.
    expect(datas.length).toBe(N);
    expect(exits.length).toBe(1);
    // Ordering + monotonic seq.
    for (let i = 0; i < datas.length; i += 1) {
      const d = datas[i].data as { chunk: string; seq: number };
      expect(d.chunk).toBe(`c${i}|`);
      expect(d.seq).toBe(i + 1);
    }
  }, 15_000);
});
