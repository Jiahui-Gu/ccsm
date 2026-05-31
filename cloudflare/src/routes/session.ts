import type { Config } from "../lib/config";
import { json } from "../lib/cors";
import { signJwt, verifyJwt, nowSec } from "../lib/jwt";

export async function handleSession(req: Request, cfg: Config): Promise<Response> {
  const { authCode } = (await req.json()) as { authCode?: string };
  if (!authCode) return json({ error: "missing authCode" }, 400);
  const claims = await verifyJwt(cfg.serverSecret, authCode);
  if (!claims || claims.typ !== "auth_code") {
    return json({ error: "bad authCode" }, 401);
  }
  const ttlSec = cfg.sessionTtlMs / 1000;
  const token = await signJwt(cfg.serverSecret, {
    typ: "session",
    userHash: claims.userHash,
    exp: nowSec() + ttlSec,
  });
  // Derive the DO WebSocket host from the inbound request: the DO lives on the
  // same Worker the client just reached, so this is self-configuring across
  // any subdomain/zone the Worker is deployed to.
  const host = new URL(req.url).host;
  return json({
    token,
    userHash: claims.userHash,
    doUrl: `wss://${host}/do/${claims.userHash}`,
    iceServers: [{ urls: cfg.stunUrls }],
    expiresInSeconds: ttlSec,
  });
}
