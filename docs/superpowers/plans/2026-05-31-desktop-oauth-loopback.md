# Desktop OAuth Loopback Implementation Plan

> **For agentic workers:** Implement task-by-task, TDD, commit per task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix the broken desktop GitHub login by replacing the in-app popup + `postMessage` authCode delivery with a system-browser + `127.0.0.1` loopback flow (gh CLI / VS Code pattern).

**Architecture:** Mirror the existing `oauth_flow=phone` design on the Worker. A new `GET /auth/github/desktop-start?port=<port>` sets `oauth_flow=desktop` + `oauth_port` cookies and 302s to GitHub. The shared callback, on `oauth_flow=desktop`, 302s the one-time `auth_code` JWT to `http://127.0.0.1:<port>/?authCode=...`. Desktop main process runs a temp loopback HTTP server, opens the system browser via `shell.openExternal`, and resolves the authCode from the loopback request. GitHub `redirect_uri` stays the Worker callback (single registered host).

**Tech Stack:** Cloudflare Worker (TS, vitest-pool-workers), Electron main (node:http, electron shell), vitest.

---

### Task 1: Worker `desktop-start` route

**Files:**
- Create: `cloudflare/src/routes/oauthDesktopStart.ts`
- Test: `cloudflare/test/oauthDesktopStart.test.ts`

`parsePort(raw)`: accept integer 1024–65535, else null. `handleOauthDesktopStart`: 400 on bad port; else 302 to github authorize with `oauth_state`, `oauth_flow=desktop`, `oauth_port=<port>` cookies (HttpOnly; Secure; SameSite=Lax; Max-Age=300).

### Task 2: Worker callback desktop branch

**Files:**
- Modify: `cloudflare/src/routes/oauthCallback.ts`
- Test: `cloudflare/test/oauthCallback.test.ts`

After computing `userHash`, before the legacy desktop postMessage path: if `oauth_flow === "desktop"`, parse `oauth_port` (400 if bad), sign `auth_code` JWT (exp +60s), 302 to `http://127.0.0.1:<port>/?authCode=...`, clear `oauth_state`/`oauth_flow`/`oauth_port` cookies. Leave the `oauth_flow=phone` branch and the legacy popup HTML untouched (popup path becomes dead once desktop migrates; cleanup is follow-up).

### Task 3: Worker route wiring

**Files:**
- Modify: `cloudflare/src/worker.ts`

Add `GET /auth/github/desktop-start → handleOauthDesktopStart`.

### Task 4: Desktop `runOauthLoopback`

**Files:**
- Create: `electron/remote/oauthLoopback.ts`
- Test: `electron/remote/__tests__/oauthLoopback.test.ts`

`runOauthLoopback({ workerOrigin, openExternal?, timeoutMs? })`: start `http.createServer` on `127.0.0.1:0`; read assigned port; `openExternal(`${workerOrigin}/auth/github/desktop-start?port=<port>`)`; on GET `/?authCode=...` resolve `{authCode}`, respond a minimal "You can close this window." HTML, close server; timeout → reject; ignore favicon/other paths. Inject `openExternal` and an `http`-server factory for testability so the test never opens a real browser.

### Task 5: Swap injection in main.ts

**Files:**
- Modify: `electron/main.ts` (import + the `runPopup:` seam ~L368)

Replace `runOauthPopup({...})` with `runOauthLoopback({ workerOrigin: WORKER_ORIGIN })`. Keep `loginWithGithub` shape unchanged.

### Task 6: Deploy + verify

`cd cloudflare && npm run typecheck && npx vitest run`; root `npm run typecheck && npm run lint && npm test`; `wrangler deploy`; dogfood desktop login end-to-end with the user's diagnostic logs; capture evidence.
