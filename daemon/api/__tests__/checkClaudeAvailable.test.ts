/**
 * Unit tests for `daemon/api/checkClaudeAvailable.ts`.
 *
 * Spec coverage (§3.5.3, §3.5.6):
 *   - resolver returns absolute path → { available: true, path }
 *   - resolver returns null → { available: false, reason: 'claude_not_on_path' }
 *   - resolver throws → caught, { available: false, reason: <message> }
 *   - `force: true` is forwarded to resolveClaude (cache bypass)
 *   - NEVER returns { ok: false } shape — §3.5.6 subset is empty
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";

interface ResolverBus {
  callOpts: Array<{ force: boolean }>;
  result: string | null;
  shouldThrow: Error | null;
}

function bus(): ResolverBus {
  return (globalThis as any).__cclBus as ResolverBus;
}

vi.mock("../../ptyHost/claudeResolver", () => ({
  resolveClaude: ({ force = false }: { force?: boolean } = {}) => {
    const b = bus();
    b.callOpts.push({ force });
    if (b.shouldThrow) throw b.shouldThrow;
    return b.result;
  },
}));

import {
  checkClaudeAvailableHandler,
  registerCheckClaudeAvailableAt,
} from "../checkClaudeAvailable";
import { Router } from "../../router";

const REQ = {} as IncomingMessage;

beforeEach(() => {
  (globalThis as any).__cclBus = {
    callOpts: [],
    result: null,
    shouldThrow: null,
  } satisfies ResolverBus;
});

afterEach(() => {
  delete (globalThis as any).__cclBus;
  vi.restoreAllMocks();
});

describe("checkClaudeAvailableHandler — happy path (resolver returns path)", () => {
  beforeEach(() => {
    bus().result = "/usr/local/bin/claude";
  });

  it("returns { available: true, path } when claude is on PATH", () => {
    const res = checkClaudeAvailableHandler(REQ, {});
    expect(res).toEqual({
      status: 200,
      body: { available: true, path: "/usr/local/bin/claude" },
    });
  });

  it("ANTI-STUB §3.5.5: handler MUST call resolveClaude — not return hard-coded true", () => {
    checkClaudeAvailableHandler(REQ, {});
    expect(bus().callOpts).toHaveLength(1);
  });

  it("default force=false (cached resolver path)", () => {
    checkClaudeAvailableHandler(REQ, {});
    expect(bus().callOpts).toEqual([{ force: false }]);
  });

  it("forwards force:true to resolveClaude (cache bypass — Re-check button)", () => {
    checkClaudeAvailableHandler(REQ, { force: true });
    expect(bus().callOpts).toEqual([{ force: true }]);
  });

  it("ignores extra unknown body keys (forward-compat)", () => {
    const res = checkClaudeAvailableHandler(REQ, { force: true, unknownKey: 42 });
    expect(res.status).toBe(200);
    expect(bus().callOpts).toEqual([{ force: true }]);
  });

  it("treats body=null / body=undefined as no-args (force defaults false)", () => {
    expect(checkClaudeAvailableHandler(REQ, null).status).toBe(200);
    expect(checkClaudeAvailableHandler(REQ, undefined).status).toBe(200);
    expect(bus().callOpts).toEqual([{ force: false }, { force: false }]);
  });
});

describe("checkClaudeAvailableHandler — claude missing (resolver returns null)", () => {
  it("returns { available: false, reason: 'claude_not_on_path' }", () => {
    bus().result = null;
    const res = checkClaudeAvailableHandler(REQ, {});
    expect(res).toEqual({
      status: 200,
      body: { available: false, reason: "claude_not_on_path" },
    });
  });
});

describe("checkClaudeAvailableHandler — never throws (§3.5.3 MUST)", () => {
  it("catches resolver throws → { available: false, reason: <msg> }", () => {
    bus().shouldThrow = new Error("EACCES");
    const res = checkClaudeAvailableHandler(REQ, { force: true });
    expect(res.status).toBe(200);
    expect(res).toEqual({
      status: 200,
      body: { available: false, reason: "EACCES" },
    });
  });

  it("non-Error thrown values are stringified into reason", () => {
    bus().shouldThrow = "weird-string-thrown" as unknown as Error;
    const res = checkClaudeAvailableHandler(REQ, {});
    expect(res.status).toBe(200);
    if (res.status === 200) {
      const body = res.body as { available: false; reason: string };
      expect(body.available).toBe(false);
      expect(body.reason).toBe("weird-string-thrown");
    }
  });
});

describe("checkClaudeAvailableHandler — wire-shape contract (§3.5.6)", () => {
  it("NEVER returns { ok: false } shape — the §3.5.6 subset is empty for this RPC", () => {
    // Sweep three branches: present, absent, throwing.
    const cases: Array<() => void> = [
      () => { bus().result = "/x"; },
      () => { bus().result = null; },
      () => { bus().shouldThrow = new Error("x"); },
    ];
    for (const setup of cases) {
      setup();
      const res = checkClaudeAvailableHandler(REQ, {});
      if (res.status !== 200) throw new Error("expected 200");
      const body = res.body as Record<string, unknown>;
      expect(body).not.toHaveProperty("ok");
      expect(body).not.toHaveProperty("error");
      expect(body).toHaveProperty("available");
    }
  });
});

describe("registerCheckClaudeAvailableAt", () => {
  it("registers POST <path> on the supplied router", () => {
    const r = new Router();
    registerCheckClaudeAvailableAt(r, "/test/api/pty/checkClaudeAvailable");
    expect(r.resolve("POST", "/test/api/pty/checkClaudeAvailable")).toBe(
      checkClaudeAvailableHandler,
    );
  });
});
