# Mobile Remote PR-6: Flatten Worker ICE `urls[]` → werift `urls:string` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `electron/remote/turnCred.ts` flatten the Worker's `{urls: string[]}` ICE entries into werift's `{urls: string}` shape, so the desktop answerer actually finds STUN/TURN when fed the real Worker payload.

**Architecture:** One pure helper `flattenIceServers` added to `turnCred.ts`; `fetchIceServers` calls it after parsing the body. Controller and main.ts unchanged. Worker unchanged. All coverage at the `turnCred` seam via injected `fetchImpl`.

**Tech Stack:** TypeScript, werift (`RTCIceServer`), vitest (Node ABI).

**Base branch:** branch from `feat/mobile-remote-web-exposure` at tip `9d09737`. PR targets `feat/mobile-remote-web-exposure`, NOT `main`.

---

### Task 1: Flatten array `urls` into singular werift entries

**Files:**
- Modify: `electron/remote/turnCred.ts`
- Test: `electron/remote/__tests__/turnCred.test.ts`

- [ ] **Step 1: Add the failing tests**

Append these cases to `electron/remote/__tests__/turnCred.test.ts` (keep existing tests). They assume the existing helper that builds a fake `fetchImpl` returning a given JSON body with `ok:true`; if the existing file names it differently, reuse that. Pattern for a 200 response with a JSON body:

```ts
function ok(body: unknown): typeof fetch {
  return (async () =>
    ({ ok: true, json: async () => body }) as unknown as Response) as unknown as typeof fetch;
}

it('flattens an array of STUN urls into singular entries', async () => {
  const res = await fetchIceServers({
    workerOrigin: 'https://w.example',
    token: 't',
    fetchImpl: ok({ iceServers: [{ urls: ['stun:a:3478', 'stun:b:3478'] }] }),
  });
  expect(res).toEqual([{ urls: 'stun:a:3478' }, { urls: 'stun:b:3478' }]);
  for (const s of res ?? []) expect(typeof s.urls).toBe('string');
});

it('carries username/credential onto every TURN url', async () => {
  const res = await fetchIceServers({
    workerOrigin: 'https://w.example',
    token: 't',
    fetchImpl: ok({
      iceServers: [{ urls: ['turn:t:3478', 'turns:t:5349'], username: 'u', credential: 'c' }],
    }),
  });
  expect(res).toEqual([
    { urls: 'turn:t:3478', username: 'u', credential: 'c' },
    { urls: 'turns:t:5349', username: 'u', credential: 'c' },
  ]);
});

it('handles the real mixed STUN+TURN Worker shape', async () => {
  const res = await fetchIceServers({
    workerOrigin: 'https://w.example',
    token: 't',
    fetchImpl: ok({
      iceServers: [
        { urls: ['stun:s:3478'] },
        { urls: ['turn:t:3478'], username: 'u', credential: 'c' },
      ],
    }),
  });
  expect(res).toEqual([
    { urls: 'stun:s:3478' },
    { urls: 'turn:t:3478', username: 'u', credential: 'c' },
  ]);
});

it('passes through already-singular urls unchanged (idempotent)', async () => {
  const res = await fetchIceServers({
    workerOrigin: 'https://w.example',
    token: 't',
    fetchImpl: ok({ iceServers: [{ urls: 'stun:x:3478' }] }),
  });
  expect(res).toEqual([{ urls: 'stun:x:3478' }]);
});

it('returns null when flattening yields no usable urls', async () => {
  const res = await fetchIceServers({
    workerOrigin: 'https://w.example',
    token: 't',
    fetchImpl: ok({ iceServers: [{ urls: [] }, { urls: '' }] }),
  });
  expect(res).toBeNull();
});
```

Also update the existing "200 → returns the array" test to assert each `urls` is a string (it already passes a singular shape, so add):
```ts
for (const s of res ?? []) expect(typeof s.urls).toBe('string');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- turnCred`
Expected: the new array/flatten tests FAIL (current code returns `body.iceServers` verbatim, so `urls` stays an array and `toEqual` mismatches); existing tests still pass.

- [ ] **Step 3: Implement `flattenIceServers` and wire it in**

Replace the body of `electron/remote/turnCred.ts` with:

