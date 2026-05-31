import type { Config } from "../lib/config";
import { b64url } from "../lib/base64";

/** Phone-flow OAuth start. Same authorize redirect as oauthStart.ts, but tags
 *  the state cookie with `oauth_flow=phone` so the shared GitHub callback knows
 *  to deliver a session token via a top-level redirect (fragment) instead of
 *  the desktop postMessage-popup. The phone's final landing page is fixed
 *  server-side (/phone) — callers cannot supply a redirect target, which closes
 *  the open-redirect surface. */
export async function handleOauthLogin(_req: Request, cfg: Config): Promise<Response> {
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const auth = new URL("https://github.com/login/oauth/authorize");
  auth.searchParams.set("client_id", cfg.githubClientId);
  auth.searchParams.set("redirect_uri", cfg.oauthRedirectUri);
  auth.searchParams.set("scope", "read:user");
  auth.searchParams.set("state", state);
  const cookie = [
    `oauth_state=${state}; Path=/; Max-Age=300; HttpOnly; Secure; SameSite=Lax`,
    `oauth_flow=phone; Path=/; Max-Age=300; HttpOnly; Secure; SameSite=Lax`,
  ].join(", ");
  return new Response(null, { status: 302, headers: { Location: auth.toString(), "Set-Cookie": cookie } });
}
