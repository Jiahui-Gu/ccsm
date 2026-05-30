# Mobile Remote PR-1 — Cloudflare 信令 + GitHub 鉴权 Detail 设计

> **上游**:high-level 三角色拓扑(冻结)见
> [`2026-05-30-mobile-remote-public-internet-highlevel.md`](./2026-05-30-mobile-remote-public-internet-highlevel.md);
> 跨端 mid/detail(组件分解、握手时序、信令协议骨架、安全)见
> [`2026-05-30-mobile-remote-public-internet-detail.md`](./2026-05-30-mobile-remote-public-internet-detail.md)。
>
> **本文件**:仅 PR-1(Cloudflare Worker + Durable Object + GitHub OAuth + 信令转发)
> 的**可实现粒度** detail —— Worker 路由表、DO 状态机与方法、WebSocket 消息确切
> JSON schema、OAuth callback 完整 HTTP 流程、session JWT 结构与签名、TURN 短期
> 凭据签发算法、`wrangler.toml` 结构、secret 注入。**不含**桌面/手机代码(那是
> PR-2/PR-3)。
>
> **外部资源决策**(锁定,见 memory `mobile-remote-cloudflare-decisions` /
> `mobile-remote-github-oauth`):
> - 用户本地 `wrangler login` + `wrangler deploy`;agent 只写代码 + 可本地 `wrangler dev` 验证。
> - secret 一律 `wrangler secret put`,**绝不进 repo、绝不下发客户端**。
> - **复用已存在的 `ccsm-worker`**(2026-05-30 决策):该 Worker 上已 put 好
>   `GITHUB_OAUTH_CLIENT_SECRET`(= OAuth App `ccsm-oAuth` 的 client secret)、
>   `JWT_SIGNING_KEY`(HMAC userHash + JWT 签名,代替原设计的 `SERVER_SECRET`)、
>   `GITHUB_OAUTH_CLIENT_ID`。PR-1 代码直接读这些名字,**用户无需重新 put 任何 secret**。
>   旧的 `JWT_REFRESH_SIGNING_KEY` 是遗留,PR-1 不读。
> - GitHub client id `Ov23liICal7F5NDZO1r1` 是公开值(也已作为 secret `GITHUB_OAUTH_CLIENT_ID` 存在)。
> - 子域 `ccsm-worker.jiahuigu.workers.dev`。

---

## 0. PR-1 边界

**做**:整套 Cloudflare 侧 —— OAuth 终止、按 GitHub 用户撮合、SDP/ICE 转发、TURN
凭据签发端点(代码预留,PR-1 不绑卡不配 key,见下)。纯 Cloudflare,可用
`vitest` + `@cloudflare/vitest-pool-workers`(miniflare)本地单测,`wrangler dev` 手动验证。

**TURN 降级(2026-05-30 决策)**:Cloudflare Realtime/TURN 需先绑付款方式,PR-1
**不绑卡、不配 TURN key**,只走 GitHub 鉴权 + 信令 + WebRTC 直连(STUN 免费打洞)。
`/turn/credentials` 端点保留但未配 key 时返回 501(§5);真机打洞失败再补(原 PR-5)。

**不做**:
- 桌面 `signalingClient` / `desktopPeer` / `mobileRemoteController`(PR-2)。
- 手机 `phonePeer` / `phoneSignaling` / 登录页 UI(PR-3)。
- 真实 werift / 浏览器 RTCPeerConnection 联调(PR-4)。
- TURN 启用 + 真机回退验证(PR-5)。

**交付物**(全部落在 repo 的 `cloudflare/` 子目录):
```
cloudflare/
  wrangler.toml
  package.json
  tsconfig.json
  src/
    worker.ts          # 入口:路由分发
    routes/
      oauthStart.ts    # GET  /auth/github/start
      oauthCallback.ts # GET  /auth/github/callback
      session.ts       # POST /auth/session   (用 OAuth 结果换 session JWT)
      turnCred.ts      # POST /turn/credentials
      doProxy.ts       # GET  /do/:userHash   (Upgrade: websocket → 转给 DO)
    lib/
      jwt.ts           # HS256 sign/verify(session JWT)
      userHash.ts      # HMAC-SHA256(SERVER_SECRET, githubUserId)
      github.ts        # code→token、GET /user
      cors.ts          # 统一 CORS / 安全响应头
      config.ts        # 从 env 读取并校验配置
    pairingDo.ts       # Durable Object:配对房间 + 信令转发
  test/
    userHash.test.ts
    jwt.test.ts
    oauth.test.ts
    pairingDo.test.ts
    turnCred.test.ts
```