```ts
// electron/remote/turnCred.ts
import { type RTCIceServer } from 'werift';

type WireIceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

/** werift's RTCIceServer.urls is a single string and werift consumes it as
 *  one (`urls.includes("stun:")`, `urls.slice(5)`). The Worker sends `urls`
 *  as a string[] (comma-split STUN_URLS/TURN_URLS). Flatten each wire entry
 *  into one werift entry per url, carrying username/credential onto each so
 *  TURN auth survives. */
function flattenIceServers(wire: WireIceServer[]): RTCIceServer[] {
  const out: RTCIceServer[] = [];
  for (const entry of wire) {
    const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
    for (const url of urls) {
      if (typeof url !== 'string' || url.length === 0) continue;
      const server: RTCIceServer = { urls: url };
      if (entry.username !== undefined) server.username = entry.username;
      if (entry.credential !== undefined) server.credential = entry.credential;
      out.push(server);
    }
  }
  return out;
}

/** Fetch ICE servers (STUN + optional TURN) from the Worker's
 *  `POST /turn/credentials`. Returns null — never throws — on any non-OK
 *  response (501 "turn not configured" is the expected default), network
 *  error, malformed body, or a payload that flattens to nothing, so the
 *  controller degrades to STUN-only instead of crashing mobile-remote
 *  startup. `fetchImpl` is injectable for tests. */
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
    if (!res.ok) return null;
    const body = (await res.json()) as { iceServers?: WireIceServer[] };
    if (!Array.isArray(body.iceServers)) return null;
    const flat = flattenIceServers(body.iceServers);
    return flat.length > 0 ? flat : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- turnCred`
Expected: all tests PASS (new flatten cases + existing 200/501/throw/malformed).

- [ ] **Step 5: Local gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green. (`WireIceServer` is local; no new globals; no eslint config change needed.)

- [ ] **Step 6: Commit**

```bash
git add electron/remote/turnCred.ts electron/remote/__tests__/turnCred.test.ts
git commit -m "fix(mobile-remote): flatten Worker ICE urls[] to werift urls:string (PR-6)"
```

---

### Task 2: Include the design docs in the PR branch

**Files:**
- Add: `docs/superpowers/specs/2026-05-31-mobile-remote-pr6-ice-flatten-design.md` (already written in the planning worktree — copy its contents)
- Add: `docs/superpowers/plans/2026-05-31-mobile-remote-pr6-ice-flatten.md` (this file)

- [ ] **Step 1: Ensure both docs exist on the branch**

The spec and plan were authored in the `mobile-remote` planning worktree. Copy both files into this branch at the same paths so they ride along in the PR. If they are already present (because you branched from a worktree that has them uncommitted), `git add` them.

- [ ] **Step 2: Commit the docs**

```bash
git add docs/superpowers/specs/2026-05-31-mobile-remote-pr6-ice-flatten-design.md \
        docs/superpowers/plans/2026-05-31-mobile-remote-pr6-ice-flatten.md
git commit -m "docs(mobile-remote): PR-6 ICE flatten spec + plan"
```

---

### Task 3: Open the PR (do NOT merge)

- [ ] **Step 1: Push and open PR against the integration branch**

```bash
git push -u origin <your-branch>
gh pr create --base feat/mobile-remote-web-exposure \
  --title "fix(mobile-remote): flatten Worker ICE urls[] to werift urls:string (PR-6)" \
  --body "$(cat <<'EOF'
## Summary
- Worker returns ICE entries with `urls: string[]` (comma-split STUN_URLS/TURN_URLS), but werift's `RTCIceServer.urls` is a single string and werift consumes it as one (`urls.includes("stun:")`, `urls.slice(5)`). Fed the real Worker payload, werift found no STUN/TURN and gathered only host candidates.
- This PR flattens each wire entry into one werift entry per url (carrying username/credential onto TURN entries) inside `fetchIceServers`. No Worker change, no controller change, no main.ts change.

## Evidence boundary
Automated tests prove the desktop now produces werift-shaped ICE from the real Worker array payload. They do NOT prove public-internet reachability, TURN relay, or the real OAuth round-trip — those remain user-only real-device steps and are additionally blocked until the user deploys our Worker (the live origin currently serves a static SPA; `POST /auth/session` → 405).

## Test plan
- [ ] `npm run typecheck` green
- [ ] `npm run lint` green
- [ ] `npm test` green (turnCred flatten cases: array STUN, TURN auth carry, mixed shape, singular idempotent, empty→null)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: STOP.** Report the PR number + the green local gate to the parent (manager). Do **NOT** self-review and do **NOT** `gh pr merge`. An independent reviewer merges.
