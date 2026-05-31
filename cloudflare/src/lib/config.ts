export interface Env {
  PAIRING: DurableObjectNamespace;
  // vars
  OAUTH_REDIRECT_URI: string;
  SESSION_TTL_SECONDS: string;
  TURN_TTL_SECONDS: string;
  ROOM_TTL_SECONDS: string;
  TURN_URLS: string;
  STUN_URLS: string;
  // optional: comma-separated CORS allowlist; absence falls back to the
  // current deploy's public origin (back-compat with the existing deploy).
  PUBLIC_ORIGIN?: string;
  // secrets (already put on ccsm-worker)
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  JWT_SIGNING_KEY: string; // HMAC userHash + JWT signing (was SERVER_SECRET)
  TURN_KEY_ID?: string; // optional: PR-1 does not configure TURN (see turnCred)
  TURN_KEY_API_TOKEN?: string; // optional: same
  ASSETS: Fetcher; // static-asset binding for the phone PWA (wrangler [assets])
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
  allowedOrigins: string[];
}

// Back-compat fallback for the existing ccsm-worker deploy when PUBLIC_ORIGIN
// is not set. Keep in sync with the live worker's public origin.
export const DEFAULT_ALLOWED_ORIGIN = "https://ccsm-worker.jiahuigu.workers.dev";

// Resolve the CORS allowlist from env without requiring secrets to be present
// (used by the OPTIONS preflight path, which runs before loadConfig).
export function resolveAllowedOrigins(env: Env): string[] {
  const raw = typeof env.PUBLIC_ORIGIN === "string" ? env.PUBLIC_ORIGIN : "";
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : [DEFAULT_ALLOWED_ORIGIN];
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
  const allowedOrigins = resolveAllowedOrigins(env);
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
    allowedOrigins,
  };
}
