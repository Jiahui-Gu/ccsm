# Mobile Remote PR-5: Desktop TURN/ICE Wiring — Design

**Status:** design (awaiting integration). Authored 2026-05-31.

**Base:** `feat/mobile-remote-web-exposure` at integration tip `1f672ef` (after PR-4b).

## 1. Goal

Make the desktop WebRTC answerer use **real ICE servers** (STUN + optional TURN) obtained from the Cloudflare Worker, instead of the hardcoded `stun:stun.l.google.com:19302` it currently passes to the peer. This is the last code change before a real-device, public-internet (4G) connection can be attempted. It does NOT, by itself, prove public reachability — that requires the user's real-device verification (see §7).

## 2. What already exists (do not rebuild)

- **Worker `POST /turn/credentials`** — `cloudflare/src/routes/turnCred.ts`, registered at `cloudflare/src/worker.ts:29`. Built in PR-1. Behavior:
  - Requires `Authorization: Bearer <session JWT>` (the `typ:"session"` token from `/auth/session`). 401 if missing/invalid.
  - If `TURN_KEY_ID` + `TURN_KEY_API_TOKEN` are NOT configured → **501** `{error:"turn not configured"}`. (Default state today.)
  - If configured → calls Cloudflare RTC `credentials/generate`, returns `{ iceServers: [{urls: stunUrls}, {urls: turnUrls, username, credential}], expiresInSeconds }`.
- **`/auth/session`** already returns `iceServers: [{ urls: stunUrls }]` (STUN-only) in its body — but the desktop currently **discards** it (`fetchSession` types it as `unknown[]` and `loginWithGithub` never stores it).
- **Controller** `electron/remote/mobileRemoteController.ts` accepts an injected `iceServers?: RTCIceServer[]` and otherwise defaults to `[{ urls: 'stun:stun.l.google.com:19302' }]`.

So PR-5 is purely **desktop client plumbing** + a thin TURN-cred fetch helper. **Zero Worker code changes.** Enabling TURN is a user-side `wrangler secret put` action, out of scope for this PR's code.

## 3. Design

### 3.1 New file: `electron/remote/turnCred.ts`

A single fetch helper, network-injectable for tests:

```ts
import type { RTCIceServer } from 'werift';

export async function fetchIceServers(deps: {
  workerOrigin: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<RTCIceServer[] | null> {
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f(new URL('/turn/credentials', deps.workerOrigin).toString(), {
      method: 'POST',
      headers: { authorization: `Bearer ${deps.token}` },
    });
    if (!res.ok) return null; // 501 (TURN off) / 401 / 502 → caller falls back
    const body = (await res.json()) as { iceServers: RTCIceServer[] };
    return Array.isArray(body.iceServers) ? body.iceServers : null;
  } catch {
    return null;
  }
}
```

Returning `null` (not throwing) on any non-OK / network error is deliberate: a 501 "TURN not configured" is the **expected default**, and the caller must degrade to STUN-only, never crash the mobile-remote startup.

### 3.2 Controller: fetch ICE before building the peer

`startMobileRemote` becomes able to resolve ICE servers from the Worker. The token it already holds (`login.token`) is the session JWT — the same one `/turn/credentials` authenticates with. New injectable seam `fetchIce` (defaults to the real helper); new optional `workerOrigin`.

ICE resolution order (first non-empty wins):
1. `opts.iceServers` if explicitly injected (tests / overrides) — unchanged behavior.
2. `await fetchIce({ workerOrigin, token })` → if it returns a non-empty array, use it (this is STUN+TURN when TURN is on, STUN-only when the Worker returns its `/auth/session`-style STUN set, or `null` on 501).
3. Fallback constant `[{ urls: 'stun:stun.l.google.com:19302' }]` — preserves today's behavior when the Worker can't be reached.

Because `startMobileRemote` is currently synchronous and returns `{close}|null`, and ICE fetch is async, the function becomes `async` and returns `Promise<{close}|null>`. `main.ts` already calls it from async setup; `restartMobileRemote()` must be updated to handle the promise (store the resolved disposer, guard against overlapping restarts). The `null`-when-logged-out contract is unchanged.

### 3.3 `main.ts` wiring

- Pass `workerOrigin: WORKER_ORIGIN` (the same constant PR-4b added) into `startMobileRemote`, so the controller can reach `/turn/credentials`.
- `restartMobileRemote()` awaits the promise; a generation counter (or in-flight guard) prevents a stale resolve from overwriting a newer disposer when login/logout toggles quickly.

### 3.4 Optional refresh — OUT OF SCOPE for PR-5

TURN creds carry `expiresInSeconds` (default 600s). A long-lived desktop session would eventually hold stale TURN creds. **We do NOT implement periodic refresh in PR-5** (YAGNI for a first real-device test; STUN needs no refresh, and a reconnect re-fetches). Documented here as a known follow-up, not a task.

## 4. Data flow

```
login (PR-4b) → session JWT + doUrl in safeStorage
startMobileRemote():
   token = login.token
   ice = inject? : (await fetchIce(workerOrigin, token)) ?? [google STUN]
   createDesktopPeer({ iceServers: ice, signaling, clients })
```

## 5. Error handling

- `/turn/credentials` 501 / 401 / 502 / network error → `fetchIceServers` returns `null` → controller uses Google-STUN fallback. Mobile-remote still starts. No throw.
- Logged out → controller returns `null` as before (no ICE fetch attempted).

## 6. Testing strategy

Unit (vitest, Node ABI):
- `turnCred.test.ts`: 200 with `{iceServers}` → returns the array; 501 → returns `null`; network throw → returns `null`; missing/empty body → `null`. Inject `fetchImpl`.
- `mobileRemoteController.test.ts` (extend): when `fetchIce` resolves servers, the peer is built with them; when it resolves `null`, peer is built with the Google-STUN fallback; injected `opts.iceServers` still wins; logged-out still returns `null` without calling `fetchIce`.
- `main.ts` restart guard: a logout-during-pending-login does not leave a live peer (generation guard) — covered at the controller/ipc seam if practical; otherwise documented as covered by manual restart test.

## 7. Evidence boundary (CRITICAL — this is the /goal gate)

This PR's automated tests prove the **client picks up and applies ICE servers correctly**. They do **NOT** prove:
- that a phone on **4G/外网** can actually reach the desktop (public-internet reachability), or
- that TURN relays traffic when P2P hole-punching fails, or
- that the **real GitHub OAuth round-trip** (the faux-opener path left unverified in PR-4b) works in the real app.

Those require **user-only verification on a real device**:
1. (Optional, user's billing decision) `wrangler secret put TURN_KEY_ID` + `TURN_KEY_API_TOKEN` on `ccsm-worker` to enable TURN. Without it the test runs STUN-only (works on many NATs, fails on symmetric NAT).
2. Desktop: real GitHub login via the PR-4b Settings → Mobile Remote pane (proves faux-opener).
3. Phone on 4G (Wi-Fi OFF), open the phone PWA, connect, drive a terminal session.

Loopback/headless is NOT public-internet evidence. Per project rules, the feature is not "shippable / experienced" until step 3 passes on a real device.

## 8. Out of scope

- Worker changes (none).
- TURN secret provisioning (user wrangler action).
- Periodic TURN cred refresh (documented follow-up).
- Phone-side ICE changes (phone already receives ICE via signaling; the desktop is the answerer that needs the servers here).
