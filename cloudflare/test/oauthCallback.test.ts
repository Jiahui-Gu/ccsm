import { describe, it, expect, vi, afterEach } from "vitest";
import { handleOauthCallback } from "../src/routes/oauthCallback";
import { verifyJwt } from "../src/lib/jwt";
import { hmacUserHash } from "../src/lib/userHash";
import type { Config } from "../src/lib/config";

const secret = new TextEncoder().encode("signing-key");
const cfg = {
  githubClientId: "cid",
  githubClientSecret: "csecret",
  oauthRedirectUri: "https://x/cb",
  serverSecret: secret,
} as Config;

function mockGithub(id: number): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("access_token")) {
      return new Response(JSON.stringify({ access_token: "tok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ id }), {
      headers: { "Content-Type": "application/json" },
    });
  });
}

afterEach(() => vi.restoreAllMocks());

describe("oauthCallback", () => {
  it("rejects a state mismatch with 400", async () => {
    const req = new Request("https://x/auth/github/callback?code=c&state=A", {
      headers: { Cookie: "oauth_state=B" },
    });
    const res = await handleOauthCallback(req, cfg);
    expect(res.status).toBe(400);
  });

  it("on success emits an html page carrying a one-time auth_code", async () => {
    mockGithub(777);
    const req = new Request("https://x/auth/github/callback?code=c&state=S", {
      headers: { Cookie: "oauth_state=S" },
    });
    const res = await handleOauthCallback(req, cfg);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
    expect(res.headers.get("Set-Cookie")).toContain("oauth_state=; Path=/; Max-Age=0");
    const html = await res.text();
    const m = html.match(/"authCode":"([^"]+)"/);
    expect(m).not.toBeNull();
    const claims = await verifyJwt(secret, m![1]);
    expect(claims?.typ).toBe("auth_code");
    expect(claims?.userHash).toBe(await hmacUserHash(secret, 777));
  });

  it("desktop flow: 302s to the loopback with a one-time auth_code, clearing all 3 cookies", async () => {
    mockGithub(777);
    const req = new Request("https://x/auth/github/callback?code=c&state=S", {
      headers: { Cookie: "oauth_state=S; oauth_flow=desktop; oauth_port=49231" },
    });
    const res = await handleOauthCallback(req, cfg);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin).toBe("http://127.0.0.1:49231");
    const authCode = loc.searchParams.get("authCode")!;
    expect(authCode.length).toBeGreaterThan(0);
    const claims = await verifyJwt(secret, authCode);
    expect(claims?.typ).toBe("auth_code");
    expect(claims?.userHash).toBe(await hmacUserHash(secret, 777));
    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toContain("oauth_state=; Path=/; Max-Age=0");
    expect(cookie).toContain("oauth_flow=; Path=/; Max-Age=0");
    expect(cookie).toContain("oauth_port=; Path=/; Max-Age=0");
  });

  it("desktop flow: rejects a bad port cookie with 400", async () => {
    mockGithub(777);
    const req = new Request("https://x/auth/github/callback?code=c&state=S", {
      headers: { Cookie: "oauth_state=S; oauth_flow=desktop; oauth_port=80" },
    });
    const res = await handleOauthCallback(req, cfg);
    expect(res.status).toBe(400);
  });

  it("phone flow: 302s to /phone with token+doUrl in the fragment, not the query", async () => {
    mockGithub(777);
    const phoneCfg = {
      ...cfg,
      sessionTtlMs: 900_000,
      stunUrls: ["stun:stun.cloudflare.com:3478"],
    } as Config;
    const req = new Request("https://ccsm-worker.jiahuigu.workers.dev/auth/github/callback?code=c&state=S", {
      headers: { Cookie: "oauth_state=S; oauth_flow=phone" },
    });
    const res = await handleOauthCallback(req, phoneCfg);
    expect(res.status).toBe(302);
    const loc = res.headers.get("Location")!;
    expect(loc.startsWith("https://ccsm-worker.jiahuigu.workers.dev/phone#")).toBe(true);
    // token MUST be in the fragment, never the query string
    const [base, frag] = loc.split("#");
    expect(base).not.toContain("token=");
    const f = new URLSearchParams(frag);
    const token = f.get("token")!;
    expect(token.length).toBeGreaterThan(0);
    expect(f.get("doUrl")).toContain("/do/");
    expect(f.get("stun")).toContain("stun:");
    const claims = await verifyJwt(secret, token);
    expect(claims?.typ).toBe("session");
    expect(claims?.userHash).toBe(await hmacUserHash(secret, 777));
  });
});