---

## 1. 配置与 secret 注入

### 1.1 `wrangler.toml` 结构

```toml
name = "ccsm-worker"                # → ccsm-worker.jiahuigu.workers.dev
main = "src/worker.ts"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]   # crypto.subtle 已是全局,不强依赖;保留以备 lib 用

[[durable_objects.bindings]]
name = "PAIRING"                    # env.PAIRING → DurableObjectNamespace
class_name = "PairingDurableObject"

[[migrations]]
tag = "v1"
new_classes = ["PairingDurableObject"]

# 公开配置(可入 repo)
[vars]
OAUTH_REDIRECT_URI = "https://ccsm-worker.jiahuigu.workers.dev/auth/github/callback"
SESSION_TTL_SECONDS = "900"        # 15 min
TURN_TTL_SECONDS = "600"           # 10 min
ROOM_TTL_SECONDS = "60"            # DO 双方断开后存活
TURN_URLS = "turn:turn.cloudflare.com:3478?transport=udp,turns:turn.cloudflare.com:5349?transport=tcp"
STUN_URLS = "stun:stun.cloudflare.com:3478"

# secret(NEVER in repo;已在 ccsm-worker 上 put 好,用户无需重做):
#   GITHUB_OAUTH_CLIENT_ID      GitHub OAuth app client id(公开值,但已作 secret 存在)
#   GITHUB_OAUTH_CLIENT_SECRET  GitHub OAuth app client secret(= ccsm-oAuth 的 secret)
#   JWT_SIGNING_KEY             HMAC userHash + JWT 签名的服务器密钥(原设计的 SERVER_SECRET)
#   TURN_KEY_ID                 Cloudflare TURN key id(可选 — PR-1 不绑卡、不配 TURN)
#   TURN_KEY_API_TOKEN          Cloudflare TURN API token(可选 — 同上,真机打洞失败再补)
#   (遗留 JWT_REFRESH_SIGNING_KEY 不读)
```

### 1.2 `Env` 类型(`src/lib/config.ts`)

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
  // secrets(已在 ccsm-worker 上 put 好)
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  JWT_SIGNING_KEY: string;         // HMAC userHash + JWT 签名(原 SERVER_SECRET)
  TURN_KEY_ID?: string;            // 可选:PR-1 不绑卡、不配 TURN(见 §5)
  TURN_KEY_API_TOKEN?: string;     // 可选:同上
}

