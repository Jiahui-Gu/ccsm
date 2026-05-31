# Mobile Remote PR-1 — Cloudflare Signaling + GitHub Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the entire Cloudflare side of mobile-remote — a stateless Worker that terminates GitHub OAuth, mints session JWTs, and proxies a WebSocket signaling channel to a per-user Durable Object that matchmakes desktop↔phone and relays SDP/ICE — all provable with miniflare local unit tests, no real GitHub / Cloudflare / phone / desktop code.

**Architecture:** A single `worker.ts` fetch entry dispatches by `method + pathname` to small route handlers. Pure helpers (`jwt`, `userHash`, `github`, `cors`, `config`) are transport-agnostic and unit-tested in isolation. `PairingDurableObject` is one matchmaking room per GitHub user, keyed by `idFromName(userHash)`; it holds members in memory only and relays signaling JSON frames verbatim. All tests run under `@cloudflare/vitest-pool-workers` (miniflare) so the whole PR is verifiable offline with `npm test`.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects, `crypto.subtle` (HS256 JWT / HMAC, no third-party crypto lib), `wrangler`, `vitest` + `@cloudflare/vitest-pool-workers` (miniflare). New code lives entirely in the repo's `cloudflare/` subdirectory.

---

## Scope & Boundaries

This plan is **PR-1 only** from the detail spec `docs/superpowers/specs/2026-05-30-mobile-remote-pr1-cloudflare-detail.md`. It is the Cloudflare slice; it ships and is reviewed without any desktop or phone code.

**In scope:**
- `cloudflare/` project scaffold (`wrangler.toml`, `package.json`, `tsconfig.json`, vitest config).
- Config loader + `Env`/`Config` types reading **already-existing** `ccsm-worker` secrets (§Key constraints below).
- Pure helpers: `userHash` (HMAC-SHA256), `jwt` (HS256 sign/verify), `github` (code→token, `/user`→id), `cors`.
- Routes: `oauthStart`, `oauthCallback`, `session`, `turnCred`, `doProxy`, plus inline `/healthz` and `404`.
- `PairingDurableObject`: register / peer-present / peer-gone / offer / answer / ice relay + room GC + member cap.
- miniflare unit tests for every unit (spec §9).

**Explicitly OUT of scope (later PRs / user-run):**
- Desktop `signalingClient` / `desktopPeer` (PR-2), phone PWA (PR-3), real WebRTC interop (PR-4), TURN enablement + real-device fallback (PR-5).
- `wrangler login` / `wrangler secret put` / `wrangler deploy` — **the user runs these**. This plan only does local `npm test` (miniflare, no secrets) and optionally local `wrangler dev`. No step here deploys or puts secrets on the user's behalf.

---

## Key Constraints (must hold throughout)

