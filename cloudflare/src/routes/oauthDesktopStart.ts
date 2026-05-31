import type { Config } from "../lib/config";
import { b64url } from "../lib/base64";

export function parsePort(raw: string | null): number | null {
  if (raw == null || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (n < 1024 || n > 65535) return null;
  return n;
}

export async function handleOauthDesktopStart(req: Request, cfg: Config): Promise<Response> {
  const url = new URL(req.url);
  const port = parsePort(url.searchParams.get("port"));
  if (port == null) return new Response("invalid port", { status: 400 });

  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const auth = new URL("https://github.com/login/oauth/authorize");
  auth.searchParams.set("client_id", cfg.githubClientId);
  auth.searchParams.set("redirect_uri", cfg.oauthRedirectUri);
  auth.searchParams.set("scope", "read:user");
  auth.searchParams.set("state", state);

  const attrs = "Path=/; Max-Age=300; HttpOnly; Secure; SameSite=Lax";
  return new Response(null, {
    status: 302,
    headers: {
      Location: auth.toString(),
      "Set-Cookie": [
        `oauth_state=${state}; ${attrs}`,
        `oauth_flow=desktop; ${attrs}`,
        `oauth_port=${port}; ${attrs}`,
      ].join(", "),
    },
  });
}
