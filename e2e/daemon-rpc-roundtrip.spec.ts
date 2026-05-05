/**
 * Connect-roundtrip e2e spec for the three v0.3 RPCs (PR-5 / HP-9).
 *
 * Spec: 2026-05-06 v0.3 e2e-cutover §3.5 + §3.5.4. Each of `SendInput`,
 * `Resize`, `CheckClaudeAvailable` MUST have a dedicated roundtrip
 * (indirect coverage was the §1.1 S1 failure mode in wave-2-A).
 *
 * What this spec exercises:
 *   - boots a real `daemon/server.ts` HTTP server on 127.0.0.1:0 (random
 *     port) with a Router pre-mounted with the three NEW handler modules
 *     under disjoint test-local paths
 *     (`/test/api/pty/{input,resize,checkClaudeAvailable}`)
 *   - issues real `fetch()` POSTs and asserts the wire-shape contract
 *     end-to-end: serialization → http parse → router dispatch → handler →
 *     JSON envelope → renderer-side parse
 *
 * Why disjoint paths (not `/api/pty/input` etc.):
 *   the production routes at `/api/pty/*` are owned by `daemon/api/pty.ts`
 *   on the daemon's singleton router. This spec spins a FRESH `Router`
 *   per test — there is no collision because we never load the
 *   auto-registry. The disjoint prefix makes it explicit that these new
 *   handler modules can be wired anywhere by an explicit registrar
 *   (`registerSendInputAt`, `registerResizeAt`,
 *   `registerCheckClaudeAvailableAt`); a future PR that pulls pty.ts
 *   apart can swap the inline handlers for these modules.
 *
 * Why this is the "Connect-roundtrip" surface:
 *   the project does not bundle a Connect-RPC framework — its loopback
 *   substrate is plain HTTP+JSON (see daemon/server.ts header). "Connect-
 *   roundtrip" in this codebase = real socket + real JSON envelope, which
 *   is exactly what `fetch` against `127.0.0.1:<port>` provides here.
 *   The Set A harness cases in §3.5.4 (`pty-input-roundtrip` etc.) are
 *   the *renderer-tier* roundtrips and live in `scripts/harness-*.mjs`;
 *   PR-5 acceptance covers the daemon-tier roundtrip in this spec.
 *
 * Mocking strategy:
 *   - `daemon/ptyHost` (the lifecycle barrel) is mocked so we never
 *     spawn node-pty in CI. We assert ON the mock that the handler
 *     drove the underlying op — anti-stub §3.5.5.
 *   - `daemon/ptyHost/claudeResolver` is mocked likewise so the test
 *     is hermetic regardless of whether `claude` is on PATH.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ---- Mock buses (mirror per-handler unit-test pattern) ---------------------

interface RpcBuses {
  inputCalls: Array<{ sid: string; data: string }>;
  resizeCalls: Array<{ sid: string; cols: number; rows: number }>;
  resolverCalls: Array<{ force: boolean }>;
  liveSids: Set<string>;
  resolverResult: string | null;
  resolverThrows: Error | null;
  inputThrows: boolean;
  resizeThrows: boolean;
}

function buses(): RpcBuses {
  return (globalThis as any).__rpcRoundtripBuses as RpcBuses;
}

vi.mock("../daemon/ptyHost", () => ({
  getPtySession: (sid: string) =>
    buses().liveSids.has(sid) ? { sid, pid: 1, cols: 80, rows: 24, cwd: "/" } : null,
  inputPtySession: (sid: string, data: string) => {
    buses().inputCalls.push({ sid, data });
    if (buses().inputThrows) throw new Error("simulated pty.write failure");
  },
  resizePtySession: (sid: string, cols: number, rows: number) => {
    buses().resizeCalls.push({ sid, cols, rows });
    if (buses().resizeThrows) throw new Error("simulated pty.resize failure");
  },
}));

vi.mock("../daemon/ptyHost/claudeResolver", () => ({
  resolveClaude: ({ force = false }: { force?: boolean } = {}) => {
    const b = buses();
    b.resolverCalls.push({ force });
    if (b.resolverThrows) throw b.resolverThrows;
    return b.resolverResult;
  },
}));

// Imports AFTER vi.mock so the handlers pick up the mocked barrels.
import { Router } from "../daemon/router";
import { startServer, type ServerHandle } from "../daemon/server";
import { registerSendInputAt } from "../daemon/api/sendInput";
import { registerResizeAt } from "../daemon/api/resize";
import { registerCheckClaudeAvailableAt } from "../daemon/api/checkClaudeAvailable";

// ---- Test fixture: real http.Server on 127.0.0.1:0 -------------------------

const PATH_INPUT = "/test/api/pty/input";
const PATH_RESIZE = "/test/api/pty/resize";
const PATH_CHECK = "/test/api/pty/checkClaudeAvailable";

let handle: ServerHandle;
let baseUrl: string;

beforeAll(async () => {
  const router = new Router();
  registerSendInputAt(router, PATH_INPUT);
  registerResizeAt(router, PATH_RESIZE);
  registerCheckClaudeAvailableAt(router, PATH_CHECK);
  handle = await startServer({ router });
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => {
  await handle.close();
});

beforeEach(() => {
  (globalThis as any).__rpcRoundtripBuses = {
    inputCalls: [],
    resizeCalls: [],
    resolverCalls: [],
    liveSids: new Set<string>(),
    resolverResult: null,
    resolverThrows: null,
    inputThrows: false,
    resizeThrows: false,
  } satisfies RpcBuses;
});

afterEach(() => {
  delete (globalThis as any).__rpcRoundtripBuses;
});

// ---- Helper ----------------------------------------------------------------

async function postJson(
  path: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(baseUrl + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // Force JSON — server.ts always sets Content-Type: application/json.
  const text = await res.text();
  let json: unknown;
  try {
    json = text.length === 0 ? null : JSON.parse(text);
  } catch {
    json = { __raw: text };
  }
  return { status: res.status, json };
}

// ---- pty:input roundtrip ---------------------------------------------------

describe("Connect-roundtrip: pty:input (SendInput) — §3.5.1", () => {
  it("happy path: 200 { ok:true } end-to-end and pty.write was driven", async () => {
    buses().liveSids.add("rt-input-1");
    const { status, json } = await postJson(PATH_INPUT, {
      sid: "rt-input-1",
      data: "echo hi\r",
    });
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true });
    expect(buses().inputCalls).toEqual([{ sid: "rt-input-1", data: "echo hi\r" }]);
  });

  it("schema rejection: missing sid → 400 bad_request: sid", async () => {
    const { status, json } = await postJson(PATH_INPUT, { data: "x" });
    expect(status).toBe(400);
    expect(json).toEqual({ error: "bad_request: sid" });
    expect(buses().inputCalls).toEqual([]);
  });

  it("R1 baseline: unknown sid → 200 { ok:true } (silent-drop preserved)", async () => {
    const { status, json } = await postJson(PATH_INPUT, {
      sid: "ghost",
      data: "x",
    });
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true });
    // STILL forwarded to lifecycle (single grep-able promotion site).
    expect(buses().inputCalls).toEqual([{ sid: "ghost", data: "x" }]);
  });

  it("internal error: pty.write throws → 200 { ok:false, error:'internal' }", async () => {
    buses().liveSids.add("crash");
    buses().inputThrows = true;
    const { status, json } = await postJson(PATH_INPUT, {
      sid: "crash",
      data: "x",
    });
    expect(status).toBe(200);
    expect(json).toEqual({ ok: false, error: "internal" });
  });
});

// ---- pty:resize roundtrip --------------------------------------------------

describe("Connect-roundtrip: pty:resize (Resize) — §3.5.2", () => {
  it("happy path: 200 { ok:true } end-to-end and pty.resize was driven verbatim", async () => {
    const { status, json } = await postJson(PATH_RESIZE, {
      sid: "rt-resize-1",
      cols: 120,
      rows: 40,
    });
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true });
    expect(buses().resizeCalls).toEqual([
      { sid: "rt-resize-1", cols: 120, rows: 40 },
    ]);
  });

  it("schema rejection: non-integer cols → 400 bad_request: cols", async () => {
    const { status, json } = await postJson(PATH_RESIZE, {
      sid: "s",
      cols: 80.5,
      rows: 24,
    });
    expect(status).toBe(400);
    expect(json).toEqual({ error: "bad_request: cols" });
  });

  it("R1 baseline: cols<2 → 200 { ok:true } (lifecycle clamps; v0.2 envelope)", async () => {
    const { status, json } = await postJson(PATH_RESIZE, {
      sid: "s",
      cols: 1,
      rows: 24,
    });
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true });
    // STILL forwarded — lifecycle owns the clamp decision.
    expect(buses().resizeCalls).toEqual([{ sid: "s", cols: 1, rows: 24 }]);
  });

  it("internal error: pty.resize throws → 200 { ok:false, error:'internal' }", async () => {
    buses().resizeThrows = true;
    const { status, json } = await postJson(PATH_RESIZE, {
      sid: "s",
      cols: 80,
      rows: 24,
    });
    expect(status).toBe(200);
    expect(json).toEqual({ ok: false, error: "internal" });
  });
});

// ---- pty:checkClaudeAvailable roundtrip ------------------------------------

describe("Connect-roundtrip: pty:checkClaudeAvailable — §3.5.3", () => {
  it("happy path: resolver returns path → { available:true, path }", async () => {
    buses().resolverResult = "/usr/local/bin/claude";
    const { status, json } = await postJson(PATH_CHECK, {});
    expect(status).toBe(200);
    expect(json).toEqual({ available: true, path: "/usr/local/bin/claude" });
    // ANTI-STUB: must have actually called the resolver.
    expect(buses().resolverCalls).toEqual([{ force: false }]);
  });

  it("force:true is forwarded to the resolver (cache bypass)", async () => {
    buses().resolverResult = "/x";
    await postJson(PATH_CHECK, { force: true });
    expect(buses().resolverCalls).toEqual([{ force: true }]);
  });

  it("resolver returns null → { available:false, reason:'claude_not_on_path' }", async () => {
    buses().resolverResult = null;
    const { status, json } = await postJson(PATH_CHECK, {});
    expect(status).toBe(200);
    expect(json).toEqual({ available: false, reason: "claude_not_on_path" });
  });

  it("§3.5.3 MUST never throw: resolver throw → caught into available:false reason", async () => {
    buses().resolverThrows = new Error("EACCES");
    const { status, json } = await postJson(PATH_CHECK, { force: true });
    expect(status).toBe(200);
    expect(json).toEqual({ available: false, reason: "EACCES" });
  });

  it("§3.5.6 wire-shape: response NEVER carries { ok:false } shape", async () => {
    // Sweep the three branches end-to-end.
    buses().resolverResult = "/x";
    let r = await postJson(PATH_CHECK, {});
    expect(r.json).not.toHaveProperty("ok");
    expect(r.json).not.toHaveProperty("error");

    buses().resolverResult = null;
    r = await postJson(PATH_CHECK, {});
    expect(r.json).not.toHaveProperty("ok");
    expect(r.json).not.toHaveProperty("error");

    buses().resolverThrows = new Error("x");
    r = await postJson(PATH_CHECK, {});
    expect(r.json).not.toHaveProperty("ok");
    expect(r.json).not.toHaveProperty("error");
  });
});
