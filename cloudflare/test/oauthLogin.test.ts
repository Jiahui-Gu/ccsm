import { describe, it, expect } from "vitest";
import { handleOauthLogin } from "../src/routes/oauthLogin";
import type { Config } from "../src/lib/config";

const cfg = { githubClientId: "cid", oauthRedirectUri: "https://x/cb" } as Config;

describe("oauthLogin", () => {
  it("302s to github authorize and marks flow=phone in the state cookie", async () => {
    const res = await handleOauthLogin(new Request("https://x/auth/github/login"), cfg);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe("cid");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://x/cb");
    expect(loc.searchParams.get("scope")).toBe("read:user");
    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toContain("oauth_state=");
    expect(cookie).toContain("oauth_flow=phone");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });
});
