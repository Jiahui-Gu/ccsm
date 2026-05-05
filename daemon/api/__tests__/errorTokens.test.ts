/**
 * Unit tests for the closed Error-token enum (`daemon/api/errorTokens.ts`).
 *
 * Spec §3.5.6: enum is closed (adding a token = breaking change). The
 * per-RPC subset table MUST be enforced at the boundary — these tests
 * pin the enum membership AND the subset surface so a casual edit to
 * either drops a CI red.
 */

import { describe, expect, it } from "vitest";

import {
  ERROR_TOKENS,
  RPC_ERROR_SUBSET,
  assertEmittable,
  failResponse,
  isErrorToken,
} from "../errorTokens";

describe("ERROR_TOKENS — closed enum", () => {
  it("contains exactly the six tokens defined in §3.5.6", () => {
    // Sorted-set comparison so the test fails on either addition OR
    // removal of any token (catches both regression directions).
    expect([...ERROR_TOKENS].sort()).toEqual(
      [
        "no_such_sid",
        "pty_dead",
        "bad_request",
        "spawn_failed",
        "daemon_unavailable",
        "internal",
      ].sort(),
    );
  });

  it("isErrorToken accepts every member and rejects non-members", () => {
    for (const t of ERROR_TOKENS) expect(isErrorToken(t)).toBe(true);
    expect(isErrorToken("not_a_token")).toBe(false);
    expect(isErrorToken("")).toBe(false);
    expect(isErrorToken(undefined)).toBe(false);
    expect(isErrorToken(42)).toBe(false);
  });
});

describe("RPC_ERROR_SUBSET — per-RPC enforcement (§3.5.6 second table)", () => {
  it("pins pty:spawn subset to {bad_request, spawn_failed, internal}", () => {
    expect([...RPC_ERROR_SUBSET["pty:spawn"]].sort()).toEqual(
      ["bad_request", "spawn_failed", "internal"].sort(),
    );
  });

  it("pins pty:input subset to {no_such_sid, pty_dead, bad_request, internal}", () => {
    expect([...RPC_ERROR_SUBSET["pty:input"]].sort()).toEqual(
      ["bad_request", "internal", "no_such_sid", "pty_dead"].sort(),
    );
  });

  it("pins pty:resize subset to {no_such_sid, pty_dead, bad_request, internal}", () => {
    expect([...RPC_ERROR_SUBSET["pty:resize"]].sort()).toEqual(
      ["bad_request", "internal", "no_such_sid", "pty_dead"].sort(),
    );
  });

  it("pins pty:attach subset to {no_such_sid, internal}", () => {
    expect([...RPC_ERROR_SUBSET["pty:attach"]].sort()).toEqual(
      ["internal", "no_such_sid"].sort(),
    );
  });

  it("pty:checkClaudeAvailable subset is empty (failures encoded as available:false)", () => {
    expect(RPC_ERROR_SUBSET["pty:checkClaudeAvailable"]).toEqual([]);
  });

  it("daemon_unavailable is NEVER in any daemon RPC subset (renderer-only token)", () => {
    for (const rpc of Object.keys(RPC_ERROR_SUBSET) as Array<keyof typeof RPC_ERROR_SUBSET>) {
      expect(RPC_ERROR_SUBSET[rpc]).not.toContain("daemon_unavailable");
    }
  });
});

describe("assertEmittable", () => {
  it("does not throw when token is in the RPC subset", () => {
    expect(() => assertEmittable("pty:input", "no_such_sid")).not.toThrow();
    expect(() => assertEmittable("pty:resize", "internal")).not.toThrow();
    expect(() => assertEmittable("pty:spawn", "spawn_failed")).not.toThrow();
  });

  it("throws when token is outside the RPC subset", () => {
    // pty:input may NOT emit spawn_failed
    expect(() => assertEmittable("pty:input", "spawn_failed")).toThrow(
      /pty:input.*may not emit 'spawn_failed'/,
    );
    // pty:attach may NOT emit pty_dead
    expect(() => assertEmittable("pty:attach", "pty_dead")).toThrow();
    // pty:checkClaudeAvailable may NEVER emit anything
    expect(() => assertEmittable("pty:checkClaudeAvailable", "internal")).toThrow();
  });

  it("throws when daemon RPC tries to emit daemon_unavailable (renderer-only)", () => {
    expect(() => assertEmittable("pty:input", "daemon_unavailable")).toThrow();
    expect(() => assertEmittable("pty:resize", "daemon_unavailable")).toThrow();
    expect(() => assertEmittable("pty:spawn", "daemon_unavailable")).toThrow();
  });
});

describe("failResponse — typed builder", () => {
  it("returns the canonical { ok:false, error } shape", () => {
    expect(failResponse("pty:input", "no_such_sid")).toEqual({
      ok: false,
      error: "no_such_sid",
    });
  });

  it("propagates assertEmittable failure (forbidden token throws synchronously)", () => {
    expect(() => failResponse("pty:input", "spawn_failed")).toThrow();
  });
});
