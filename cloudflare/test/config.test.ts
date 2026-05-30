import { describe, it, expect } from "vitest";
import { loadConfig, type Env } from "../src/lib/config";

function baseEnv(): Env {
  return {
    PAIRING: {} as Env["PAIRING"],
    OAUTH_REDIRECT_URI: "https://x/cb",
    SESSION_TTL_SECONDS: "900",
    TURN_TTL_SECONDS: "600",
    ROOM_TTL_SECONDS: "60",
    TURN_URLS: "turn:a:3478?transport=udp, turns:b:5349?transport=tcp",
    STUN_URLS: "stun:s:3478",
    GITHUB_OAUTH_CLIENT_ID: "cid",
    GITHUB_OAUTH_CLIENT_SECRET: "csecret",
    JWT_SIGNING_KEY: "signing-key",
  };
}

describe("loadConfig", () => {
  it("parses vars + secrets, derives ms and split lists", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.sessionTtlMs).toBe(900_000);
    expect(cfg.roomTtlMs).toBe(60_000);
    expect(cfg.turnTtlSeconds).toBe(600);
    expect(cfg.turnUrls).toEqual([
      "turn:a:3478?transport=udp",
      "turns:b:5349?transport=tcp",
    ]);
    expect(cfg.stunUrls).toEqual(["stun:s:3478"]);
    expect(new TextDecoder().decode(cfg.serverSecret)).toBe("signing-key");
    expect(cfg.turnKeyId).toBeUndefined();
    expect(cfg.turnKeyApiToken).toBeUndefined();
  });

  it("throws on a missing required secret", () => {
    const env = baseEnv();
    env.JWT_SIGNING_KEY = "";
    expect(() => loadConfig(env)).toThrow(/JWT_SIGNING_KEY/);
  });

  it("treats TURN keys as optional", () => {
    const env = baseEnv();
    env.TURN_KEY_ID = "kid";
    env.TURN_KEY_API_TOKEN = "ktok";
    const cfg = loadConfig(env);
    expect(cfg.turnKeyId).toBe("kid");
    expect(cfg.turnKeyApiToken).toBe("ktok");
  });
});
