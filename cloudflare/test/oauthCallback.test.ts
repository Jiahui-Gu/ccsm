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
});
