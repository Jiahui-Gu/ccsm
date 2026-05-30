export async function hmacUserHash(
  serverSecret: Uint8Array,
  githubUserId: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    serverSecret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(String(githubUserId)),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
