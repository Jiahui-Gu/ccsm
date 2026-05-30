import { describe, it, expect } from "vitest";
import { signJwt, verifyJwt, nowSec } from "../src/lib/jwt";
import { b64urlJson } from "../src/lib/base64";

const secret = new TextEncoder().encode("jwt-secret");

describe("jwt HS256", () => {
  it("sign then verify round-trips claims", async () => {
    const token = await signJwt(secret, {
      typ: "session",
      userHash: "abc",
      exp: nowSec() + 60,
    });
    const claims = await verifyJwt(secret, token);
    expect(claims).toMatchObject({ typ: "session", userHash: "abc" });
  });

  it("rejects an expired token", async () => {
    const token = await signJwt(secret, {
      typ: "session",
      userHash: "abc",
      exp: nowSec() - 1,
    });
    expect(await verifyJwt(secret, token)).toBeNull();
  });

  it("rejects a tampered signature", async () => {
    const token = await signJwt(secret, {
      typ: "session",
      userHash: "abc",
      exp: nowSec() + 60,
    });
    const [h, p] = token.split(".");
    expect(await verifyJwt(secret, `${h}.${p}.deadbeef`)).toBeNull();
  });

  it("rejects alg:none / header-forged tokens", async () => {
    const header = b64urlJson({ alg: "none", typ: "JWT" });
    const payload = b64urlJson({ typ: "session", userHash: "x", exp: nowSec() + 60 });
    expect(await verifyJwt(secret, `${header}.${payload}.`)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const other = new TextEncoder().encode("other-secret");
    const token = await signJwt(other, {
      typ: "session",
      userHash: "abc",
      exp: nowSec() + 60,
    });
    expect(await verifyJwt(secret, token)).toBeNull();
  });
});
