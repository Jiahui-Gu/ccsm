export interface Env {
  PAIRING: DurableObjectNamespace;
  // vars
  OAUTH_REDIRECT_URI: string;
  SESSION_TTL_SECONDS: string;
  TURN_TTL_SECONDS: string;
  ROOM_TTL_SECONDS: string;
  TURN_URLS: string;
  STUN_URLS: string;
  // secrets (already put on ccsm-worker)
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  JWT_SIGNING_KEY: string; // HMAC userHash + JWT signing (was SERVER_SECRET)
  TURN_KEY_ID?: string; // optional: PR-1 does not configure TURN (see turnCred)
  TURN_KEY_API_TOKEN?: string; // optional: same
}

export interface Config {
  githubClientId: string;
  githubClientSecret: string;
  oauthRedirectUri: string;
  serverSecret: Uint8Array; // loaded from JWT_SIGNING_KEY (name kept from original design)
  sessionTtlMs: number;
  turnTtlSeconds: number;
  roomTtlMs: number;
  turnUrls: string[];
  stunUrls: string[];
  turnKeyId?: string;
  turnKeyApiToken?: string;
}

export function loadConfig(env: Env): Config {
  const need = (k: keyof Env): string => {
    const v = env[k];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`missing config: ${k}`);
    }
    return v;
  };
  const opt = (k: keyof Env): string | undefined => {
    const v = env[k];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  const enc = new TextEncoder();
  return {
    githubClientId: need("GITHUB_OAUTH_CLIENT_ID"),
    githubClientSecret: need("GITHUB_OAUTH_CLIENT_SECRET"),
    oauthRedirectUri: need("OAUTH_REDIRECT_URI"),
    serverSecret: enc.encode(need("JWT_SIGNING_KEY")),
    sessionTtlMs: Number(need("SESSION_TTL_SECONDS")) * 1000,
    turnTtlSeconds: Number(need("TURN_TTL_SECONDS")),
    roomTtlMs: Number(need("ROOM_TTL_SECONDS")) * 1000,
    turnUrls: need("TURN_URLS").split(",").map((s) => s.trim()).filter(Boolean),
    stunUrls: need("STUN_URLS").split(",").map((s) => s.trim()).filter(Boolean),
    turnKeyId: opt("TURN_KEY_ID"),
    turnKeyApiToken: opt("TURN_KEY_API_TOKEN"),
  };
}
