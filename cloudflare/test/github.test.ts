import { describe, it, expect, vi, afterEach } from "vitest";
import { exchangeCode, fetchGithubUserId } from "../src/lib/github";
import type { Config } from "../src/lib/config";

const cfg = {
  githubClientId: "cid",
  githubClientSecret: "csecret",
  oauthRedirectUri: "https://x/cb",
} as Config;

afterEach(() => vi.restoreAllMocks());

describe("github", () => {
  it("exchangeCode posts code and returns access_token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "tok123" }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const token = await exchangeCode(cfg, "the-code");
    expect(token).toBe("tok123");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("login/oauth/access_token");
    expect(JSON.parse(init!.body as string)).toMatchObject({
      client_id: "cid",
      client_secret: "csecret",
      code: "the-code",
    });
  });

  it("exchangeCode throws when github returns an error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "bad_verification_code" }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(exchangeCode(cfg, "x")).rejects.toThrow(/bad_verification_code/);
  });

  it("fetchGithubUserId returns numeric id", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: 4242 }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(await fetchGithubUserId("tok")).toBe(4242);
  });

  it("fetchGithubUserId throws on non-ok", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 401 }));
    await expect(fetchGithubUserId("tok")).rejects.toThrow(/401/);
  });
});
