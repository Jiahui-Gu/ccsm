import type { Config } from "./config";

export async function exchangeCode(cfg: Config, code: string): Promise<string> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: cfg.githubClientId,
      client_secret: cfg.githubClientSecret,
      code,
      redirect_uri: cfg.oauthRedirectUri,
    }),
  });
  const data = (await res.json()) as { access_token?: string; error?: string };
  if (!data.access_token) {
    throw new Error(`github token exchange failed: ${data.error}`);
  }
  return data.access_token;
}

export async function fetchGithubUserId(token: string): Promise<number> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "cc-sm-signaling",
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) throw new Error(`github /user failed: ${res.status}`);
  const data = (await res.json()) as { id?: number };
  if (typeof data.id !== "number") throw new Error("github /user missing id");
  return data.id;
}
