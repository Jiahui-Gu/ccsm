import type { Config } from "../lib/config";
import { b64url } from "../lib/base64";

export async function handleOauthStart(_req: Request, cfg: Config): Promise<Response> {
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const auth = new URL("https://github.com/login/oauth/authorize");
  auth.searchParams.set("client_id", cfg.githubClientId);
  auth.searchParams.set("redirect_uri", cfg.oauthRedirectUri);
  auth.searchParams.set("scope", "read:user");
  auth.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: {
      Location: auth.toString(),
      "Set-Cookie": `oauth_state=${state}; Path=/; Max-Age=300; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}
