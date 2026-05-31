import { describe, it, expect } from "vitest";
import { handleOauthStart } from "../src/routes/oauthStart";
import type { Config } from "../src/lib/config";

const cfg = {
  githubClientId: "cid",
  oauthRedirectUri: "https://x/cb",
} as Config;

describe("oauthStart", () => {
  it("302s to github authorize with state cookie", async () => {
    const res = await handleOauthStart(new Request("https://x/auth/github/start"), cfg);
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
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });
});
