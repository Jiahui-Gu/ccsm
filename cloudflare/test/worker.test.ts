import { describe, it, expect, vi } from "vitest";
import worker from "../src/worker";
import type { Env } from "../src/lib/config";

function baseEnv(): Env {
  return {
    OAUTH_REDIRECT_URI: "https://x/cb",
    SESSION_TTL_SECONDS: "900",
    TURN_TTL_SECONDS: "600",
    ROOM_TTL_SECONDS: "60",
    TURN_URLS: "turn:turn.cloudflare.com:3478?transport=udp",
    STUN_URLS: "stun:stun.cloudflare.com:3478",
    GITHUB_OAUTH_CLIENT_ID: "cid",
    GITHUB_OAUTH_CLIENT_SECRET: "csecret",
    JWT_SIGNING_KEY: "k",
    PAIRING: {} as DurableObjectNamespace,
    ASSETS: { fetch: vi.fn(async () => new Response("PHONE_HTML", { status: 200 })) } as unknown as Fetcher,
  };
}

describe("worker routing", () => {
  it("serves /phone from the ASSETS binding", async () => {
    const env = baseEnv();
    const res = await worker.fetch(new Request("https://x/phone"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("PHONE_HTML");
    expect((env.ASSETS.fetch as any)).toHaveBeenCalled();
  });

  it("keeps API routes ahead of assets: /healthz stays 'ok'", async () => {
    const env = baseEnv();
    const res = await worker.fetch(new Request("https://x/healthz"), env);
    expect(await res.text()).toBe("ok");
    expect((env.ASSETS.fetch as any)).not.toHaveBeenCalled();
  });

  it("routes GET /auth/github/login to a 302", async () => {
    const env = baseEnv();
    const res = await worker.fetch(new Request("https://x/auth/github/login"), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("github.com/login/oauth/authorize");
  });
});
