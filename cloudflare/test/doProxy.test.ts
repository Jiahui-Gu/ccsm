import { describe, it, expect } from "vitest";
import { handleDoProxy } from "../src/routes/doProxy";
import { signJwt, nowSec } from "../src/lib/jwt";
import type { Config, Env } from "../src/lib/config";

const secret = new TextEncoder().encode("signing-key");
const cfg = { serverSecret: secret } as Config;

// Captures the Request the DO stub.fetch() receives so we can assert on the
// identity header doProxy injects.
function makeEnv(): { env: Env; captured: () => Request | null } {
  let captured: Request | null = null;
  const stub = {
    fetch: (req: Request) => {
      captured = req;
      return Promise.resolve(new Response("ok", { status: 200 }));
    },
  };
  const env = {
    PAIRING: {
      idFromName: (_name: string) => ({ name: _name }),
      get: (_id: unknown) => stub,
    },
  } as unknown as Env;
  return { env, captured: () => captured };
}

function wsReq(token: string): Request {
  return new Request(`https://x/do/deadbeef?token=${token}`, {
    headers: { Upgrade: "websocket" },
  });
}

describe("handleDoProxy", () => {
  it("426 when not a websocket upgrade", async () => {
    const { env } = makeEnv();
    const res = await handleDoProxy(
      new Request("https://x/do/deadbeef"),
      env,
      cfg,
      "deadbeef",
    );
    expect(res.status).toBe(426);
  });

  it("401 when the token is invalid", async () => {
    const { env } = makeEnv();
    const res = await handleDoProxy(wsReq("garbage"), env, cfg, "deadbeef");
    expect(res.status).toBe(401);
  });

  it("403 when the token userHash does not match the path", async () => {
    const { env } = makeEnv();
    const token = await signJwt(secret, {
      typ: "session",
      userHash: "other",
      exp: nowSec() + 60,
    });
    const res = await handleDoProxy(wsReq(token), env, cfg, "deadbeef");
    expect(res.status).toBe(403);
  });

  it("injects X-CCSM-User-Hash with the verified userHash and preserves upgrade", async () => {
    const { env, captured } = makeEnv();
    const token = await signJwt(secret, {
      typ: "session",
      userHash: "deadbeef",
      exp: nowSec() + 60,
    });
    const res = await handleDoProxy(wsReq(token), env, cfg, "deadbeef");
    expect(res.status).toBe(200);
    const fwd = captured();
    expect(fwd).not.toBeNull();
    expect(fwd!.headers.get("X-CCSM-User-Hash")).toBe("deadbeef");
    expect(fwd!.headers.get("Upgrade")).toBe("websocket");
    expect(new URL(fwd!.url).pathname).toBe("/do/deadbeef");
  });
});
