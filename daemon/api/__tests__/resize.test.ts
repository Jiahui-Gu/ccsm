/**
 * Unit tests for `daemon/api/resize.ts` (`pty:resize` RPC).
 *
 * Spec coverage (§3.5.2, §3.5.6):
 *   - happy path: live sid + valid geometry → drives resizePtySession,
 *     returns { ok:true }
 *   - schema rejection: missing/non-finite/non-integer cols|rows → 400
 *   - R1 baseline-cite: cols<2/rows<2 → 200 ok:true (lifecycle clamps),
 *     unknown sid → 200 ok:true (silent-drop)
 *   - resilience: resizePtySession throwing → 200 ok:false, error:internal
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";

interface ResizeBus {
  calls: Array<{ sid: string; cols: number; rows: number }>;
  shouldThrow: boolean;
}

function bus(): ResizeBus {
  return (globalThis as any).__resizeBus as ResizeBus;
}

vi.mock("../../ptyHost", () => ({
  resizePtySession: (sid: string, cols: number, rows: number) => {
    bus().calls.push({ sid, cols, rows });
    if (bus().shouldThrow) throw new Error("simulated pty.resize EBADF");
  },
}));

import { resizeHandler, registerResizeAt } from "../resize";
import { Router } from "../../router";

const REQ = {} as IncomingMessage;

beforeEach(() => {
  (globalThis as any).__resizeBus = {
    calls: [],
    shouldThrow: false,
  } satisfies ResizeBus;
});

afterEach(() => {
  delete (globalThis as any).__resizeBus;
  vi.restoreAllMocks();
});

describe("resizeHandler — schema validation (400 bad_request)", () => {
  it("rejects non-object body", () => {
    expect(resizeHandler(REQ, null)).toEqual({
      status: 400,
      error: "bad_request: body",
    });
  });

  it("rejects missing/empty sid", () => {
    expect(resizeHandler(REQ, { cols: 80, rows: 24 })).toEqual({
      status: 400,
      error: "bad_request: sid",
    });
    expect(resizeHandler(REQ, { sid: "", cols: 80, rows: 24 })).toEqual({
      status: 400,
      error: "bad_request: sid",
    });
  });

  it("rejects missing / non-number / non-finite cols", () => {
    expect(resizeHandler(REQ, { sid: "s", rows: 24 })).toEqual({
      status: 400,
      error: "bad_request: cols",
    });
    expect(resizeHandler(REQ, { sid: "s", cols: "80", rows: 24 })).toEqual({
      status: 400,
      error: "bad_request: cols",
    });
    expect(resizeHandler(REQ, { sid: "s", cols: Number.NaN, rows: 24 })).toEqual({
      status: 400,
      error: "bad_request: cols",
    });
    expect(resizeHandler(REQ, { sid: "s", cols: Number.POSITIVE_INFINITY, rows: 24 })).toEqual({
      status: 400,
      error: "bad_request: cols",
    });
  });

  it("rejects non-integer cols/rows (geometry must be integral cells)", () => {
    expect(resizeHandler(REQ, { sid: "s", cols: 80.5, rows: 24 })).toEqual({
      status: 400,
      error: "bad_request: cols",
    });
    expect(resizeHandler(REQ, { sid: "s", cols: 80, rows: 24.1 })).toEqual({
      status: 400,
      error: "bad_request: rows",
    });
  });

  it("rejects missing / non-number / non-finite rows", () => {
    expect(resizeHandler(REQ, { sid: "s", cols: 80 })).toEqual({
      status: 400,
      error: "bad_request: rows",
    });
    expect(resizeHandler(REQ, { sid: "s", cols: 80, rows: "24" })).toEqual({
      status: 400,
      error: "bad_request: rows",
    });
  });

  it("does NOT call resizePtySession on schema rejection", () => {
    resizeHandler(REQ, { sid: "s", cols: "80", rows: 24 });
    expect(bus().calls).toEqual([]);
  });
});

describe("resizeHandler — happy path", () => {
  it("returns { ok:true } and drives resizePtySession(sid, cols, rows) verbatim", () => {
    const res = resizeHandler(REQ, { sid: "live", cols: 120, rows: 40 });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(bus().calls).toEqual([{ sid: "live", cols: 120, rows: 40 }]);
  });

  it("ANTI-STUB §3.5.5: handler MUST call resizePtySession (not stub)", () => {
    resizeHandler(REQ, { sid: "s", cols: 80, rows: 24 });
    expect(bus().calls).toHaveLength(1);
  });
});

describe("resizeHandler — R1 baseline-cite (§3.5.2): v0.2 envelope preservation", () => {
  it("cols<2 / rows<2 → 200 ok:true (lifecycle clamps; v0.2 did not 400)", () => {
    expect(resizeHandler(REQ, { sid: "s", cols: 1, rows: 24 })).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(resizeHandler(REQ, { sid: "s", cols: 80, rows: 0 })).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(resizeHandler(REQ, { sid: "s", cols: -5, rows: -5 })).toEqual({
      status: 200,
      body: { ok: true },
    });
  });

  it("STILL forwards sub-minimum geometry to lifecycle (lifecycle owns the clamp)", () => {
    resizeHandler(REQ, { sid: "s", cols: 1, rows: 1 });
    expect(bus().calls).toEqual([{ sid: "s", cols: 1, rows: 1 }]);
  });

  it("unknown sid → 200 ok:true (lifecycle silent-drops; v0.2 envelope)", () => {
    // The mock doesn't model 'live vs unknown' — it just records calls.
    // The point of this test is the WIRE shape; the lifecycle layer's
    // own __tests__/lifecycle.test.ts covers the silent-drop behavior.
    const res = resizeHandler(REQ, { sid: "ghost", cols: 80, rows: 24 });
    expect(res).toEqual({ status: 200, body: { ok: true } });
  });
});

describe("resizeHandler — internal error surface (§3.5.6 subset)", () => {
  beforeEach(() => {
    bus().shouldThrow = true;
  });

  it("returns { ok:false, error:'internal' } when resizePtySession throws", () => {
    const res = resizeHandler(REQ, { sid: "s", cols: 80, rows: 24 });
    expect(res).toEqual({
      status: 200,
      body: { ok: false, error: "internal" },
    });
  });
});

describe("registerResizeAt", () => {
  it("registers POST <path> on the supplied router", () => {
    const r = new Router();
    registerResizeAt(r, "/test/api/pty/resize");
    expect(r.resolve("POST", "/test/api/pty/resize")).toBe(resizeHandler);
  });
});