export interface Config {
  githubClientId: string;
  githubClientSecret: string;
  oauthRedirectUri: string;
  serverSecret: Uint8Array;     // JWT_SIGNING_KEY utf8 → bytes
  sessionTtlMs: number;
  turnTtlSeconds: number;
  roomTtlMs: number;
  turnUrls: string[];
  stunUrls: string[];
  turnKeyId?: string;           // 可选:未配 TURN 时为 undefined
  turnKeyApiToken?: string;     // 可选:同上
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

`loadConfig` 在每个 route handler 开头调用;缺 secret 时 `throw`,worker 返回 500,
便于本地 `wrangler dev` 一眼发现没灌 secret。

---

## 2. Worker 路由表

`src/worker.ts` 是唯一 fetch 入口,按 `method + pathname` 分发。

| Method | Path | Handler | 鉴权 | 说明 |
|---|---|---|---|---|
| GET | `/auth/github/start` | `oauthStart` | 无 | 302 跳 GitHub 授权页,带 `state` |
| GET | `/auth/github/callback` | `oauthCallback` | 无 | GitHub 回调,code→token→user,签发 JWT |
| POST | `/auth/session` | `session` | 无(用回调发的一次性 code) | 见 §3.3,换长效 session JWT |
| POST | `/turn/credentials` | `turnCred` | session JWT | 签发短期 TURN cred |
| GET | `/do/:userHash` | `doProxy` | session JWT(`?token=` 或 header) | WebSocket Upgrade → 转 DO |
| GET | `/healthz` | inline | 无 | `200 ok`,部署探活 |
| * | 其它 | inline | — | `404` |

### 2.1 `worker.ts` 骨架

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

---

## 3. GitHub OAuth 完整流程

### 3.1 `GET /auth/github/start`

两端(桌面/手机)都打开此 URL 开始登录。

1. 生成 `state`(随机 16 字节 → base64url),用于防 CSRF。
2. 把 `state` 放进一个**短期、HttpOnly、SameSite=Lax** cookie `oauth_state`(TTL 5min)。
3. 302 跳到:
   ```
   https://github.com/login/oauth/authorize
     ?client_id=<GITHUB_CLIENT_ID>
     &redirect_uri=<OAUTH_REDIRECT_URI>
     &scope=read:user
     &state=<state>
   ```
   scope 只要 `read:user`(拿数字 id 足够,最小权限)。

```ts
export async function handleOauthStart(req: Request, cfg: Config): Promise<Response> {
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
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

### 3.2 `GET /auth/github/callback`

GitHub 带 `?code=...&state=...` 回来。

1. 校验 `state` == cookie `oauth_state`(不等 → 400)。
2. `code` 换 access token(`github.exchangeCode`)。
3. 用 token 调 `GET https://api.github.com/user` 取 `id`(数字)。
4. `userHash = HMAC-SHA256(SERVER_SECRET, String(githubUserId))` → hex。
5. **不直接发长效 JWT**,而是签发一个**一次性 `auth_code`**(短 JWT,TTL 60s,
   含 `userHash`,`typ:"auth_code"`),作为 HTML 页面里的 `window.opener` postMessage
   或重定向 fragment 交给前端。前端再 `POST /auth/session` 用它换长效 session JWT。
   - 这一跳让浏览器端不暴露在 query string 里长期持有凭据;也让桌面端(werift 无浏览器)
     能用同一 callback:桌面端打开系统浏览器登录,callback 页把 `auth_code` 显示/回传给
     桌面进程(PR-2 决定具体回传方式:loopback http 或手动粘贴)。
6. 清除 `oauth_state` cookie。

```ts
export async function handleOauthCallback(req: Request, cfg: Config): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = readCookie(req, "oauth_state");
  if (!code || !state || state !== cookieState) {
    return new Response("invalid oauth state", { status: 400 });
  }
  const token = await exchangeCode(cfg, code);          // github.ts
  const githubUserId = await fetchGithubUserId(token);  // github.ts, GET /user → id
  const userHash = await hmacUserHash(cfg.serverSecret, githubUserId);
  const authCode = await signJwt(cfg.serverSecret, {
    typ: "auth_code",
    userHash,
    exp: nowSec() + 60,
  });
  // callback 页:把 authCode 交回打开它的窗口(手机 PWA)或显示给桌面
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

> `renderCallbackHtml` 是极简内联页:`window.opener.postMessage({authCode}, origin)`
> 然后 `window.close()`;桌面 loopback 场景则 `fetch('http://127.0.0.1:<port>/cb?...')`。
> 具体回传细节属 PR-2/PR-3,这里只保证 callback 产出 `auth_code`。

### 3.3 `POST /auth/session`

Body: `{ "authCode": "<one-time jwt>" }`。

1. verify `authCode`(HS256,`typ==="auth_code"`,未过期)。
2. 取其中 `userHash`,签发**长效 session JWT**(TTL `SESSION_TTL_SECONDS`=15min):
   ```json
   { "typ": "session", "userHash": "<hex>", "exp": <nowSec+900> }
   ```
3. 返回:
   ```json
   {
     "token": "<session jwt>",
     "userHash": "<hex>",
     "doUrl": "wss://ccsm-worker.jiahuigu.workers.dev/do/<userHash>",
     "iceServers": [
       { "urls": ["stun:stun.cloudflare.com:3478"] }
     ],
     "expiresInSeconds": 900
   }
   ```
   TURN 不在这里发(短期、按需,见 §5),只先给 STUN。

```ts
export async function handleSession(req: Request, cfg: Config): Promise<Response> {
  const { authCode } = await req.json<{ authCode?: string }>();
  if (!authCode) return json({ error: "missing authCode" }, 400);
  const claims = await verifyJwt(cfg.serverSecret, authCode);
  if (!claims || claims.typ !== "auth_code") return json({ error: "bad authCode" }, 401);
  const token = await signJwt(cfg.serverSecret, {
    typ: "session",
    userHash: claims.userHash,
    exp: nowSec() + cfg.sessionTtlMs / 1000,
  });
  return json({
    token,
    userHash: claims.userHash,
    doUrl: `wss://ccsm-worker.jiahuigu.workers.dev/do/${claims.userHash}`,
    iceServers: [{ urls: cfg.stunUrls }],
    expiresInSeconds: cfg.sessionTtlMs / 1000,
  });
}
```

### 3.4 `src/lib/github.ts`

```ts
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
  const data = await res.json<{ access_token?: string; error?: string }>();
  if (!data.access_token) throw new Error(`github token exchange failed: ${data.error}`);
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
  const data = await res.json<{ id: number }>();
  if (typeof data.id !== "number") throw new Error("github /user missing id");
  return data.id;
}
```

> access token 用完即弃 —— 只为取 `id`,不存、不下发(memory:最小权限)。

---

## 4. userHash 与 session JWT(`lib/userHash.ts`, `lib/jwt.ts`)

### 4.1 userHash

```ts
export async function hmacUserHash(serverSecret: Uint8Array, githubUserId: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", serverSecret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(githubUserId)));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
```

- 输入是数字 `id`(`String(id)`),非 username —— 改名稳定(上游 §4.3)。
- 输出 64 hex,作为 DO 实例名 + URL path 段(URL 安全)。

### 4.2 session JWT(HS256,自签自验,不引第三方库)

```ts
interface Claims { typ: "auth_code" | "session"; userHash: string; exp: number; }

export async function signJwt(secret: Uint8Array, claims: Claims): Promise<string> {
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const payload = b64urlJson(claims);
  const data = `${header}.${payload}`;
  const sig = await hmacSign(secret, data);
  return `${data}.${sig}`;
}

export async function verifyJwt(secret: Uint8Array, token: string): Promise<Claims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = await hmacSign(secret, `${h}.${p}`);
  if (!timingSafeEqual(s, expected)) return null;
  const claims = JSON.parse(b64urlDecode(p)) as Claims;
  if (typeof claims.exp !== "number" || claims.exp < nowSec()) return null;
  return claims;
}
```

- `hmacSign` = HMAC-SHA256 → base64url(`crypto.subtle`)。
- `timingSafeEqual` 比较签名,防时序泄露。
- 只接受 `alg:"HS256"`,verify 不读 header 的 alg(防 alg-confusion / `none` 攻击)。

---

## 5. TURN 短期凭据签发 `POST /turn/credentials`

> **PR-1 不部署 TURN。** 2026-05-30 决策:Cloudflare Realtime/TURN 需先绑付款方式,
> PR-1 不绑卡、不配 TURN key,只走直连(STUN 免费打洞)。本端点代码预留,但未配
> `TURN_KEY_ID`/`TURN_KEY_API_TOKEN` 时返回 **501**,客户端据此知道只有 STUN 可用。
> 真机打洞失败时(原 PR-5)用户再绑卡、`wrangler secret put` 两个 TURN secret 即可启用,
> 无需改代码。

鉴权:`Authorization: Bearer <session jwt>`。

Cloudflare Calls TURN 的标准做法:用 `TURN_KEY_ID` + `TURN_KEY_API_TOKEN` 调
Cloudflare API 换一组短期 `username`/`credential`。

```ts
export async function handleTurnCred(req: Request, cfg: Config): Promise<Response> {
  const claims = await authSession(req, cfg);          // 解 Bearer JWT,typ==="session"
  if (!claims) return json({ error: "unauthorized" }, 401);

  // PR-1:未配 TURN → 501,客户端回退到纯 STUN
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
  const cred = await res.json<{ iceServers: { urls: string[]; username: string; credential: string } }>();

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

- 凭据短期(`TURN_TTL_SECONDS`=10min),客户端在打洞失败 / renegotiate 时按需拉。
- TURN key / API token 只在 Worker,绝不下发(memory 安全决策)。
- 若 Cloudflare TURN 接口形态与此略有出入,本函数是唯一适配点;`wrangler dev` 实测校准。

---

## 6. Durable Object:`PairingDurableObject`

DO 实例 = 一个 GitHub 用户的配对房间。`idFromName(userHash)` 保证同一用户两端落同一实例。

### 6.1 内部状态

```ts
interface Member {
  ws: WebSocket;
  role: "desktop" | "phone";
  peerId: string;       // 端自报的随机 id,区分多 phone
}

class PairingDurableObject {
  private members = new Map<string, Member>();   // key = peerId
  private state: DurableObjectState;
  private cfg: Config;
}
```

DO **不持久化** SDP/ICE(上游 §1.1 约束:转发即弃)。`members` 是纯内存;DO 被驱逐
后房间自然消失,重连即重建。

### 6.2 入口 `fetch`(由 Worker `doProxy` 转入,已是 WebSocket Upgrade)

```ts
async fetch(req: Request): Promise<Response> {
  if (req.headers.get("Upgrade") !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  this.wireSocket(server);          // 见 §6.4
  return new Response(null, { status: 101, webSocket: client });
}
```

> Worker `doProxy` 在转给 DO 之前**已校验 session JWT**(§7),并校验 JWT 里的
> `userHash` == URL path 的 `userHash`(防越权连别人的房)。DO 只需信任已转入的连接。

### 6.3 信令 WebSocket 消息 schema(确切)

所有消息是 JSON 文本帧。`peerId` 由端在 `register` 自报(随机 uuid)。

**端 → DO**

```jsonc
// 进房登记
{ "type": "register", "role": "desktop" | "phone", "peerId": "<uuid>" }

// WebRTC offer(仅 phone 发)
{ "type": "offer", "to": "<desktop peerId>", "from": "<phone peerId>", "sdp": "<sdp string>" }

// WebRTC answer(仅 desktop 发)
{ "type": "answer", "to": "<phone peerId>", "from": "<desktop peerId>", "sdp": "<sdp string>" }

// trickle ICE(双向)
{ "type": "ice", "to": "<peerId>", "from": "<peerId>",
  "candidate": "<candidate>", "sdpMid": "<mid|null>", "sdpMLineIndex": <num|null> }
```

**DO → 端**

```jsonc
// register 成功 ack,附带当前在房对端列表
{ "type": "registered", "peerId": "<self>", "peers": [ { "role": "...", "peerId": "..." } ] }

// 新对端进房
{ "type": "peer-present", "role": "...", "peerId": "..." }

// 对端离房
{ "type": "peer-gone", "role": "...", "peerId": "..." }

// 转发来的 offer / answer / ice(原样透传 sdp/candidate,不解析内容)
{ "type": "offer"  | "answer" | "ice", ...同上原字段, "from": "<对端 peerId>" }

// 错误
{ "type": "error", "code": "<machine code>", "message": "<human>" }
```

错误 `code` 枚举:`bad-message`(非法 JSON / 缺字段)、`not-registered`(register 前
发信令)、`peer-not-found`(`to` 指向的 peer 不在房)、`room-full`(见 §6.6 上限)。

### 6.4 消息路由逻辑(`wireSocket`)

```ts
private wireSocket(ws: WebSocket): void {
  let self: Member | null = null;

  ws.addEventListener("message", (ev) => {
    let msg: any;
    try { msg = JSON.parse(ev.data as string); }
    catch { return this.sendErr(ws, "bad-message", "invalid json"); }

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
      ws.send(JSON.stringify({
        type: "registered",
        peerId: self.peerId,
        peers: [...this.members.values()]
          .filter((m) => m.peerId !== self!.peerId)
          .map((m) => ({ role: m.role, peerId: m.peerId })),
      }));
      this.broadcastExcept(self.peerId, {
        type: "peer-present", role: self.role, peerId: self.peerId,
      });
      return;
    }

    if (!self) return this.sendErr(ws, "not-registered", "register first");

    if (msg.type === "offer" || msg.type === "answer" || msg.type === "ice") {
      const target = this.members.get(msg.to);
      if (!target) return this.sendErr(ws, "peer-not-found", `no peer ${msg.to}`);
      target.ws.send(JSON.stringify({ ...msg, from: self.peerId }));  // 原样透传,改写 from
      return;
    }

    this.sendErr(ws, "bad-message", `unknown type ${msg.type}`);
  });

  ws.addEventListener("close", () => {
    if (!self) return;
    this.members.delete(self.peerId);
    this.broadcastExcept(self.peerId, {
      type: "peer-gone", role: self.role, peerId: self.peerId,
    });
    this.scheduleRoomGc();   // 见 §6.5
  });
}
```

DO 对 `sdp` / `candidate` 字段**只透传不解析**(上游 §7.3:只转发建链元数据)。

### 6.5 房间 TTL / GC

`ROOM_TTL_SECONDS`(60s):最后一个成员离房后,用 `state.storage.setAlarm` 设一个
60s 闹钟;闹钟触发时若 `members` 仍空则什么都不做(DO 空闲自然被平台回收)。有新成员
进来则取消/忽略 —— DO 内存态随实例回收清零,无需手动清。本质上是"空房自然消亡",
TTL 只是给瞬断重连留缓冲(上游 §5.3)。

```ts
private scheduleRoomGc(): void {
  if (this.members.size === 0) {
    this.state.storage.setAlarm(Date.now() + this.cfg.roomTtlMs);
  }
}
async alarm(): Promise<void> { /* members 空则 no-op;平台回收实例 */ }
```

### 6.6 上限

`MAX_MEMBERS = 8`(1 desktop + 多 phone,防滥用)。超限 `room-full`。上游 §5.7
多 phone:每个 phone 各自 `peerId`,desktop 收到多个 `peer-present` 各建一个 peer。

---

## 7. `doProxy`:Worker 转 DO 前的鉴权

```ts
export async function handleDoProxy(
  req: Request, env: Env, cfg: Config, userHashFromPath: string,
): Promise<Response> {
  if (req.headers.get("Upgrade") !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }
  // 浏览器 WS 不能自定义 header → token 走 query ?token=
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const claims = await verifyJwt(cfg.serverSecret, token);
  if (!claims || claims.typ !== "session") {
    return new Response("unauthorized", { status: 401 });
  }
  if (claims.userHash !== userHashFromPath) {
    return new Response("forbidden: userHash mismatch", { status: 403 });   // 防越权进别人房
  }
  const id = env.PAIRING.idFromName(claims.userHash);
  const stub = env.PAIRING.get(id);
  return stub.fetch(req);   // 把 Upgrade 请求转进 DO
}
```

- session JWT 通过 query `?token=`(浏览器原生 WebSocket 无法设 header)。
- 强制 `claims.userHash === path userHash` —— 用户只能进自己的房,撮合权 = GitHub 身份。

---

## 8. CORS / 安全响应头(`lib/cors.ts`)

手机 PWA 与 Worker 同源(都在 `ccsm-worker.jiahuigu.workers.dev`)时本无需 CORS;但 PWA 若另托管
(如 Pages 子域)需放行。统一处理:

```ts
const ALLOWED_ORIGINS = ["https://ccsm-worker.jiahuigu.workers.dev"];  // PWA 若独立托管再加

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
```

---

## 9. 测试策略(全部 miniflare 本地,不依赖真 GitHub / 真 Cloudflare)

用 `@cloudflare/vitest-pool-workers`(miniflare 跑在 vitest 里),DO + Worker 都可单测。

| 测试文件 | 覆盖 | mock |
|---|---|---|
| `userHash.test.ts` | 同 id → 同 hash;不同 id → 不同;username 改了 id 不变 → hash 不变 | 无 |
| `jwt.test.ts` | sign→verify 往返;过期拒绝;签名篡改拒绝;`alg:none` 拒绝;`typ` 校验 | 无 |
| `oauth.test.ts` | callback:state 不符 → 400;code→token→user→authCode 正确;`/auth/session` 用 authCode 换 session;跨账号(不同 id)→ 不同 userHash → 不同 doUrl | `fetch` mock GitHub `access_token` + `/user` |
| `turnCred.test.ts` | 无 JWT → 401;有效 JWT → 调 CF TURN(mock)→ 返回 iceServers + ttl | `fetch` mock CF TURN |
| `pairingDo.test.ts` | 两个 WS 进房 → 互发 `peer-present`;offer/answer/ice 正确转发并改写 `from`;`to` 不存在 → `peer-not-found`;register 前发信令 → `not-registered`;离房 → `peer-gone`;`room-full`;不同 userHash 落不同 DO 实例(隔离) | miniflare WS |

**证据纪律**:这些全是单测,证明 Cloudflare 侧逻辑正确;**不是公网证据**。公网可达
留到 PR-5 真机 4G(上游 §8)。

---

## 10. 本地验证(给用户的步骤,代码写完后才执行)

> 这些命令**写完 PR-1 代码后**才跑。secret/login/deploy 由用户本人执行(memory 决策)。
> agent 用 `npm test`(miniflare)做无凭据验证;以下 `wrangler dev` 需要 secret,故标注谁来跑。

1. **agent 可跑**(无 secret):`cd cloudflare && npm install && npm test` —— miniflare 单测全绿。
2. **用户跑**(需 Cloudflare 账号):
   - `! npx wrangler login`
   - secret **无需 put** —— `ccsm-worker` 上已有 `GITHUB_OAUTH_CLIENT_SECRET`、
     `JWT_SIGNING_KEY`、`GITHUB_OAUTH_CLIENT_ID`(2026-05-30 核实)。
   - ~~`wrangler secret put TURN_KEY_ID` / `TURN_KEY_API_TOKEN`~~ —— **PR-1 跳过**(不绑卡、不配 TURN;真机打洞失败再补)
   - `! npx wrangler dev`(本地起 Worker + DO,浏览器走一遍 OAuth)
   - `! npx wrangler deploy`(部署到 `ccsm-worker.jiahuigu.workers.dev`)
3. GitHub OAuth app 的 **Authorization callback URL** 必须填
   `https://ccsm-worker.jiahuigu.workers.dev/auth/github/callback`(用户在 GitHub app 设置里配)。

---

## 11. 与上游 spec 的一致性核对

| 上游约束 | 本文件落点 |
|---|---|
| Worker 无状态、只 OAuth + 路由到 DO | §2 路由表,§3 OAuth,§7 doProxy |
| DO 每用户一房、只转发不持久化、TTL 销毁 | §6 DO,§6.5 GC |
| userHash = HMAC(serverSecret, githubUserId) | §4.1 |
| 短期 session JWT 15min | §3.3 / §4.2 |
| GitHub access token 不下发手机 | §3.4(用完即弃) |
| 信令消息 register/peer-present/peer-gone/offer/answer/ice/error | §6.3(补全确切字段 + `to`/`from`) |
| TURN 短期凭据 Worker 签发 | §5 |
| secret 全在 Worker secret,不进 repo/客户端 | §1.1 注释,§10 |
| 单测覆盖、非公网证据 | §9 |

**对上游的细化/新增(非冲突)**:
- 新增 `auth_code` 一次性中间 JWT(§3.2–3.3),让浏览器不在 URL 长期持凭据、且兼容
  桌面无浏览器场景。上游只说"发 session JWT",这里拆成两跳更安全。
- 信令消息补 `to` 字段(上游表只有 `from`)—— 多 phone 时必须定向路由,否则 offer
  会广播给所有对端。这是实现必需,不改变协议语义。
- `MAX_MEMBERS` 上限、错误 `code` 枚举 —— 上游未提,属防滥用的实现细节。
