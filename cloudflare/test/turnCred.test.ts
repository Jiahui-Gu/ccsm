import { describe, it, expect, vi, afterEach } from "vitest";
import { handleTurnCred } from "../src/routes/turnCred";
import { signJwt, nowSec } from "../src/lib/jwt";
import type { Config } from "../src/lib/config";

const secret = new TextEncoder().encode("signing-key");

function baseCfg(): Config {
  return {
    serverSecret: secret,
    turnTtlSeconds: 600,
    stunUrls: ["stun:s:3478"],
    turnUrls: ["turn:t:3478?transport=udp"],
  } as Config;
}

function post(token?: string): Request {
  return new Request("https://x/turn/credentials", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

async function sessionToken(): Promise<string> {
  return signJwt(secret, { typ: "session", userHash: "u", exp: nowSec() + 60 });
}

afterEach(() => vi.restoreAllMocks());

describe("turnCred", () => {
  it("401 without a session jwt", async () => {
    const res = await handleTurnCred(post(), baseCfg());
    expect(res.status).toBe(401);
  });

  it("501 when TURN is not configured (PR-1 default)", async () => {
    const res = await handleTurnCred(post(await sessionToken()), baseCfg());
    expect(res.status).toBe(501);
  });

  it("200 with iceServers when TURN keys are present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ iceServers: { urls: ["turn:t"], username: "tu", credential: "tc" } }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
    const cfg = baseCfg();
    cfg.turnKeyId = "kid";
    cfg.turnKeyApiToken = "ktok";
    const res = await handleTurnCred(post(await sessionToken()), cfg);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      iceServers: { urls: string[]; username?: string; credential?: string }[];
      expiresInSeconds: number;
    };
    expect(body.expiresInSeconds).toBe(600);
    expect(body.iceServers[1]).toMatchObject({ username: "tu", credential: "tc" });
  });
});
