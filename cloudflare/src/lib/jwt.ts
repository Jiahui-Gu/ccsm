import { b64url, b64urlDecode, b64urlJson } from "./base64";

export interface Claims {
  typ: "auth_code" | "session";
  userHash: string;
  exp: number;
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

async function hmacSign(secret: Uint8Array, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64url(new Uint8Array(sig));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signJwt(secret: Uint8Array, claims: Claims): Promise<string> {
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const payload = b64urlJson(claims);
  const data = `${header}.${payload}`;
  const sig = await hmacSign(secret, data);
  return `${data}.${sig}`;
}

export async function verifyJwt(
  secret: Uint8Array,
  token: string,
): Promise<Claims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  // Only HS256 is ever accepted; the header alg is intentionally NOT read,
  // which neutralises alg-confusion / alg:none attacks.
  const expected = await hmacSign(secret, `${h}.${p}`);
  if (!timingSafeEqual(s, expected)) return null;
  let claims: Claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p))) as Claims;
  } catch {
    return null;
  }
  if (typeof claims.exp !== "number" || claims.exp < nowSec()) return null;
  return claims;
}
