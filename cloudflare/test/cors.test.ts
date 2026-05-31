import { describe, it, expect } from "vitest";
import { corsPreflight, withSecurityHeaders, json, readCookie } from "../src/lib/cors";

const ALLOWED = "https://ccsm-worker.jiahuigu.workers.dev";
const allowlist = [ALLOWED];

describe("cors", () => {
  it("preflight echoes an allowed origin", () => {
    const res = corsPreflight(new Request("https://x", { headers: { Origin: ALLOWED } }), allowlist);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
  });

  it("preflight blanks a disallowed origin", () => {
    const res = corsPreflight(new Request("https://x", { headers: { Origin: "https://evil" } }), allowlist);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("");
  });

  it("preflight allows a configured custom origin", () => {
    const res = corsPreflight(
      new Request("https://x", { headers: { Origin: "https://ccsm.example.com" } }),
      ["https://ccsm.example.com"],
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://ccsm.example.com");
  });

  it("withSecurityHeaders sets nosniff + referrer-policy", () => {
    const res = withSecurityHeaders(new Response("hi"), new Request("https://x"), allowlist);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("json serialises body + status + content-type", async () => {
    const res = json({ a: 1 }, 201);
    expect(res.status).toBe(201);
    expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ a: 1 });
  });

  it("readCookie extracts a named cookie", () => {
    const req = new Request("https://x", { headers: { Cookie: "a=1; oauth_state=xyz; b=2" } });
    expect(readCookie(req, "oauth_state")).toBe("xyz");
    expect(readCookie(req, "missing")).toBeNull();
  });
});
