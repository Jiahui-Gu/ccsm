import { describe, it, expect } from "vitest";
import { b64url, b64urlDecode, b64urlJson } from "../src/lib/base64";

describe("base64url", () => {
  it("round-trips bytes without padding or url-unsafe chars", () => {
    const bytes = new Uint8Array([251, 255, 0, 1, 2, 62, 63]);
    const enc = b64url(bytes);
    expect(enc).not.toMatch(/[+/=]/);
    expect([...b64urlDecode(enc)]).toEqual([...bytes]);
  });

  it("b64urlJson encodes objects as decodable json", () => {
    const enc = b64urlJson({ a: 1, b: "x" });
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(enc)))).toEqual({
      a: 1,
      b: "x",
    });
  });
});
