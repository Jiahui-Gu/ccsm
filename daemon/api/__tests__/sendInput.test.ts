/**
 * Unit tests for `daemon/api/sendInput.ts` (`pty:input` RPC).
 *
 * Spec coverage (§3.5.1, §3.5.6):
 *   - happy path: live sid → pty.write driven, returns { ok:true }
 *   - schema rejection: missing/typed-wrong sid|data → 400 bad_request:<field>
 *   - R1 baseline-cite: unknown sid → silent-drop (200 ok:true), still
 *     calls inputPtySession (so a v0.4 surface promotion has a single
 *     grep-able call site)
 *   - resilience: inputPtySession throwing → 200 { ok:false, error:'internal' }
 *
 * Strategy: mock the `../ptyHost` barrel so we never touch node-pty /
 * sessionWatcher in unit tier. We assert ON the mock for the "real
 * impl, no stub" rule (anti-stub §3.5.5).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";

interface SendInputBus {
  liveSids: Set<string>;
  inputCalls: Array<{ sid: string; data: string }>;
  inputThrows: boolean;
}

function bus(): SendInputBus {
  return (globalThis as any).__sendInputBus as SendInputBus;
}

vi.mock("../../ptyHost", () => ({
  getPtySession: (sid: string) =>
    bus().liveSids.has(sid) ? { sid, pid: 1, cols: 80, rows: 24, cwd: "/" } : null,
  inputPtySession: (sid: string, data: string) => {
    bus().inputCalls.push({ sid, data });
    if (bus().inputThrows) throw new Error("simulated pty.write EPIPE");
  },
}));

// Import AFTER vi.mock so the handler picks up the mocked barrel.
import { sendInputHandler, registerSendInputAt } from "../sendInput";
import { Router } from "../../router";

const REQ = {} as IncomingMessage;

beforeEach(() => {
  (globalThis as any).__sendInputBus = {
    liveSids: new Set<string>(),
    inputCalls: [],
    inputThrows: false,
  } satisfies SendInputBus;
});

afterEach(() => {
  delete (globalThis as any).__sendInputBus;
  vi.restoreAllMocks();
});

describe("sendInputHandler — schema validation (400 bad_request)", () => {
  it("rejects non-object body", () => {
    expect(sendInputHandler(REQ, null)).toEqual({
      status: 400,
      error: "bad_request: body",
    });
    expect(sendInputHandler(REQ, "string")).toEqual({
      status: 400,
      error: "bad_request: body",
    });
    expect(sendInputHandler(REQ, [1, 2])).toEqual({
      status: 400,
      error: "bad_request: body",
    });
  });

  it("rejects missing/empty sid as bad_request: sid", () => {
    expect(sendInputHandler(REQ, { data: "x" })).toEqual({
      status: 400,
      error: "bad_request: sid",
    });
    expect(sendInputHandler(REQ, { sid: "", data: "x" })).toEqual({
      status: 400,
      error: "bad_request: sid",
    });
    expect(sendInputHandler(REQ, { sid: 42, data: "x" })).toEqual({
      status: 400,
      error: "bad_request: sid",
    });
  });

  it("rejects non-string data as bad_request: data", () => {
    expect(sendInputHandler(REQ, { sid: "s1" })).toEqual({
      status: 400,
      error: "bad_request: data",
    });
    expect(sendInputHandler(REQ, { sid: "s1", data: 123 })).toEqual({
      status: 400,
      error: "bad_request: data",
    });
    expect(sendInputHandler(REQ, { sid: "s1", data: null })).toEqual({
      status: 400,
      error: "bad_request: data",
    });
  });

  it("does NOT call inputPtySession on schema rejection", () => {
    sendInputHandler(REQ, { sid: "", data: "x" });
    sendInputHandler(REQ, { sid: "s", data: 1 });
    expect(bus().inputCalls).toEqual([]);
  });
});

describe("sendInputHandler — happy path (live sid)", () => {
  beforeEach(() => bus().liveSids.add("live-sid"));

  it("returns { ok:true } and drives inputPtySession with sid+data verbatim", () => {
    const res = sendInputHandler(REQ, { sid: "live-sid", data: "echo hi\r" });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(bus().inputCalls).toEqual([{ sid: "live-sid", data: "echo hi\r" }]);
  });

  it("preserves empty-string data (a valid wire payload — flush-only kbd event)", () => {
    const res = sendInputHandler(REQ, { sid: "live-sid", data: "" });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(bus().inputCalls).toEqual([{ sid: "live-sid", data: "" }]);
  });

  it("ANTI-STUB §3.5.5: handler is NOT a placeholder — it MUST call inputPtySession", () => {
    sendInputHandler(REQ, { sid: "live-sid", data: "a" });
    expect(bus().inputCalls).toHaveLength(1);
  });
});

describe("sendInputHandler — R1 baseline-cite: silent-drop on unknown sid (§3.5.1)", () => {
  it("returns { ok:true } when sid is unknown (preserves v0.2 35b08d15^ envelope)", () => {
    const res = sendInputHandler(REQ, { sid: "ghost", data: "x" });
    expect(res).toEqual({ status: 200, body: { ok: true } });
  });

  it("STILL calls inputPtySession on unknown sid (single grep-able promotion site)", () => {
    sendInputHandler(REQ, { sid: "ghost", data: "x" });
    expect(bus().inputCalls).toEqual([{ sid: "ghost", data: "x" }]);
  });
});

describe("sendInputHandler — internal error surface (§3.5.6 subset)", () => {
  beforeEach(() => {
    bus().liveSids.add("crashy");
    bus().inputThrows = true;
  });

  it("returns { ok:false, error:'internal' } when inputPtySession throws", () => {
    const res = sendInputHandler(REQ, { sid: "crashy", data: "x" });
    expect(res).toEqual({
      status: 200,
      body: { ok: false, error: "internal" },
    });
  });

  it("'internal' is in the pty:input subset (assertEmittable does not throw)", () => {
    // Indirect: the handler returns the response above. If `failResponse`
    // had thrown, we'd never see status:200.
    const res = sendInputHandler(REQ, { sid: "crashy", data: "x" });
    expect(res.status).toBe(200);
  });
});

describe("registerSendInputAt — explicit registrar helper", () => {
  it("registers POST <path> on the supplied router", () => {
    const r = new Router();
    registerSendInputAt(r, "/test/api/pty/input");
    const handler = r.resolve("POST", "/test/api/pty/input");
    expect(handler).toBe(sendInputHandler);
  });

  it("does NOT collide with the production /api/pty/input route (different router instance)", () => {
    // Sanity: a fresh router has zero routes. The production /api/pty/input
    // is owned by daemon/api/pty.ts on the daemon's singleton router.
    const r = new Router();
    expect(r.resolve("POST", "/api/pty/input")).toBeUndefined();
    registerSendInputAt(r, "/api/pty/input");
    expect(r.resolve("POST", "/api/pty/input")).toBe(sendInputHandler);
    // Re-registering same path on same router throws (uniqueness guard).
    expect(() => registerSendInputAt(r, "/api/pty/input")).toThrow(/already registered/);
  });
});
