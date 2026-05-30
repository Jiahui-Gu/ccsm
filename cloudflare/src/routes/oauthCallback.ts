import type { Config } from "../lib/config";
import { readCookie } from "../lib/cors";
import { exchangeCode, fetchGithubUserId } from "../lib/github";
import { hmacUserHash } from "../lib/userHash";
import { signJwt, nowSec } from "../lib/jwt";

function renderCallbackHtml(authCode: string): string {
  const payload = JSON.stringify({ authCode });
  return `<!doctype html><meta charset="utf-8"><title>Signing in</title>
<script>
(function(){
  var msg = ${payload};
  try { if (window.opener) window.opener.postMessage(msg, "*"); } catch (e) {}
  document.body && (document.body.textContent = "You can close this window.");
  try { window.close(); } catch (e) {}
})();
</script>
<body>Signing in...</body>`;
}

export async function handleOauthCallback(req: Request, cfg: Config): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = readCookie(req, "oauth_state");
  if (!code || !state || state !== cookieState) {
    return new Response("invalid oauth state", { status: 400 });
  }
  const token = await exchangeCode(cfg, code);
  const githubUserId = await fetchGithubUserId(token);
  const userHash = await hmacUserHash(cfg.serverSecret, githubUserId);
  const authCode = await signJwt(cfg.serverSecret, {
    typ: "auth_code",
    userHash,
    exp: nowSec() + 60,
  });
  return new Response(renderCallbackHtml(authCode), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": "oauth_state=; Path=/; Max-Age=0",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
    },
  });
}
