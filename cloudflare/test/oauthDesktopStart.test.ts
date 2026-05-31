import { describe, it, expect } from "vitest";
import { handleOauthDesktopStart, parsePort } from "../src/routes/oauthDesktopStart";
import type { Config } from "../src/lib/config";

const cfg = {
  githubClientId: "cid",
  oauthRedirectUri: "https://x/cb",
} as Config;

function req(port?: string): Request {
  const u = new URL("https://x/auth/github/desktop-start");
  if (port !== undefined) u.searchParams.set("port", port);
  return new Request(u.toString());
}

describe("parsePort", () => {
  it("accepts an in-range integer", () => {
    expect(parsePort("1024")).toBe(1024);
    expect(parsePort("65535")).toBe(65535);
    expect(parsePort("49152")).toBe(49152);
  });
  it("rejects null, non-numeric, and out-of-range", () => {
    expect(parsePort(null)).toBeNull();
    expect(parsePort("")).toBeNull();
    expect(parsePort("abc")).toBeNull();
    expect(parsePort("80")).toBeNull();
    expect(parsePort("1023")).toBeNull();
    expect(parsePort("65536")).toBeNull();
    expect(parsePort("12.5")).toBeNull();
    expect(parsePort("-1")).toBeNull();
  });
});

describe("oauthDesktopStart", () => {
  it("302s to github authorize and sets state, flow, and port cookies", async () => {
    const res = await handleOauthDesktopStart(req("49231"), cfg);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe("cid");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://x/cb");
    expect(loc.searchParams.get("scope")).toBe("read:user");
    const state = loc.searchParams.get("state")!;
    expect(state.length).toBeGreaterThan(0);
    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toContain(`oauth_state=${state}`);
    expect(cookie).toContain("oauth_flow=desktop");
    expect(cookie).toContain("oauth_port=49231");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("rejects a missing port with 400", async () => {
    const res = await handleOauthDesktopStart(req(), cfg);
    expect(res.status).toBe(400);
  });

  it("rejects a non-numeric port with 400", async () => {
    const res = await handleOauthDesktopStart(req("abc"), cfg);
    expect(res.status).toBe(400);
  });

  it("rejects an out-of-range port with 400", async () => {
    const res = await handleOauthDesktopStart(req("80"), cfg);
    expect(res.status).toBe(400);
  });
});