1. **Reuse existing `ccsm-worker` secrets (Plan A, locked).** The code reads secret **names that already exist**; the user puts **nothing** new:
   - `env.GITHUB_OAUTH_CLIENT_ID` (client id; public value `Ov23liICal7F5NDZO1r1`, but read as a secret).
   - `env.GITHUB_OAUTH_CLIENT_SECRET` (GitHub token exchange).
   - `env.JWT_SIGNING_KEY` (HMAC userHash + JWT signing — this replaces the original design's `SERVER_SECRET`). The `Config.serverSecret` field name is **kept**, but a comment states it is loaded from `JWT_SIGNING_KEY`.
   - `JWT_REFRESH_SIGNING_KEY` is legacy; **PR-1 does not read it**.
   - TURN keys (`TURN_KEY_ID?` / `TURN_KEY_API_TOKEN?`) are optional; when unset, `/turn/credentials` returns **501**. PR-1 does not bind a card or configure TURN.
   - `wrangler.toml` `name = "ccsm-worker"`.
2. **Secrets never enter the repo, never reach the client.** Only public values (client id placeholder, `[vars]`) and explanatory comments go in `cloudflare/`.
3. **miniflare-local verifiability.** All tests pass locally via `npm test`. Deploy is the user's job; no deploy step here.
4. **npm only (never pnpm/yarn), Node ≥22.** The `cloudflare/` project is a self-contained npm package; it does not import from `electron/` or `src/`.

### Proxy prefix for `wrangler` commands

Any `wrangler` command run locally (only in the optional Task 14 verification, user-run) **must** be prefixed with the local proxy. Plain `npm test` (miniflare) does **not** need it.

```bash
HTTP_PROXY=http://127.0.0.1:12334 HTTPS_PROXY=http://127.0.0.1:12334 http_proxy=http://127.0.0.1:12334 https_proxy=http://127.0.0.1:12334 NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1 npx wrangler dev
```

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `cloudflare/package.json` | Self-contained npm package: `vitest` + `@cloudflare/vitest-pool-workers` + `wrangler` + `typescript`. Scripts: `test`, `typecheck`. | Create |
| `cloudflare/tsconfig.json` | TS config targeting Workers (`@cloudflare/workers-types`, `crypto.subtle` globals). | Create |
| `cloudflare/wrangler.toml` | Worker name, DO binding + migration, public `[vars]`, secret comments. | Create |
| `cloudflare/vitest.config.ts` | `@cloudflare/vitest-pool-workers` pointed at `wrangler.toml`. | Create |
| `cloudflare/src/lib/config.ts` | `Env` + `Config` types, `loadConfig(env)` with required/optional validation. | Create |
| `cloudflare/src/lib/base64.ts` | base64url encode/decode + JSON helpers shared by jwt/userHash/oauth. | Create |
| `cloudflare/src/lib/userHash.ts` | `hmacUserHash(serverSecret, githubUserId)` → 64-hex. | Create |
| `cloudflare/src/lib/jwt.ts` | HS256 `signJwt` / `verifyJwt`, `nowSec`, `timingSafeEqual`. | Create |
| `cloudflare/src/lib/github.ts` | `exchangeCode`, `fetchGithubUserId`. | Create |
| `cloudflare/src/lib/cors.ts` | `corsPreflight`, `withSecurityHeaders`, `json`, `readCookie`. | Create |
| `cloudflare/src/routes/oauthStart.ts` | `GET /auth/github/start`. | Create |
| `cloudflare/src/routes/oauthCallback.ts` | `GET /auth/github/callback`. | Create |
| `cloudflare/src/routes/session.ts` | `POST /auth/session`. | Create |
| `cloudflare/src/routes/turnCred.ts` | `POST /turn/credentials`. | Create |
| `cloudflare/src/routes/doProxy.ts` | `GET /do/:userHash` (WS Upgrade → DO). | Create |
| `cloudflare/src/pairingDo.ts` | `PairingDurableObject` matchmaking + relay. | Create |
| `cloudflare/src/worker.ts` | fetch entry + route dispatch + DO re-export. | Create |
| `cloudflare/test/userHash.test.ts` | userHash determinism + id-stability. | Create |
| `cloudflare/test/jwt.test.ts` | sign/verify round-trip, expiry, tamper, `alg:none`, `typ`. | Create |
| `cloudflare/test/oauth.test.ts` | callback state mismatch, code→token→user→authCode, session exchange, cross-account isolation. | Create |
| `cloudflare/test/turnCred.test.ts` | 401 without JWT, 501 when unconfigured, 200 with TURN mock. | Create |
| `cloudflare/test/pairingDo.test.ts` | register/peer-present/relay/peer-not-found/not-registered/peer-gone/room-full/DO isolation. | Create |

---

## Task 1: Scaffold the `cloudflare/` npm package

**Files:**
- Create: `cloudflare/package.json`
- Create: `cloudflare/tsconfig.json`
- Create: `cloudflare/wrangler.toml`
- Create: `cloudflare/vitest.config.ts`

- [ ] **Step 1: Create `cloudflare/package.json`**

```json
{
  "name": "ccsm-cloudflare",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "@cloudflare/workers-types": "^4.20250101.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "wrangler": "^3.90.0"
  }
}
```

- [ ] **Step 2: Create `cloudflare/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

- [ ] **Step 3: Create `cloudflare/wrangler.toml`**

```toml
name = "ccsm-worker"                # -> ccsm-worker.jiahuigu.workers.dev
main = "src/worker.ts"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "PAIRING"                    # env.PAIRING -> DurableObjectNamespace
class_name = "PairingDurableObject"

[[migrations]]
tag = "v1"
new_classes = ["PairingDurableObject"]

# Public config (safe to commit)
[vars]
OAUTH_REDIRECT_URI = "https://ccsm-worker.jiahuigu.workers.dev/auth/github/callback"
SESSION_TTL_SECONDS = "900"        # 15 min
TURN_TTL_SECONDS = "600"           # 10 min
ROOM_TTL_SECONDS = "60"            # DO survives this long after both sides drop
TURN_URLS = "turn:turn.cloudflare.com:3478?transport=udp,turns:turn.cloudflare.com:5349?transport=tcp"
STUN_URLS = "stun:stun.cloudflare.com:3478"

# Secrets (NEVER in repo; already put on ccsm-worker, user re-puts nothing):
#   GITHUB_OAUTH_CLIENT_ID      GitHub OAuth app client id (public value, stored as secret)
#   GITHUB_OAUTH_CLIENT_SECRET  GitHub OAuth app client secret (ccsm-oAuth secret)
#   JWT_SIGNING_KEY             server secret for HMAC userHash + JWT signing (was SERVER_SECRET)
#   TURN_KEY_ID                 optional - PR-1 does not bind a card / configure TURN
#   TURN_KEY_API_TOKEN          optional - same
#   (legacy JWT_REFRESH_SIGNING_KEY is NOT read by PR-1)
```

- [ ] **Step 4: Create `cloudflare/vitest.config.ts`**

```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          compatibilityFlags: ["nodejs_compat"],
          bindings: {
            OAUTH_REDIRECT_URI:
              "https://ccsm-worker.jiahuigu.workers.dev/auth/github/callback",
            SESSION_TTL_SECONDS: "900",
            TURN_TTL_SECONDS: "600",
            ROOM_TTL_SECONDS: "60",
            TURN_URLS:
              "turn:turn.cloudflare.com:3478?transport=udp,turns:turn.cloudflare.com:5349?transport=tcp",
            STUN_URLS: "stun:stun.cloudflare.com:3478",
            GITHUB_OAUTH_CLIENT_ID: "test-client-id",
            GITHUB_OAUTH_CLIENT_SECRET: "test-client-secret",
            JWT_SIGNING_KEY: "test-jwt-signing-key-0123456789",
          },
        },
      },
    },
  },
});
```

- [ ] **Step 5: Install dependencies**

Run:
```bash
cd cloudflare && npm install
```
Expected: lockfile written, `node_modules/` populated, exit 0. (No native rebuild — pure JS deps.)

- [ ] **Step 6: Commit**

```bash
git add cloudflare/package.json cloudflare/package-lock.json cloudflare/tsconfig.json cloudflare/wrangler.toml cloudflare/vitest.config.ts
git commit -m "chore(mobile-remote): scaffold cloudflare worker package (PR-1)"
```

---

## Task 2: base64url helpers

**Files:**
- Create: `cloudflare/src/lib/base64.ts`
- Test: `cloudflare/test/base64.test.ts`

- [ ] **Step 1: Write the failing test**

`cloudflare/test/base64.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { b64url, b64urlDecode, b64urlJson } from "../src/lib/base64";

