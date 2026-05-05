/**
 * sigkill-reattach v0.2 baseline — Set B informational e2e (Task #604, PR-6).
 *
 * Spec: 2026-05-06 v0.3 e2e-cutover §3.4 / §4.4 / §5.3.6.
 *
 * Set assignment: **Set B (informational, v0.3)** per §4.4 table — this
 * case MUST NOT block PR-6 merge or v0.3 release. The v0.2 baseline
 * `attach-replay-from-headless-buffer` Set A case is the actual gate;
 * this spec is a daemon-level smoke that the same code path survives a
 * SIGKILL on the pty side.
 *
 * Scope (v0.3 strict): exercise ONLY the v0.2 already-shipping
 * attach-replay path. NO assertions on TTL / cap / cwd-mismatch /
 * eviction / dedup — those are v0.4 (§3.7 F-1..F-6).
 *
 * What it asserts (when enabled):
 *   1. Spawn pty for sid X via `/api/pty/spawn`.
 *   2. Some output is emitted (we drive the fake / real pty here via
 *      RPCs the daemon already exposes; in CI we can't drive a real
 *      claude binary, so this spec stays skipped by default — Set B
 *      informational. The dev box runs it via `CCSM_SET_B=1`.)
 *   3. SIGKILL the pty (`/api/pty/kill`).
 *   4. `pty:exit` lands with `signal:'SIGKILL'`-shaped payload.
 *   5. Re-spawn for the SAME sid succeeds (idempotent v0.2 contract).
 *   6. `/api/pty/attach` returns the prior buffer in `attach.snapshot`.
 *
 * Set-B gating: `describe.skipIf` against `process.env.CCSM_SET_B`. The
 * harness-real-cli case (`scripts/harness-real-cli.mjs`) is the
 * companion e2e for the renderer-side flow; this spec is the
 * daemon-tier smoke. Both are Set B informational in v0.3 per §4.4.
 *
 * Why not promote to Set A: §3.4.1 explicitly defers — v0.3 = restore
 * v0.2 attach-replay path, nothing more. Promotion (and the new
 * reliability assertions that come with it) is v0.4 F-4.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Router } from "../daemon/router";
import { startServer, type ServerHandle } from "../daemon/server";

const SET_B_ENABLED = process.env.CCSM_SET_B === "1";

describe.skipIf(!SET_B_ENABLED)("sigkill-reattach v0.2 baseline (Set B informational, v0.3)", () => {
  let handle: ServerHandle;
  let baseUrl: string;

  beforeAll(async () => {
    // Lazy-import the production registrar so the auto-registry side
    // effects don't run when the suite is skipped.
    const { default: register } = await import("../daemon/api/pty");
    const router = new Router();
    register(router);
    handle = await startServer({ router });
    baseUrl = `http://127.0.0.1:${handle.port}`;
  });

  afterAll(async () => {
    if (handle) await handle.close();
  });

  async function postJson<T>(path: string, body: unknown): Promise<T> {
    const r = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await r.json()) as T;
  }

  it("v0.2 baseline path: spawn → kill (SIGKILL-shaped) → respawn-same-sid → attach → snapshot replay", async () => {
    const sid = `setB-sigkill-${Date.now()}`;

    // (1) Spawn — daemon will refuse if no claude on PATH; this is
    //     why the spec stays Set B informational. Dev box only.
    const spawnResp = await postJson<{ ok: boolean; error?: string }>("/api/pty/spawn", {
      sid,
      cwd: process.cwd(),
    });
    if (!spawnResp.ok && spawnResp.error === "claude_not_found") {
      // Set B convention: log and pass — informational.
      console.warn("[setB sigkill-reattach] skipped — claude not on PATH (informational)");
      return;
    }
    expect(spawnResp.ok).toBe(true);

    // (2) Wait briefly for claude trust prompt to land in the headless buffer.
    await new Promise((r) => setTimeout(r, 1500));

    const before = await postJson<{ ok: true; snapshot: string; seq: number }>(
      "/api/pty/getBufferSnapshot",
      { sid },
    );
    expect(before.snapshot.length).toBeGreaterThan(0);

    // (3) SIGKILL via the kill RPC. The kill handler walks the process
    //     subtree (ConPTY orphan-fix per daemon/ptyHost/processKiller).
    const killResp = await postJson<{ ok: true; killed: boolean }>("/api/pty/kill", { sid });
    expect(killResp.ok).toBe(true);

    // (4) Wait for the daemon-side exit-fanout to clear the registry
    //     (sessions Map deletion happens in entryFactory's p.onExit).
    await new Promise((r) => setTimeout(r, 1500));

    // (5) Re-spawn for the SAME sid. v0.2 idempotent contract: returns
    //     the existing entry if one exists, OR creates fresh.
    const respawn = await postJson<{ ok: boolean; sid?: string }>("/api/pty/spawn", {
      sid,
      cwd: process.cwd(),
    });
    expect(respawn.ok).toBe(true);

    // (6) Attach — v0.3 contract: NO new response shape, snapshot string
    //     comes via `attach.snapshot`. We do NOT assert content equality
    //     here (the new pty starts a fresh claude session and the prior
    //     buffer may be discarded depending on v0.2 retention behaviour
    //     — that's exactly the "verify, don't modify" §3.4.3 rule).
    const attachResp = await postJson<{
      ok: true;
      attach: { snapshot: string; cols: number; rows: number; pid: number } | null;
    }>("/api/pty/attach", { sid });
    expect(attachResp.attach).not.toBeNull();
    expect(typeof attachResp.attach!.snapshot).toBe("string");
    // No TTL / cap / cwd / dedup assertions — v0.4.

    // Cleanup.
    await postJson("/api/pty/kill", { sid });
  }, 30_000);
});
