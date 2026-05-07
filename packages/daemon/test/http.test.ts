// HTTP-layer spawn tests (Task #668).
//
// These cover the new spawn-from-HTTP architecture:
//   * POST /api/sessions    -> registry.spawn(sid, info, 'create')
//                              -> claude args contain ['--session-id', sid]
//   * POST /:sid/resume     -> registry.spawn(sid, info, 'resume')
//                              -> claude args contain ['--resume', sid]
//                              -> 404 when sid unknown
//                              -> idempotent when runtime already alive
//   * spawn factory throws  -> POST -> 500 + stub rolled back
//
// We use a fake PtyFactory so no real `claude` is launched, and assert against
// the recorded spawn opts (which now include `sid` and `mode` per #668).

import type { AddressInfo } from 'node:net';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDaemonHttp, type DaemonHttp } from '../src/http.mjs';
import {
  createRuntimeRegistry,
  type PtyFactory,
  type PtyLike,
  type PtySpawnMode,
  type RuntimeRegistry,
} from '../src/runtime.mjs';

const TOKEN = 'test-token-do-not-use-in-prod-0123456789abcdef';
const GOOD_ORIGIN = 'http://localhost:1234';

interface SpawnRecord {
  sid: string;
  mode: PtySpawnMode;
  cwd: string;
  cols: number;
  rows: number;
  pty: PtyLike;
}

function makeRecorderFactory(opts: { throwOnce?: boolean } = {}): {
  factory: PtyFactory;
  records: SpawnRecord[];
} {
  const records: SpawnRecord[] = [];
  let shouldThrow = opts.throwOnce ?? false;
  const factory: PtyFactory = (o) => {
    if (shouldThrow) {
      shouldThrow = false;
      throw new Error('synthetic spawn failure');
    }
    const pty: PtyLike = {
      write: () => {},
      resize: () => {},
      kill: () => {},
      onData: () => {},
      onExit: () => {},
    };
    records.push({ sid: o.sid, mode: o.mode, cwd: o.cwd, cols: o.cols, rows: o.rows, pty });
    return pty;
  };
  return { factory, records };
}

function authedHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    Authorization: `Bearer ${TOKEN}`,
    Origin: GOOD_ORIGIN,
    'Content-Type': 'application/json',
    ...extra,
  };
}

interface Fixture {
  http: DaemonHttp;
  registry: RuntimeRegistry;
  baseUrl: string;
  records: SpawnRecord[];
}

async function makeFixture(opts: { throwOnce?: boolean } = {}): Promise<Fixture> {
  const { factory, records } = makeRecorderFactory(opts);
  const http = createDaemonHttp({ token: TOKEN });
  const registry = createRuntimeRegistry({
    sessions: http.sessions,
    ptyFactory: factory,
  });
  http.setRegistry(registry);
  await new Promise<void>((resolve, reject) => {
    http.server.once('error', reject);
    http.server.listen(0, '127.0.0.1', () => {
      http.server.removeListener('error', reject);
      resolve();
    });
  });
  const addr = http.server.address() as AddressInfo;
  return { http, registry, baseUrl: `http://127.0.0.1:${addr.port}`, records };
}

async function tearDown(fx: Fixture): Promise<void> {
  for (const sid of Array.from(fx.http.sessions.keys())) {
    fx.registry.kill(sid);
    fx.http.sessions.delete(sid);
  }
  await new Promise<void>((resolve) => fx.http.server.close(() => resolve()));
}

