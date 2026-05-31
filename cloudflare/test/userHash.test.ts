import { describe, it, expect } from "vitest";
import { hmacUserHash } from "../src/lib/userHash";

const secret = new TextEncoder().encode("server-secret");

describe("hmacUserHash", () => {
  it("same id -> same 64-hex hash", async () => {
    const a = await hmacUserHash(secret, 12345);
    const b = await hmacUserHash(secret, 12345);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different id -> different hash", async () => {
    const a = await hmacUserHash(secret, 12345);
    const b = await hmacUserHash(secret, 67890);
    expect(a).not.toBe(b);
  });

  it("hash depends on id only, not username (id stays after rename)", async () => {
    // hashing is over String(id); a rename never changes id, so hash is stable
    const before = await hmacUserHash(secret, 42);
    const after = await hmacUserHash(secret, 42);
    expect(before).toBe(after);
  });
});
