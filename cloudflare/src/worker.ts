import { loadConfig, resolveAllowedOrigins, type Env } from "./lib/config";
import { handleOauthStart } from "./routes/oauthStart";
import { handleOauthLogin } from "./routes/oauthLogin";
import { handleOauthCallback } from "./routes/oauthCallback";
import { handleSession } from "./routes/session";
import { handleTurnCred } from "./routes/turnCred";
import { handleDoProxy } from "./routes/doProxy";
import { corsPreflight, withSecurityHeaders } from "./lib/cors";

export { PairingDurableObject } from "./pairingDo";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    const allowedOrigins = resolveAllowedOrigins(env);
    if (req.method === "OPTIONS") return corsPreflight(req, allowedOrigins);
    if (pathname === "/healthz") return new Response("ok");

    const cfg = loadConfig(env);
    let res: Response;
    try {
      if (req.method === "GET" && pathname === "/auth/github/start") {
        res = await handleOauthStart(req, cfg);
      } else if (req.method === "GET" && pathname === "/auth/github/login") {
        res = await handleOauthLogin(req, cfg);
      } else if (req.method === "GET" && pathname === "/auth/github/callback") {
        res = await handleOauthCallback(req, cfg);
      } else if (req.method === "POST" && pathname === "/auth/session") {
        res = await handleSession(req, cfg);
      } else if (req.method === "POST" && pathname === "/turn/credentials") {
        res = await handleTurnCred(req, cfg);
      } else if (req.method === "GET" && pathname.startsWith("/do/")) {
        res = await handleDoProxy(req, env, cfg, pathname.slice("/do/".length));
      } else if (req.method === "GET") {
        res = await env.ASSETS.fetch(req);
      } else {
        res = new Response("not found", { status: 404 });
      }
    } catch (err) {
      res = new Response(`internal error: ${(err as Error).message}`, { status: 500 });
    }
    return withSecurityHeaders(res, req, allowedOrigins);
  },
};