describe('POST /api/sessions (T#668: spawns at HTTP layer)', () => {
  let fx: Fixture;
  beforeAll(async () => { fx = await makeFixture(); });
  afterAll(async () => { await tearDown(fx); });
  afterEach(() => {
    for (const sid of Array.from(fx.http.sessions.keys())) {
      fx.registry.kill(sid);
      fx.http.sessions.delete(sid);
    }
    fx.records.length = 0;
  });

  it('spawns claude --session-id <newSid> with the supplied cwd', async () => {
    const r = await fetch(`${fx.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: authedHeaders(),
      body: JSON.stringify({ cwd: 'C:/work/foo' }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { sid: string; createdAt: number };
    expect(typeof body.sid).toBe('string');
    expect(body.sid.length).toBeGreaterThan(0);
    expect(fx.records.length).toBe(1);
    const rec = fx.records[0]!;
    expect(rec.mode).toBe('create');
    expect(rec.sid).toBe(body.sid);
    expect(rec.cwd).toBe('C:/work/foo');
    // Runtime registry should now have a live entry for the sid.
    expect(fx.registry.has(body.sid)).toBe(true);
  });

  it('returns 500 + rolls back the stub when ptyFactory throws', async () => {
    const failing = await makeFixture({ throwOnce: true });
    try {
      const r = await fetch(`${failing.baseUrl}/api/sessions`, {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify({ cwd: '/tmp' }),
      });
      expect(r.status).toBe(500);
      const j = (await r.json()) as { error: string };
      expect(j.error).toBe('pty_spawn_failed');
      // No leaked stub.
      expect(failing.http.sessions.size).toBe(0);
      // No recorded spawn (factory threw before push).
      expect(failing.records.length).toBe(0);
    } finally {
      await tearDown(failing);
    }
  });
});

describe('POST /api/sessions/:sid/resume (T#668)', () => {
  let fx: Fixture;
  beforeAll(async () => { fx = await makeFixture(); });
  afterAll(async () => { await tearDown(fx); });
  afterEach(() => {
    for (const sid of Array.from(fx.http.sessions.keys())) {
      fx.registry.kill(sid);
      fx.http.sessions.delete(sid);
    }
    fx.records.length = 0;
  });

  it('returns 404 for an unknown sid', async () => {
    const r = await fetch(
      `${fx.baseUrl}/api/sessions/this-sid-does-not-exist/resume`,
      { method: 'POST', headers: authedHeaders() },
    );
    expect(r.status).toBe(404);
    const j = (await r.json()) as { error: string };
    expect(j.error).toBe('not_found');
    expect(fx.records.length).toBe(0);
  });

  it('spawns claude --resume <sid> for an existing-but-dead session', async () => {
    // Step 1: create session (spawns once with mode=create).
    const create = await fetch(`${fx.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: authedHeaders(),
      body: JSON.stringify({ cwd: '/repo/x' }),
    });
    const { sid } = (await create.json()) as { sid: string };
    expect(fx.records.length).toBe(1);
    expect(fx.records[0]!.mode).toBe('create');
    // Step 2: simulate the runtime dying without removing the stub row.
    fx.registry.kill(sid);
    // Force-remove the runtime entry too (kill is async via setTimeout in
    // real code, and our fake pty never fires onExit). We mimic the
    // post-restart state by clearing the runtime via a fresh resume call:
    // first verify the registry still thinks it's alive (kill didn't remove
    // because the noop pty never exited), so we work around it by stripping
    // the runtime through a lower-level path: dispatch a fresh shutdownAll
    // would nuke the sessions map too. Instead, simulate "daemon restart"
    // by creating a brand-new fixture and seeding it with a stub row that
    // has no runtime.
    const restarted = await makeFixture();
    try {
      restarted.http.sessions.set(sid, {
        sid,
        createdAt: Date.now(),
        alive: false,
        cwd: '/repo/x',
      });
      const r = await fetch(
        `${restarted.baseUrl}/api/sessions/${encodeURIComponent(sid)}/resume`,
        { method: 'POST', headers: authedHeaders() },
      );
      expect(r.status).toBe(200);
      const body = (await r.json()) as { ok: true };
      expect(body.ok).toBe(true);
      expect(restarted.records.length).toBe(1);
      const rec = restarted.records[0]!;
      expect(rec.mode).toBe('resume');
      expect(rec.sid).toBe(sid);
      // Spike #665: cwd from the stub row must reach the spawn opts.
      expect(rec.cwd).toBe('/repo/x');
      // alive flag flips back on after a successful resume.
      expect(restarted.http.sessions.get(sid)?.alive).toBe(true);
    } finally {
      await tearDown(restarted);
    }
  });

  it('is idempotent when the runtime is already alive (no second spawn)', async () => {
    const create = await fetch(`${fx.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: authedHeaders(),
      body: JSON.stringify({}),
    });
    const { sid } = (await create.json()) as { sid: string };
    expect(fx.records.length).toBe(1);
    // Resume while still alive -> 200, no extra spawn.
    const r = await fetch(
      `${fx.baseUrl}/api/sessions/${encodeURIComponent(sid)}/resume`,
      { method: 'POST', headers: authedHeaders() },
    );
    expect(r.status).toBe(200);
    expect(((await r.json()) as { ok: true }).ok).toBe(true);
    expect(fx.records.length).toBe(1);
  });

  it('returns 500 when the resume spawn factory throws', async () => {
    // First create normally so the stub row exists, then swap fixture for
    // one whose factory throws.
    const seed = await makeFixture();
    let seededSid: string;
    try {
      const create = await fetch(`${seed.baseUrl}/api/sessions`, {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify({ cwd: '/x' }),
      });
      seededSid = ((await create.json()) as { sid: string }).sid;
    } finally {
      await tearDown(seed);
    }

    const failing = await makeFixture({ throwOnce: true });
    try {
      // Re-seed the stub row in the failing fixture (simulates "stub survived
      // a daemon restart but the next spawn fails", e.g. claude binary missing).
      failing.http.sessions.set(seededSid, {
        sid: seededSid,
        createdAt: Date.now(),
        alive: false,
        cwd: '/x',
      });
      const r = await fetch(
        `${failing.baseUrl}/api/sessions/${encodeURIComponent(seededSid)}/resume`,
        { method: 'POST', headers: authedHeaders() },
      );
      expect(r.status).toBe(500);
      const j = (await r.json()) as { error: string };
      expect(j.error).toBe('pty_spawn_failed');
    } finally {
      await tearDown(failing);
    }
  });
});

// Task #700: GET / must serve the built SPA from packages/frontend-web/dist.
// The path is hard-coded relative to this file via http.mts's
// `resolve(HERE, '..', '..', 'frontend-web', 'dist')`. T6 (#686) renamed
// `packages/frontend` -> `packages/frontend-web` and the daemon constant was
// missed, causing every browser hit to return 503 "frontend not built". This
// test pins the resolved path so any future rename of the frontend package
// fails CI instead of being discovered by hand-testing.
describe('GET / (Task #700: serves built SPA from frontend-web/dist)', () => {
  // src lives at packages/daemon/src; this test file lives at packages/daemon/test.
  // http.mts resolves dist as `<src>/../../frontend-web/dist`, i.e.
  // `packages/frontend-web/dist`. We mirror that calc here so the test
  // fails if either side moves.
  const HERE = dirname(fileURLToPath(import.meta.url));
  const FRONTEND_DIST = resolve(HERE, '..', '..', 'frontend-web', 'dist');
  const FRONTEND_INDEX = resolve(FRONTEND_DIST, 'index.html');
  const SENTINEL = '<div id="root"><!-- task-700-spa-sentinel --></div>';
  let createdDist = false;
  let createdIndex = false;
  let preexistingIndex: Buffer | null = null;
  let fx: Fixture;

  beforeAll(async () => {
    if (!existsSync(FRONTEND_DIST)) {
      mkdirSync(FRONTEND_DIST, { recursive: true });
      createdDist = true;
    }
    if (existsSync(FRONTEND_INDEX)) {
      preexistingIndex = readFileSync(FRONTEND_INDEX);
    } else {
      createdIndex = true;
    }
    writeFileSync(FRONTEND_INDEX, `<!doctype html><html><body>${SENTINEL}</body></html>`);
    fx = await makeFixture();
  });

  afterAll(async () => {
    await tearDown(fx);
    if (preexistingIndex !== null) {
      writeFileSync(FRONTEND_INDEX, preexistingIndex);
    } else if (createdIndex) {
      try { rmSync(FRONTEND_INDEX); } catch { /* ignore */ }
    }
    if (createdDist) {
      try { rmSync(FRONTEND_DIST, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('returns 200 + the SPA index.html body (no 503 "frontend not built")', async () => {
    const r = await fetch(`${fx.baseUrl}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toContain('text/html');
    const body = await r.text();
    // If FRONTEND_DIST resolves to the wrong package (e.g. the pre-T6
    // `packages/frontend/dist`) the server returns 503 "frontend not built";
    // either the status check above or this body assertion will catch it.
    expect(body).toContain(SENTINEL);
  });
});