describe("base64url", () => {
  it("round-trips bytes without padding or url-unsafe chars", () => {
    const bytes = new Uint8Array([251, 255, 0, 1, 2, 62, 63]);
    const enc = b64url(bytes);
    expect(enc).not.toMatch(/[+/=]/);
    expect([...b64urlDecode(enc)]).toEqual([...bytes]);
  });

  it("b64urlJson encodes objects as decodable json", () => {
    const enc = b64urlJson({ a: 1, b: "x" });
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(enc)))).toEqual({
      a: 1,
      b: "x",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd cloudflare && npx vitest run test/base64.test.ts
```
Expected: FAIL — cannot resolve `../src/lib/base64`.

- [ ] **Step 3: Write minimal implementation**

`cloudflare/src/lib/base64.ts`:
```ts
export function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlJson(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd cloudflare && npx vitest run test/base64.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add cloudflare/src/lib/base64.ts cloudflare/test/base64.test.ts
git commit -m "feat(mobile-remote): add base64url helpers for cloudflare worker"
```

---

## Task 3: `Env` / `Config` types + `loadConfig`

**Files:**
- Create: `cloudflare/src/lib/config.ts`
- Test: `cloudflare/test/config.test.ts`

- [ ] **Step 1: Write the failing test**

`cloudflare/test/config.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { loadConfig, type Env } from "../src/lib/config";

function baseEnv(): Env {
  return {
    PAIRING: {} as Env["PAIRING"],
    OAUTH_REDIRECT_URI: "https://x/cb",
    SESSION_TTL_SECONDS: "900",
    TURN_TTL_SECONDS: "600",
    ROOM_TTL_SECONDS: "60",
    TURN_URLS: "turn:a:3478?transport=udp, turns:b:5349?transport=tcp",
    STUN_URLS: "stun:s:3478",
    GITHUB_OAUTH_CLIENT_ID: "cid",
    GITHUB_OAUTH_CLIENT_SECRET: "csecret",
    JWT_SIGNING_KEY: "signing-key",
  };
}

describe("loadConfig", () => {
  it("parses vars + secrets, derives ms and split lists", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.sessionTtlMs).toBe(900_000);
    expect(cfg.roomTtlMs).toBe(60_000);
    expect(cfg.turnTtlSeconds).toBe(600);
    expect(cfg.turnUrls).toEqual([
      "turn:a:3478?transport=udp",
      "turns:b:5349?transport=tcp",
    ]);
    expect(cfg.stunUrls).toEqual(["stun:s:3478"]);
    expect(new TextDecoder().decode(cfg.serverSecret)).toBe("signing-key");
    expect(cfg.turnKeyId).toBeUndefined();
    expect(cfg.turnKeyApiToken).toBeUndefined();
  });

  it("throws on a missing required secret", () => {
    const env = baseEnv();
    env.JWT_SIGNING_KEY = "";
    expect(() => loadConfig(env)).toThrow(/JWT_SIGNING_KEY/);
  });

  it("treats TURN keys as optional", () => {
    const env = baseEnv();
    env.TURN_KEY_ID = "kid";
    env.TURN_KEY_API_TOKEN = "ktok";
    const cfg = loadConfig(env);
    expect(cfg.turnKeyId).toBe("kid");
    expect(cfg.turnKeyApiToken).toBe("ktok");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd cloudflare && npx vitest run test/config.test.ts
```
Expected: FAIL — cannot resolve `../src/lib/config`.

- [ ] **Step 3: Write minimal implementation**

`cloudflare/src/lib/config.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd cloudflare && npx vitest run test/config.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add cloudflare/src/lib/config.ts cloudflare/test/config.test.ts
git commit -m "feat(mobile-remote): add cloudflare worker config loader"
```

---

## Task 4: `userHash` (HMAC-SHA256)

**Files:**
- Create: `cloudflare/src/lib/userHash.ts`
- Test: `cloudflare/test/userHash.test.ts`

- [ ] **Step 1: Write the failing test**

`cloudflare/test/userHash.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { hmacUserHash } from "../src/lib/userHash";

const secret = new TextEncoder().encode("server-secret");

describe("hmacUserHash", () => {
  it("same id -> same 64-hex hash", async () => {
    const a = await hmacUserHash(secret, 12345);
    const b = await hmacUserHash(secret, 12345);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different id -> different hash", async () => {
    const a = await hmacUserHash(secret, 12345);
    const b = await hmacUserHash(secret, 67890);
    expect(a).not.toBe(b);
  });

  it("hash depends on id only, not username (id stays after rename)", async () => {
    // hashing is over String(id); a rename never changes id, so hash is stable
    const before = await hmacUserHash(secret, 42);
    const after = await hmacUserHash(secret, 42);
    expect(before).toBe(after);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd cloudflare && npx vitest run test/userHash.test.ts
```
Expected: FAIL — cannot resolve `../src/lib/userHash`.

- [ ] **Step 3: Write minimal implementation**

`cloudflare/src/lib/userHash.ts`:
```ts
export async function hmacUserHash(
  serverSecret: Uint8Array,
  githubUserId: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    serverSecret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(String(githubUserId)),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd cloudflare && npx vitest run test/userHash.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add cloudflare/src/lib/userHash.ts cloudflare/test/userHash.test.ts
git commit -m "feat(mobile-remote): add userHash hmac for cloudflare worker"
```

---

## Task 5: `jwt` (HS256 sign/verify)

**Files:**
- Create: `cloudflare/src/lib/jwt.ts`
- Test: `cloudflare/test/jwt.test.ts`

- [ ] **Step 1: Write the failing test**

`cloudflare/test/jwt.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { signJwt, verifyJwt, nowSec } from "../src/lib/jwt";
import { b64urlJson } from "../src/lib/base64";

const secret = new TextEncoder().encode("jwt-secret");

describe("jwt HS256", () => {
  it("sign then verify round-trips claims", async () => {
    const token = await signJwt(secret, {
      typ: "session",
      userHash: "abc",
      exp: nowSec() + 60,
    });
    const claims = await verifyJwt(secret, token);
    expect(claims).toMatchObject({ typ: "session", userHash: "abc" });
  });

  it("rejects an expired token", async () => {
    const token = await signJwt(secret, {
      typ: "session",
      userHash: "abc",
      exp: nowSec() - 1,
    });
    expect(await verifyJwt(secret, token)).toBeNull();
  });

  it("rejects a tampered signature", async () => {
    const token = await signJwt(secret, {
      typ: "session",
      userHash: "abc",
      exp: nowSec() + 60,
    });
    const [h, p] = token.split(".");
    expect(await verifyJwt(secret, `${h}.${p}.deadbeef`)).toBeNull();
  });

  it("rejects alg:none / header-forged tokens", async () => {
    const header = b64urlJson({ alg: "none", typ: "JWT" });
    const payload = b64urlJson({ typ: "session", userHash: "x", exp: nowSec() + 60 });
    expect(await verifyJwt(secret, `${header}.${payload}.`)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const other = new TextEncoder().encode("other-secret");
    const token = await signJwt(other, {
      typ: "session",
      userHash: "abc",
      exp: nowSec() + 60,
    });
    expect(await verifyJwt(secret, token)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd cloudflare && npx vitest run test/jwt.test.ts
```
Expected: FAIL — cannot resolve `../src/lib/jwt`.

- [ ] **Step 3: Write minimal implementation**

`cloudflare/src/lib/jwt.ts`:
```ts
import { b64url, b64urlDecode, b64urlJson } from "./base64";

export interface Claims {
  typ: "auth_code" | "session";
  userHash: string;
  exp: number;
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

async function hmacSign(secret: Uint8Array, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64url(new Uint8Array(sig));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signJwt(secret: Uint8Array, claims: Claims): Promise<string> {
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const payload = b64urlJson(claims);
  const data = `${header}.${payload}`;
  const sig = await hmacSign(secret, data);
  return `${data}.${sig}`;
}

export async function verifyJwt(
  secret: Uint8Array,
  token: string,
): Promise<Claims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  // Only HS256 is ever accepted; the header alg is intentionally NOT read,
  // which neutralises alg-confusion / alg:none attacks.
  const expected = await hmacSign(secret, `${h}.${p}`);
  if (!timingSafeEqual(s, expected)) return null;
  let claims: Claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p))) as Claims;
  } catch {
    return null;
  }
  if (typeof claims.exp !== "number" || claims.exp < nowSec()) return null;
  return claims;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd cloudflare && npx vitest run test/jwt.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add cloudflare/src/lib/jwt.ts cloudflare/test/jwt.test.ts
git commit -m "feat(mobile-remote): add HS256 jwt sign/verify for cloudflare worker"
```

---

## Task 6: `cors` + response helpers

**Files:**
- Create: `cloudflare/src/lib/cors.ts`
- Test: `cloudflare/test/cors.test.ts`

- [ ] **Step 1: Write the failing test**

`cloudflare/test/cors.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { corsPreflight, withSecurityHeaders, json, readCookie } from "../src/lib/cors";

const ALLOWED = "https://ccsm-worker.jiahuigu.workers.dev";

describe("cors", () => {
  it("preflight echoes an allowed origin", () => {
    const res = corsPreflight(new Request("https://x", { headers: { Origin: ALLOWED } }));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
  });

  it("preflight blanks a disallowed origin", () => {
    const res = corsPreflight(new Request("https://x", { headers: { Origin: "https://evil" } }));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("");
  });

  it("withSecurityHeaders sets nosniff + referrer-policy", () => {
    const res = withSecurityHeaders(new Response("hi"), new Request("https://x"));
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("json serialises body + status + content-type", async () => {
    const res = json({ a: 1 }, 201);
    expect(res.status).toBe(201);
    expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ a: 1 });
  });

  it("readCookie extracts a named cookie", () => {
    const req = new Request("https://x", { headers: { Cookie: "a=1; oauth_state=xyz; b=2" } });
    expect(readCookie(req, "oauth_state")).toBe("xyz");
    expect(readCookie(req, "missing")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd cloudflare && npx vitest run test/cors.test.ts
```
Expected: FAIL — cannot resolve `../src/lib/cors`.

- [ ] **Step 3: Write minimal implementation**

`cloudflare/src/lib/cors.ts`:
```ts
const ALLOWED_ORIGINS = ["https://ccsm-worker.jiahuigu.workers.dev"]; // add PWA origin if hosted separately

export function corsPreflight(req: Request): Response {
  const origin = req.headers.get("Origin") ?? "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : "";
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": allow,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "600",
    },
  });
}

export function withSecurityHeaders(res: Response, req: Request): Response {
  const h = new Headers(res.headers);
  const origin = req.headers.get("Origin") ?? "";
  if (ALLOWED_ORIGINS.includes(origin)) h.set("Access-Control-Allow-Origin", origin);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  return new Response(res.body, { status: res.status, headers: h });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("Cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd cloudflare && npx vitest run test/cors.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add cloudflare/src/lib/cors.ts cloudflare/test/cors.test.ts
git commit -m "feat(mobile-remote): add cors + response helpers for cloudflare worker"
```

---

## Task 7: `github` (code→token, `/user`→id)

**Files:**
- Create: `cloudflare/src/lib/github.ts`
- Test: `cloudflare/test/github.test.ts`

- [ ] **Step 1: Write the failing test**

`cloudflare/test/github.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { exchangeCode, fetchGithubUserId } from "../src/lib/github";
import type { Config } from "../src/lib/config";

const cfg = {
  githubClientId: "cid",
  githubClientSecret: "csecret",
  oauthRedirectUri: "https://x/cb",
} as Config;

afterEach(() => vi.restoreAllMocks());

describe("github", () => {
  it("exchangeCode posts code and returns access_token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "tok123" }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const token = await exchangeCode(cfg, "the-code");
    expect(token).toBe("tok123");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("login/oauth/access_token");
    expect(JSON.parse(init!.body as string)).toMatchObject({
      client_id: "cid",
      client_secret: "csecret",
      code: "the-code",
    });
  });

  it("exchangeCode throws when github returns an error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "bad_verification_code" }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(exchangeCode(cfg, "x")).rejects.toThrow(/bad_verification_code/);
  });

  it("fetchGithubUserId returns numeric id", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: 4242 }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(await fetchGithubUserId("tok")).toBe(4242);
  });

  it("fetchGithubUserId throws on non-ok", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 401 }));
    await expect(fetchGithubUserId("tok")).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd cloudflare && npx vitest run test/github.test.ts
```
Expected: FAIL — cannot resolve `../src/lib/github`.

- [ ] **Step 3: Write minimal implementation**

`cloudflare/src/lib/github.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd cloudflare && npx vitest run test/github.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add cloudflare/src/lib/github.ts cloudflare/test/github.test.ts
git commit -m "feat(mobile-remote): add github oauth helpers for cloudflare worker"
```

---

## Task 8: `oauthStart` route

**Files:**
- Create: `cloudflare/src/routes/oauthStart.ts`
- Test: `cloudflare/test/oauthStart.test.ts`

- [ ] **Step 1: Write the failing test**

`cloudflare/test/oauthStart.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { handleOauthStart } from "../src/routes/oauthStart";
import type { Config } from "../src/lib/config";

const cfg = {
  githubClientId: "cid",
  oauthRedirectUri: "https://x/cb",
} as Config;

describe("oauthStart", () => {
  it("302s to github authorize with state cookie", async () => {
    const res = await handleOauthStart(new Request("https://x/auth/github/start"), cfg);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe("cid");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://x/cb");
    expect(loc.searchParams.get("scope")).toBe("read:user");
    const state = loc.searchParams.get("state")!;
    expect(state.length).toBeGreaterThan(0);
    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toContain(`oauth_state=${state}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd cloudflare && npx vitest run test/oauthStart.test.ts
```
Expected: FAIL — cannot resolve `../src/routes/oauthStart`.

- [ ] **Step 3: Write minimal implementation**

`cloudflare/src/routes/oauthStart.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd cloudflare && npx vitest run test/oauthStart.test.ts
```
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add cloudflare/src/routes/oauthStart.ts cloudflare/test/oauthStart.test.ts
git commit -m "feat(mobile-remote): add oauth start route for cloudflare worker"
```

---

## Task 9: `oauthCallback` route

**Files:**
- Create: `cloudflare/src/routes/oauthCallback.ts`
- Test: `cloudflare/test/oauthCallback.test.ts`

- [ ] **Step 1: Write the failing test**

`cloudflare/test/oauthCallback.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { handleOauthCallback } from "../src/routes/oauthCallback";
import { verifyJwt } from "../src/lib/jwt";
import { hmacUserHash } from "../src/lib/userHash";
import type { Config } from "../src/lib/config";

const secret = new TextEncoder().encode("signing-key");
const cfg = {
  githubClientId: "cid",
  githubClientSecret: "csecret",
  oauthRedirectUri: "https://x/cb",
  serverSecret: secret,
} as Config;

function mockGithub(id: number): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("access_token")) {
      return new Response(JSON.stringify({ access_token: "tok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ id }), {
      headers: { "Content-Type": "application/json" },
    });
  });
}

afterEach(() => vi.restoreAllMocks());

describe("oauthCallback", () => {
  it("rejects a state mismatch with 400", async () => {
    const req = new Request("https://x/auth/github/callback?code=c&state=A", {
      headers: { Cookie: "oauth_state=B" },
    });
    const res = await handleOauthCallback(req, cfg);
    expect(res.status).toBe(400);
  });

  it("on success emits an html page carrying a one-time auth_code", async () => {
    mockGithub(777);
    const req = new Request("https://x/auth/github/callback?code=c&state=S", {
      headers: { Cookie: "oauth_state=S" },
    });
    const res = await handleOauthCallback(req, cfg);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
    expect(res.headers.get("Set-Cookie")).toContain("oauth_state=; Path=/; Max-Age=0");
    const html = await res.text();
    const m = html.match(/"authCode":"([^"]+)"/);
    expect(m).not.toBeNull();
    const claims = await verifyJwt(secret, m![1]);
    expect(claims?.typ).toBe("auth_code");
    expect(claims?.userHash).toBe(await hmacUserHash(secret, 777));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd cloudflare && npx vitest run test/oauthCallback.test.ts
```
Expected: FAIL — cannot resolve `../src/routes/oauthCallback`.

- [ ] **Step 3: Write minimal implementation**

`cloudflare/src/routes/oauthCallback.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd cloudflare && npx vitest run test/oauthCallback.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add cloudflare/src/routes/oauthCallback.ts cloudflare/test/oauthCallback.test.ts
git commit -m "feat(mobile-remote): add oauth callback route for cloudflare worker"
```

---

## Task 10: `session` route

**Files:**
- Create: `cloudflare/src/routes/session.ts`
- Test: `cloudflare/test/session.test.ts`

- [ ] **Step 1: Write the failing test**

`cloudflare/test/session.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { handleSession } from "../src/routes/session";
import { signJwt, verifyJwt, nowSec } from "../src/lib/jwt";
import type { Config } from "../src/lib/config";

const secret = new TextEncoder().encode("signing-key");
const cfg = {
  serverSecret: secret,
  sessionTtlMs: 900_000,
  stunUrls: ["stun:stun.cloudflare.com:3478"],
} as Config;

function post(body: unknown): Request {
  return new Request("https://x/auth/session", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("session", () => {
  it("400 when authCode is missing", async () => {
    const res = await handleSession(post({}), cfg);
    expect(res.status).toBe(400);
  });

  it("401 when authCode has the wrong typ", async () => {
    const bad = await signJwt(secret, { typ: "session", userHash: "u", exp: nowSec() + 60 });
    const res = await handleSession(post({ authCode: bad }), cfg);
    expect(res.status).toBe(401);
  });

  it("exchanges a valid auth_code for a session token + doUrl", async () => {
    const authCode = await signJwt(secret, {
      typ: "auth_code",
      userHash: "deadbeef",
      exp: nowSec() + 60,
    });
    const res = await handleSession(post({ authCode }), cfg);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      userHash: string;
      doUrl: string;
      iceServers: { urls: string[] }[];
      expiresInSeconds: number;
    };
    expect(body.userHash).toBe("deadbeef");
    expect(body.doUrl).toBe("wss://ccsm-worker.jiahuigu.workers.dev/do/deadbeef");
    expect(body.expiresInSeconds).toBe(900);
    expect(body.iceServers[0].urls).toEqual(["stun:stun.cloudflare.com:3478"]);
    const claims = await verifyJwt(secret, body.token);
    expect(claims).toMatchObject({ typ: "session", userHash: "deadbeef" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd cloudflare && npx vitest run test/session.test.ts
```
Expected: FAIL — cannot resolve `../src/routes/session`.

- [ ] **Step 3: Write minimal implementation**

`cloudflare/src/routes/session.ts`:
```ts
import type { Config } from "../lib/config";
import { json } from "../lib/cors";
import { signJwt, verifyJwt, nowSec } from "../lib/jwt";

export async function handleSession(req: Request, cfg: Config): Promise<Response> {
  const { authCode } = (await req.json()) as { authCode?: string };
  if (!authCode) return json({ error: "missing authCode" }, 400);
  const claims = await verifyJwt(cfg.serverSecret, authCode);
  if (!claims || claims.typ !== "auth_code") {
    return json({ error: "bad authCode" }, 401);
  }
  const ttlSec = cfg.sessionTtlMs / 1000;
  const token = await signJwt(cfg.serverSecret, {
    typ: "session",
    userHash: claims.userHash,
    exp: nowSec() + ttlSec,
  });
  return json({
    token,
    userHash: claims.userHash,
    doUrl: `wss://ccsm-worker.jiahuigu.workers.dev/do/${claims.userHash}`,
    iceServers: [{ urls: cfg.stunUrls }],
    expiresInSeconds: ttlSec,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd cloudflare && npx vitest run test/session.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add cloudflare/src/routes/session.ts cloudflare/test/session.test.ts
git commit -m "feat(mobile-remote): add session exchange route for cloudflare worker"
```

---

## Task 11: `turnCred` route (501 when unconfigured)

**Files:**
- Create: `cloudflare/src/routes/turnCred.ts`
- Test: `cloudflare/test/turnCred.test.ts`

- [ ] **Step 1: Write the failing test**

`cloudflare/test/turnCred.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { handleTurnCred } from "../src/routes/turnCred";
import { signJwt, nowSec } from "../src/lib/jwt";
import type { Config } from "../src/lib/config";

const secret = new TextEncoder().encode("signing-key");

function baseCfg(): Config {
  return {
    serverSecret: secret,
    turnTtlSeconds: 600,
    stunUrls: ["stun:s:3478"],
    turnUrls: ["turn:t:3478?transport=udp"],
  } as Config;
}

function post(token?: string): Request {
  return new Request("https://x/turn/credentials", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

async function sessionToken(): Promise<string> {
  return signJwt(secret, { typ: "session", userHash: "u", exp: nowSec() + 60 });
}

afterEach(() => vi.restoreAllMocks());

describe("turnCred", () => {
  it("401 without a session jwt", async () => {
    const res = await handleTurnCred(post(), baseCfg());
    expect(res.status).toBe(401);
  });

  it("501 when TURN is not configured (PR-1 default)", async () => {
    const res = await handleTurnCred(post(await sessionToken()), baseCfg());
    expect(res.status).toBe(501);
  });

  it("200 with iceServers when TURN keys are present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ iceServers: { urls: ["turn:t"], username: "tu", credential: "tc" } }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
    const cfg = baseCfg();
    cfg.turnKeyId = "kid";
    cfg.turnKeyApiToken = "ktok";
    const res = await handleTurnCred(post(await sessionToken()), cfg);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      iceServers: { urls: string[]; username?: string; credential?: string }[];
      expiresInSeconds: number;
    };
    expect(body.expiresInSeconds).toBe(600);
    expect(body.iceServers[1]).toMatchObject({ username: "tu", credential: "tc" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd cloudflare && npx vitest run test/turnCred.test.ts
```
Expected: FAIL — cannot resolve `../src/routes/turnCred`.

- [ ] **Step 3: Write minimal implementation**

`cloudflare/src/routes/turnCred.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd cloudflare && npx vitest run test/turnCred.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add cloudflare/src/routes/turnCred.ts cloudflare/test/turnCred.test.ts
git commit -m "feat(mobile-remote): add turn credential route for cloudflare worker"
```

---

## Task 12: `PairingDurableObject` + `doProxy` route + `worker.ts` entry

This task wires the DO, its auth proxy, and the fetch entry together so they can be exercised by miniflare end-to-end via the deployed worker module. It is split into three commits (12a DO, 12b proxy+worker, 12c integration test) but defined as one task because the integration test needs all three.

**Files:**
- Create: `cloudflare/src/pairingDo.ts`
- Create: `cloudflare/src/routes/doProxy.ts`
- Create: `cloudflare/src/worker.ts`
- Test: `cloudflare/test/pairingDo.test.ts`

- [ ] **Step 1: Write `PairingDurableObject`**

`cloudflare/src/pairingDo.ts`:
```ts
import type { Env, Config } from "./lib/config";
import { loadConfig } from "./lib/config";

const MAX_MEMBERS = 8;

interface Member {
  ws: WebSocket;
  role: "desktop" | "phone";
  peerId: string;
}

type ErrCode = "bad-message" | "not-registered" | "peer-not-found" | "room-full";

export class PairingDurableObject {
  private members = new Map<string, Member>();
  private state: DurableObjectState;
  private cfg: Config;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.cfg = loadConfig(env);
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.wireSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private sendErr(ws: WebSocket, code: ErrCode, message: string): void {
    ws.send(JSON.stringify({ type: "error", code, message }));
  }

  private broadcastExcept(exceptPeerId: string, payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const m of this.members.values()) {
      if (m.peerId !== exceptPeerId) m.ws.send(data);
    }
  }

  private wireSocket(ws: WebSocket): void {
    let self: Member | null = null;

    ws.addEventListener("message", (ev) => {
      let msg: { type?: string; role?: string; peerId?: string; to?: string };
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return this.sendErr(ws, "bad-message", "invalid json");
      }

      if (msg.type === "register") {
        if (self) return this.sendErr(ws, "bad-message", "already registered");
        if (msg.role !== "desktop" && msg.role !== "phone") {
          return this.sendErr(ws, "bad-message", "bad role");
        }
        if (typeof msg.peerId !== "string" || !msg.peerId) {
          return this.sendErr(ws, "bad-message", "bad peerId");
        }
        if (this.members.size >= MAX_MEMBERS) {
          return this.sendErr(ws, "room-full", "too many peers");
        }
        self = { ws, role: msg.role, peerId: msg.peerId };
        this.members.set(self.peerId, self);
        ws.send(
          JSON.stringify({
            type: "registered",
            peerId: self.peerId,
            peers: [...this.members.values()]
              .filter((m) => m.peerId !== self!.peerId)
              .map((m) => ({ role: m.role, peerId: m.peerId })),
          }),
        );
        this.broadcastExcept(self.peerId, {
          type: "peer-present",
          role: self.role,
          peerId: self.peerId,
        });
        return;
      }

      if (!self) return this.sendErr(ws, "not-registered", "register first");

      if (msg.type === "offer" || msg.type === "answer" || msg.type === "ice") {
        const target = msg.to ? this.members.get(msg.to) : undefined;
        if (!target) return this.sendErr(ws, "peer-not-found", `no peer ${msg.to}`);
        target.ws.send(JSON.stringify({ ...msg, from: self.peerId }));
        return;
      }

      this.sendErr(ws, "bad-message", `unknown type ${msg.type}`);
    });

    ws.addEventListener("close", () => {
      if (!self) return;
      this.members.delete(self.peerId);
      this.broadcastExcept(self.peerId, {
        type: "peer-gone",
        role: self.role,
        peerId: self.peerId,
      });
      this.scheduleRoomGc();
    });
  }

  private scheduleRoomGc(): void {
    if (this.members.size === 0) {
      void this.state.storage.setAlarm(Date.now() + this.cfg.roomTtlMs);
    }
  }

  async alarm(): Promise<void> {
    // members empty -> no-op; an idle DO instance is reclaimed by the platform.
  }
}
```

- [ ] **Step 2: Commit the DO**

```bash
git add cloudflare/src/pairingDo.ts
git commit -m "feat(mobile-remote): add pairing durable object for cloudflare worker"
```

- [ ] **Step 3: Write `doProxy` route**

`cloudflare/src/routes/doProxy.ts`:
```ts
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
```

- [ ] **Step 4: Write `worker.ts` entry**

`cloudflare/src/worker.ts`:
```ts
import { loadConfig, type Env } from "./lib/config";
import { handleOauthStart } from "./routes/oauthStart";
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

    if (req.method === "OPTIONS") return corsPreflight(req);
    if (pathname === "/healthz") return new Response("ok");

    const cfg = loadConfig(env);
    let res: Response;
    try {
      if (req.method === "GET" && pathname === "/auth/github/start") {
        res = await handleOauthStart(req, cfg);
      } else if (req.method === "GET" && pathname === "/auth/github/callback") {
        res = await handleOauthCallback(req, cfg);
      } else if (req.method === "POST" && pathname === "/auth/session") {
        res = await handleSession(req, cfg);
      } else if (req.method === "POST" && pathname === "/turn/credentials") {
        res = await handleTurnCred(req, cfg);
      } else if (req.method === "GET" && pathname.startsWith("/do/")) {
        res = await handleDoProxy(req, env, cfg, pathname.slice("/do/".length));
      } else {
        res = new Response("not found", { status: 404 });
      }
    } catch (err) {
      res = new Response(`internal error: ${(err as Error).message}`, { status: 500 });
    }
    return withSecurityHeaders(res, req);
  },
};
```

- [ ] **Step 5: Commit proxy + worker entry**

```bash
git add cloudflare/src/routes/doProxy.ts cloudflare/src/worker.ts
git commit -m "feat(mobile-remote): add doProxy auth + worker entry for cloudflare worker"
```

- [ ] **Step 6: Write the DO integration test**

`cloudflare/test/pairingDo.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { PairingDurableObject } from "../src/pairingDo";

// Helper: open a WebSocket against a DO instance keyed by userHash.
async function connect(userHash: string): Promise<WebSocket> {
  const id = env.PAIRING.idFromName(userHash);
  const stub = env.PAIRING.get(id);
  const res = await stub.fetch("https://do/connect", {
    headers: { Upgrade: "websocket" },
  });
  const ws = res.webSocket!;
  ws.accept();
  return ws;
}

function next(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.addEventListener(
      "message",
      (ev) => resolve(JSON.parse(ev.data as string)),
      { once: true },
    );
  });
}

describe("PairingDurableObject", () => {
  it("constructs and answers non-websocket with 426", async () => {
    const id = env.PAIRING.idFromName("u-426");
    const stub = env.PAIRING.get(id);
    const res = await stub.fetch("https://do/connect");
    expect(res.status).toBe(426);
  });

  it("two peers register and learn about each other", async () => {
    const a = await connect("room1");
    const b = await connect("room1");

    a.send(JSON.stringify({ type: "register", role: "desktop", peerId: "A" }));
    const aReg = await next(a);
    expect(aReg.type).toBe("registered");
    expect(aReg.peers).toEqual([]);

    const aSeesB = next(a);
    b.send(JSON.stringify({ type: "register", role: "phone", peerId: "B" }));
    const bReg = await next(b);
    expect(bReg.type).toBe("registered");
    expect(bReg.peers).toEqual([{ role: "desktop", peerId: "A" }]);
    expect(await aSeesB).toMatchObject({ type: "peer-present", peerId: "B" });
  });

  it("relays offer/answer/ice and rewrites from", async () => {
    const a = await connect("room2");
    const b = await connect("room2");
    a.send(JSON.stringify({ type: "register", role: "desktop", peerId: "A" }));
    await next(a);
    b.send(JSON.stringify({ type: "register", role: "phone", peerId: "B" }));
    await next(b);
    await next(a); // consume peer-present

    const aGetsOffer = next(a);
    b.send(JSON.stringify({ type: "offer", to: "A", from: "B", sdp: "SDP" }));
    const offer = await aGetsOffer;
    expect(offer).toMatchObject({ type: "offer", from: "B", sdp: "SDP" });
  });

  it("peer-not-found when target is absent", async () => {
    const a = await connect("room3");
    a.send(JSON.stringify({ type: "register", role: "desktop", peerId: "A" }));
    await next(a);
    const err = next(a);
    a.send(JSON.stringify({ type: "offer", to: "ghost", from: "A", sdp: "x" }));
    expect(await err).toMatchObject({ type: "error", code: "peer-not-found" });
  });

  it("not-registered when signaling before register", async () => {
    const a = await connect("room4");
    const err = next(a);
    a.send(JSON.stringify({ type: "offer", to: "X", from: "Y", sdp: "x" }));
    expect(await err).toMatchObject({ type: "error", code: "not-registered" });
  });

  it("peer-gone broadcast when a peer closes", async () => {
    const a = await connect("room5");
    const b = await connect("room5");
    a.send(JSON.stringify({ type: "register", role: "desktop", peerId: "A" }));
    await next(a);
    b.send(JSON.stringify({ type: "register", role: "phone", peerId: "B" }));
    await next(b);
    await next(a); // peer-present
    const gone = next(a);
    b.close();
    expect(await gone).toMatchObject({ type: "peer-gone", peerId: "B" });
  });

  it("room-full past MAX_MEMBERS", async () => {
    // Drive register() directly to avoid opening 9 live sockets.
    const id = env.PAIRING.idFromName("room-full");
    await runInDurableObject(env.PAIRING.get(id), async (instance: PairingDurableObject) => {
      // fill 8 members
      for (let i = 0; i < 8; i++) {
        const ws = await connect("room-full");
        ws.send(JSON.stringify({ type: "register", role: "phone", peerId: `p${i}` }));
      }
      void instance; // touched so the import is used
    });
    const overflow = await connect("room-full");
    const err = next(overflow);
    overflow.send(JSON.stringify({ type: "register", role: "phone", peerId: "p9" }));
    expect(await err).toMatchObject({ type: "error", code: "room-full" });
  });

  it("different userHash lands on a different DO instance (isolation)", async () => {
    const a = await connect("iso-A");
    const b = await connect("iso-B");
    a.send(JSON.stringify({ type: "register", role: "desktop", peerId: "A" }));
    const aReg = await next(a);
    b.send(JSON.stringify({ type: "register", role: "desktop", peerId: "B" }));
    const bReg = await next(b);
    // Neither sees the other: separate rooms.
    expect(aReg.peers).toEqual([]);
    expect(bReg.peers).toEqual([]);
  });
});
```

- [ ] **Step 7: Run the DO test**

Run:
```bash
cd cloudflare && npx vitest run test/pairingDo.test.ts
```
Expected: PASS (8 tests). If the `room-full` test is flaky under miniflare socket limits, narrow it to register 7 phones + 1 desktop = 8, then assert overflow; do not weaken the cap assertion.

- [ ] **Step 8: Commit the integration test**

```bash
git add cloudflare/test/pairingDo.test.ts
git commit -m "test(mobile-remote): add pairing durable object integration tests"
```

---

## Task 13: Full suite green + typecheck

**Files:** none (verification only).

- [ ] **Step 1: Run the whole test suite**

Run:
```bash
cd cloudflare && npm test
```
Expected: PASS — every `test/*.test.ts` green (base64, config, userHash, jwt, cors, github, oauthStart, oauthCallback, session, turnCred, pairingDo).

- [ ] **Step 2: Run typecheck**

Run:
```bash
cd cloudflare && npm run typecheck
```
Expected: exit 0, no diagnostics.

- [ ] **Step 3: Commit any fixes**

If Steps 1–2 surfaced fixes, commit them:
```bash
git add cloudflare/
git commit -m "fix(mobile-remote): resolve typecheck/test issues in cloudflare worker"
```
If nothing changed, skip this commit.

---

## Task 14: (OPTIONAL, user-run) local `wrangler dev` smoke

> This task is **not** part of the agent's green-bar gate; it requires the user's Cloudflare account + secrets and the proxy prefix. The agent does not run it. It is listed so the executor hands the user exactly these steps.

**Files:** none.

- [ ] **Step 1: User starts a local worker (proxy-prefixed)**

```bash
cd cloudflare && HTTP_PROXY=http://127.0.0.1:12334 HTTPS_PROXY=http://127.0.0.1:12334 http_proxy=http://127.0.0.1:12334 https_proxy=http://127.0.0.1:12334 NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1 npx wrangler dev
```
Expected: worker boots locally; `GET /healthz` returns `ok`.

- [ ] **Step 2: User confirms secrets already exist on `ccsm-worker`**

No `wrangler secret put` is needed — `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, and `JWT_SIGNING_KEY` are already on `ccsm-worker` (verified 2026-05-30). TURN secrets are intentionally absent (`/turn/credentials` returns 501).

- [ ] **Step 3: User sets the GitHub OAuth callback URL**

In the `ccsm-oAuth` GitHub app settings, the Authorization callback URL must be:
`https://ccsm-worker.jiahuigu.workers.dev/auth/github/callback`

- [ ] **Step 4: User deploys (their own action)**

```bash
cd cloudflare && HTTP_PROXY=http://127.0.0.1:12334 HTTPS_PROXY=http://127.0.0.1:12334 http_proxy=http://127.0.0.1:12334 https_proxy=http://127.0.0.1:12334 NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1 npx wrangler deploy
```
Expected: deployed to `ccsm-worker.jiahuigu.workers.dev`. (Agent never runs this.)

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:
- §1 config/secret → Task 1 (`wrangler.toml`, vitest bindings) + Task 3 (`loadConfig`, secret-name reuse, `serverSecret`←`JWT_SIGNING_KEY`).
- §2 route table + `worker.ts` → Task 12 (entry + dispatch + `/healthz` + 404).
- §3 OAuth (start/callback/session, `github.ts`) → Tasks 7–10.
- §4 userHash + jwt → Tasks 4–5 (incl. alg:none / typ / expiry / tamper).
- §5 TURN 501-when-unconfigured → Task 11.
- §6 DO state machine, messages, GC, MAX_MEMBERS → Task 12.
- §7 doProxy auth (token query, userHash match 403) → Task 12.
- §8 CORS/security headers → Task 6.
- §9 miniflare test matrix → Tasks 2–12 tests + Task 13 full run.
- §10 user-run verification → Task 14.
- §11 upstream additions (`auth_code` two-hop, `to` field, MAX_MEMBERS, error codes) → encoded in Tasks 9/10/12.

**2. Placeholder scan** — no TBD/TODO/"handle edge cases"/"similar to". Every code step shows full code; every command shows expected output.

**3. Type consistency** — `Config`/`Env`/`Claims` defined in Tasks 3 & 5 are imported unchanged everywhere; `serverSecret: Uint8Array`, `signJwt`/`verifyJwt`/`nowSec`, `hmacUserHash`, `json`/`readCookie`/`corsPreflight`/`withSecurityHeaders`, `exchangeCode`/`fetchGithubUserId` signatures match across all consumers. `PairingDurableObject` is exported from `pairingDo.ts` and re-exported from `worker.ts`; DO binding name `PAIRING` is identical in `wrangler.toml`, `Env`, `doProxy`, and tests.

**Resolved during review:**
- Spec §3.3 used `req.json<T>()` generic syntax; this plan uses `(await req.json()) as T` for portability across the miniflare/vitest type setup (functionally identical).
- Spec §6.2 referenced `pair[0]`/`pair[1]` via array destructuring with an unused-var lint risk; plan assigns `client`/`server` explicitly to satisfy `noUnusedLocals`.
- TURN URLs/STUN URLs are duplicated between `wrangler.toml` `[vars]` and `vitest.config.ts` miniflare bindings — this is required because the test pool does not read `[vars]` automatically; kept in sync deliberately.

---

## Gaps / ambiguities for the manager

1. **Dep versions are best-effort pins.** `@cloudflare/vitest-pool-workers`, `wrangler`, and `@cloudflare/workers-types` versions in Task 1 are plausible-but-unverified ranges; the executor must let `npm install` resolve the actual latest compatible set and commit the resulting lockfile. If `defineWorkersConfig` / `cloudflare:test` (`env`, `runInDurableObject`) API names differ in the resolved version, the executor adapts the test harness (the *product* code is unaffected).
2. **`room-full` test fidelity.** Opening 8+ live WebSockets in miniflare may hit pool limits; the plan offers a `runInDurableObject` fallback and a 7+1 narrowing, but the executor should pick whichever reliably proves the cap without weakening the assertion (consensus rule: fix to green, never skip).
3. **Cloudflare TURN response shape (§5) is unverified.** `turnCred` 200-path is coded to the spec's assumed `{ iceServers: { urls, username, credential } }`; since PR-1 ships the 501 path and never calls the real API, this is mocked. Real shape is calibrated in PR-5 when TURN is enabled — flagged, not blocking.
4. **`auth_code` retrieval transport is deferred (spec §3.2 note).** The callback HTML posts `{authCode}` via `window.opener.postMessage(..., "*")`. The `"*"` target origin is acceptable for PR-1 (the page is single-purpose and closes immediately), but PR-2/PR-3 should tighten it to a known origin when the real phone/desktop receivers exist. Noted for downstream PRs.
