import type { Env, Config } from "../lib/config";
import { verifyJwt } from "../lib/jwt";

export async function handleDoProxy(
  req: Request,
  env: Env,
  cfg: Config,
  userHashFromPath: string,
): Promise<Response> {
  if (req.headers.get("Upgrade") !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }
  // Browser WebSocket cannot set custom headers, so the token rides ?token=.
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const claims = await verifyJwt(cfg.serverSecret, token);
  if (!claims || claims.typ !== "session") {
    return new Response("unauthorized", { status: 401 });
  }
  if (claims.userHash !== userHashFromPath) {
    return new Response("forbidden: userHash mismatch", { status: 403 });
  }
  const id = env.PAIRING.idFromName(claims.userHash);
  const stub = env.PAIRING.get(id);
  return stub.fetch(req);
}
