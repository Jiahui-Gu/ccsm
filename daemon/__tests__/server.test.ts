/**
 * Loopback bind invariant tests for daemon HTTP server.
 *
 * Spec: docs/superpowers/specs/2026-05-06-v0.3-e2e-cutover-design.md §3
 * Task: #600 (T-G1)
 *
 * The daemon has no auth layer; loopback is the trust boundary. These tests
 * lock in the SECURITY INVARIANT documented in daemon/server.ts:
 *  - happy path: default bind succeeds and reports a loopback address.
 *  - explicit `127.0.0.1` / `::1` are accepted.
 *  - any non-loopback host string (`0.0.0.0`, public IP, hostname literal,
 *    even `localhost`) is rejected before listen.
 */

import { describe, it, expect, afterEach } from "vitest";
import { isIP } from "node:net";

import {
  startServer,
  assertLoopbackHost,
  type ServerHandle,
} from "../server";
import { Router } from "../router";

const handles: ServerHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop()!;
    try {
      await h.close();
    } catch {
      /* socket already gone */
    }
  }
});

function newRouter(): Router {
  const r = new Router();
  r.addRoute("GET", "/ping", async () => ({ status: 200, body: { ok: true } }));
  return r;
}

async function start(opts: { host?: string; port?: number } = {}): Promise<ServerHandle> {
  const h = await startServer({ router: newRouter(), ...opts });
  handles.push(h);
  return h;
}

describe("daemon/server loopback invariant", () => {
  describe("assertLoopbackHost", () => {
    it("accepts 127.0.0.1", () => {
      expect(() => assertLoopbackHost("127.0.0.1")).not.toThrow();
    });

    it("accepts ::1", () => {
      expect(() => assertLoopbackHost("::1")).not.toThrow();
    });

    it("rejects 0.0.0.0 (wildcard)", () => {
      expect(() => assertLoopbackHost("0.0.0.0")).toThrow(/non-loopback/);
    });

    it("rejects empty string (Node treats as wildcard)", () => {
      expect(() => assertLoopbackHost("")).toThrow(/non-loopback/);
    });

    it("rejects public IPv4 literal", () => {
      expect(() => assertLoopbackHost("8.8.8.8")).toThrow(/non-loopback/);
    });

    it("rejects RFC1918 private IPv4 (still routable on LAN)", () => {
      expect(() => assertLoopbackHost("192.168.1.10")).toThrow(/non-loopback/);
      expect(() => assertLoopbackHost("10.0.0.1")).toThrow(/non-loopback/);
    });

    it("rejects IPv6 wildcard ::", () => {
      expect(() => assertLoopbackHost("::")).toThrow(/non-loopback/);
    });

    it("rejects 'localhost' hostname (DNS may resolve off-loopback)", () => {
      // Intentional: spec narrows to literal IPs only. See LOOPBACK_HOSTS
      // comment in daemon/server.ts.
      expect(() => assertLoopbackHost("localhost")).toThrow(/non-loopback/);
    });

    it("rejects hostname literals", () => {
      expect(() => assertLoopbackHost("daemon.example.com")).toThrow(
        /non-loopback/,
      );
    });

    it("error message names the offending host", () => {
      expect(() => assertLoopbackHost("0.0.0.0")).toThrow(/"0\.0\.0\.0"/);
    });
  });

  describe("startServer", () => {
    it("happy path: default bind succeeds on a loopback address", async () => {
      const h = await start();
      expect(h.port).toBeGreaterThan(0);
      const addr = (h.server.address() as { address: string; port: number }).address;
      // Whatever Node reported, it must be a loopback literal.
      expect(isIP(addr)).toBeGreaterThan(0);
      expect(
        addr.startsWith("127.") || addr === "::1" || addr.startsWith("::ffff:127."),
      ).toBe(true);
    });

    it("explicit 127.0.0.1 works", async () => {
      const h = await start({ host: "127.0.0.1" });
      const addr = (h.server.address() as { address: string }).address;
      expect(addr.startsWith("127.") || addr.startsWith("::ffff:127.")).toBe(true);
    });

    it("rejects 0.0.0.0 before opening any socket", async () => {
      await expect(start({ host: "0.0.0.0" })).rejects.toThrow(/non-loopback/);
    });

    it("rejects public IP", async () => {
      await expect(start({ host: "8.8.8.8" })).rejects.toThrow(/non-loopback/);
    });

    it("rejects 'localhost' (string-level guard, not DNS-dependent)", async () => {
      await expect(start({ host: "localhost" })).rejects.toThrow(/non-loopback/);
    });
  });
});
