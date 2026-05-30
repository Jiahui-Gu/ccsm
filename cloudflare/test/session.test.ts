import { describe, it, expect } from "vitest";
import { handleSession } from "../src/routes/session";
import { signJwt, verifyJwt, nowSec } from "../src/lib/jwt";
import type { Config } from "../src/lib/config";

const secret = new TextEncoder().encode("signing-key");
const cfg = {
  serverSecret: secret,
  sessionTtlMs: 900_000,
  stunUrls: ["stun:stun.cloudflare.com:3478"],
} as Config;

function post(body: unknown): Request {
  return new Request("https://x/auth/session", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("session", () => {
  it("400 when authCode is missing", async () => {
    const res = await handleSession(post({}), cfg);
    expect(res.status).toBe(400);
  });

  it("401 when authCode has the wrong typ", async () => {
    const bad = await signJwt(secret, { typ: "session", userHash: "u", exp: nowSec() + 60 });
    const res = await handleSession(post({ authCode: bad }), cfg);
    expect(res.status).toBe(401);
  });

  it("exchanges a valid auth_code for a session token + doUrl", async () => {
    const authCode = await signJwt(secret, {
      typ: "auth_code",
      userHash: "deadbeef",
      exp: nowSec() + 60,
    });
    const res = await handleSession(post({ authCode }), cfg);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      userHash: string;
      doUrl: string;
      iceServers: { urls: string[] }[];
      expiresInSeconds: number;
    };
    expect(body.userHash).toBe("deadbeef");
    expect(body.doUrl).toBe("wss://ccsm-worker.jiahuigu.workers.dev/do/deadbeef");
    expect(body.expiresInSeconds).toBe(900);
    expect(body.iceServers[0].urls).toEqual(["stun:stun.cloudflare.com:3478"]);
    const claims = await verifyJwt(secret, body.token);
    expect(claims).toMatchObject({ typ: "session", userHash: "deadbeef" });
  });
});
