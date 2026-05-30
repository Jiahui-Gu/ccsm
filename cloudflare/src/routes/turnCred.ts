import type { Config } from "../lib/config";
import { json } from "../lib/cors";
import { verifyJwt, type Claims } from "../lib/jwt";

async function authSession(req: Request, cfg: Config): Promise<Claims | null> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  const claims = await verifyJwt(cfg.serverSecret, token);
  return claims && claims.typ === "session" ? claims : null;
}

export async function handleTurnCred(req: Request, cfg: Config): Promise<Response> {
  const claims = await authSession(req, cfg);
  if (!claims) return json({ error: "unauthorized" }, 401);

  // PR-1: TURN not configured -> 501; client falls back to STUN-only.
  if (!cfg.turnKeyId || !cfg.turnKeyApiToken) {
    return json({ error: "turn not configured" }, 501);
  }

  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${cfg.turnKeyId}/credentials/generate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.turnKeyApiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: cfg.turnTtlSeconds }),
    },
  );
  if (!res.ok) return json({ error: "turn provisioning failed" }, 502);
  const cred = (await res.json()) as {
    iceServers: { urls: string[]; username: string; credential: string };
  };

  return json({
    iceServers: [
      { urls: cfg.stunUrls },
      {
        urls: cfg.turnUrls,
        username: cred.iceServers.username,
        credential: cred.iceServers.credential,
      },
    ],
    expiresInSeconds: cfg.turnTtlSeconds,
  });
}
