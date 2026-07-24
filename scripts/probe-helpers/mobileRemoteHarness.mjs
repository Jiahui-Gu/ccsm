// Shared plumbing for the mobile-remote Playwright harnesses (composer/
// terminal-sync plan, Task 6): reserving a local port, starting/stopping a
// local Wrangler dev server for the Cloudflare relay Worker, and a
// generic encrypted "simulated desktop" peer that understands the same
// wire protocol the real Electron desktop speaks
// (`electron/remote/remoteMessages.ts` / `mobileRemoteController.ts`).
//
// Consumed by `scripts/harness-e2e-mobile-remote-relay.mjs`,
// `scripts/harness-e2e-mobile-terminal-sync.mjs`,
// `scripts/harness-e2e-mobile-remote-visual.mjs`, and
// `scripts/harness-e2e-mobile-desktop-ownership.mjs` so the Wrangler
// lifecycle and desktop-simulation code is written — and fixed — exactly
// once. Requires `npm run build` first (imports compiled `dist/electron`
// and `dist/src/shared` output, exactly like the harnesses that use it).

import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const require = createRequire(import.meta.url);
const { createEncryptedPeer } = require(
  path.join(rootDir, 'dist', 'electron', 'remote', 'encryptedPeer.js'),
);
const { createRelaySocket } = require(
  path.join(rootDir, 'dist', 'electron', 'remote', 'relaySocket.js'),
);
const { generatePairingIdentity } = require(
  path.join(rootDir, 'dist', 'src', 'shared', 'mobileRemote', 'index.js'),
);
const { SESSION_NAVIGATOR_MESSAGE_VERSION } = require(
  path.join(rootDir, 'dist', 'src', 'shared', 'sessionNavigator', 'index.js'),
);

export { generatePairingIdentity, SESSION_NAVIGATOR_MESSAGE_VERSION };

/** Reads `CCSM_RELAY_URL` (trailing slashes stripped) — the public-relay
 *  opt-in every harness supports alongside its local-Wrangler default. */
export function configuredRelayUrl() {
  return process.env.CCSM_RELAY_URL?.replace(/\/+$/, '') || null;
}

/**
 * Serves the current local mobile build at a configured public relay origin
 * while leaving WebSocket traffic untouched. This lets pre-deployment gates
 * exercise candidate assets against the real Cloudflare relay without first
 * replacing the currently deployed phone bundle.
 */
export async function installConfiguredMobileAssets(page, relayUrl) {
  const configuredDir = process.env.CCSM_MOBILE_ASSET_DIR?.trim();
  if (!configuredDir) return false;

  const assetDir = path.resolve(rootDir, configuredDir);
  const relayOrigin = new URL(relayUrl).origin;
  const contentTypes = new Map([
    ['.html', 'text/html'],
    ['.js', 'application/javascript'],
    ['.css', 'text/css'],
    ['.webmanifest', 'application/manifest+json'],
  ]);

  await page.route(`${relayOrigin}/**`, async (route) => {
    const request = route.request();
    if (!['document', 'script', 'stylesheet', 'manifest'].includes(request.resourceType())) {
      await route.continue();
      return;
    }

    const pathname = new URL(request.url()).pathname;
    const fileName = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!fileName || fileName !== path.basename(fileName)) {
      await route.continue();
      return;
    }

    let body;
    try {
      body = await readFile(path.join(assetDir, fileName));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        await route.continue();
        return;
      }
      throw error;
    }

    await route.fulfill({
      status: 200,
      body,
      contentType: contentTypes.get(path.extname(fileName)) ?? 'application/octet-stream',
    });
  });
  return true;
}

export function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('unable to reserve a relay port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

export async function waitFor(description, predicate, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`,
  );
}

function createOutputTail(limit = 100) {
  const lines = [];
  return {
    record(chunk) {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line) lines.push(line);
        if (lines.length > limit) lines.shift();
      }
    },
    tail(n = 12) {
      return lines.slice(-n).join('\n');
    },
  };
}

/**
 * Starts a local Wrangler dev server for `cloudflare/wrangler.jsonc` on
 * `port`, waits for it to answer, and returns `{ child, relayUrl, output }`.
 * `output.tail()` is used for diagnostics on failure.
 */
export async function startWrangler(port) {
  const output = createOutputTail();
  const wranglerBin = path.join(rootDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const child = spawn(
    process.execPath,
    [
      wranglerBin,
      'dev',
      '--config',
      path.join(rootDir, 'cloudflare', 'wrangler.jsonc'),
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--local',
    ],
    {
      cwd: rootDir,
      env: { ...process.env, NO_COLOR: '1' },
      detached: false,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  child.stdout.on('data', output.record);
  child.stderr.on('data', output.record);
  child.once('exit', (code) => {
    if (code && code !== 0) output.record(`wrangler exited with code ${code}`);
  });

  const relayUrl = `http://127.0.0.1:${port}`;
  await waitFor(
    'Wrangler dev server',
    async () => {
      if (child.exitCode !== null) throw new Error(output.tail());
      const response = await fetch(relayUrl);
      return response.ok;
    },
    30_000,
  );
  return { child, relayUrl, output };
}

/** Tree-kills exactly the given child (never a broad process-name kill):
 *  `taskkill /PID <pid> /T /F` on Windows walks that one process's own
 *  tree; POSIX sends SIGTERM then escalates to SIGKILL if it lingers. */
export async function stopExactChild(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch {
      return;
    }
  }
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // It exited between the state check and signal.
    }
  }
}

/** Removes Wrangler's local `.wrangler` state directory (SQLite-backed
 *  Durable Object storage, miniflare cache, …) so a rerun starts clean. */
export function cleanupWranglerLocalState() {
  try {
    rmSync(path.join(rootDir, 'cloudflare', '.wrangler'), {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  } catch {
    // Best-effort: a lingering miniflare handle (e.g. a cache DB the OS
    // hasn't released the lock on yet) must never crash the harness after
    // its actual test results have already been reported.
  }
}

/** Builds a single-group `SessionNavigatorModel` from simple session
 *  descriptors — enough for every harness case; multi-group models can be
 *  built by hand when a case specifically needs one. */
export function buildNavigatorModel(sessionDescriptors, options = {}) {
  return {
    groups: [
      {
        id: options.groupId ?? 'g1',
        name: options.groupName ?? 'Sessions',
        order: 0,
        collapsed: false,
        sessions: sessionDescriptors.map((descriptor, index) => ({
          id: descriptor.sid,
          name: descriptor.name ?? descriptor.sid,
          cwd: descriptor.cwd ?? 'C:\\work\\mobile-e2e',
          state: descriptor.state ?? 'idle',
          order: index,
        })),
      },
    ],
    activeSessionId: options.activeSessionId ?? null,
  };
}

/**
 * A generic encrypted "simulated desktop" peer speaking the same wire
 * protocol as the real Electron desktop controller
 * (`electron/remote/mobileRemoteController.ts` /
 * `electron/remote/remoteMessages.ts`):
 *   - proactively sends BOTH the legacy `sessions.list` and the versioned
 *     `sessions.navigator` on every successful encrypted handshake (real
 *     desktop behavior — see `onAuthenticated` in
 *     `mobileRemoteController.ts` — so the navigator-driven phone can
 *     select a session without any extra request);
 *   - answers `session.snapshot` per-session (default: an accumulator of
 *     every chunk sent through `sendPty`, or an injected
 *     `snapshotProvider(session)` for exact xterm-authoritative control),
 *     and — matching real production's `remoteMessages.ts` — records the
 *     requested sid as this peer's `subscribedSid`;
 *   - fans live `pty.data` out through `sendPty`/`sendRawPty` ONLY while
 *     this peer's `subscribedSid` matches the target sid, exactly like the
 *     real desktop's `electron/remote/ptyFanout.ts`: a fresh (e.g.
 *     post-reconnect) peer starts with `subscribedSid: null` and drops
 *     live output until a `session.snapshot` request re-arms it. The
 *     narrowly-scoped `sendInFlightPty` bypasses this gate entirely, for
 *     the one deliberate in-flight-frame race it exists to model;
 *   - records every inbound phone message plus every `session.input` and
 *     `session.snapshot` request, and answers every `session.submit` with a correlated
 *     `session.submit.result` (default validation mirrors the real
 *     server: empty sid/requestId/draft or an unknown sid is rejected,
 *     anything else succeeds — override with `setSubmitHandler` for a
 *     case that needs a different outcome);
 *   - tracks `authenticatedCount`/`failures` for handshake/rotation
 *     assertions.
 */
export function createSimulatedDesktop(relayUrl, pairing, options = {}) {
  const sessions = new Map();
  const inputs = [];
  const receivedMessages = [];
  const submissions = [];
  const snapshotRequests = [];
  const failures = [];
  let authenticatedCount = 0;
  let navigatorModel = options.navigatorModel ?? null;
  let submitHandler = options.submitHandler ?? defaultSubmitHandler;

  function sessionGeometry(session) {
    return {
      cols: session.cols,
      rows: session.rows,
      epoch: session.geometryEpoch,
    };
  }

  function normalizeGeometry(geometry, fallback) {
    if (!geometry || typeof geometry !== 'object') return fallback;
    const cols = Number(geometry.cols);
    const rows = Number(geometry.rows);
    const epoch = Number(geometry.epoch);
    if (
      !Number.isSafeInteger(cols) ||
      !Number.isSafeInteger(rows) ||
      !Number.isSafeInteger(epoch) ||
      cols <= 0 ||
      rows <= 0 ||
      epoch < 0
    ) {
      return fallback;
    }
    return { cols, rows, epoch };
  }

  function addSession(sid, sessionOptions = {}) {
    sessions.set(sid, {
      sid,
      cwd: sessionOptions.cwd ?? 'C:\\work\\mobile-e2e',
      cols: sessionOptions.cols ?? 120,
      rows: sessionOptions.rows ?? 30,
      geometryEpoch: sessionOptions.geometryEpoch ?? 0,
      buffer: '',
      seq: 0,
      snapshotProvider: sessionOptions.snapshotProvider ?? defaultSnapshotProvider,
    });
  }
  for (const descriptor of options.sessions ?? []) addSession(descriptor.sid, descriptor);

  function defaultSnapshotProvider(session) {
    return {
      seq: session.seq,
      snapshot: session.buffer,
      geometry: sessionGeometry(session),
    };
  }

  function defaultSubmitHandler(sid, requestId, draft) {
    if (!sid || !requestId || !draft) return { ok: false, error: 'invalid_submission' };
    if (!sessions.has(sid)) return { ok: false, error: 'session_not_found' };
    return { ok: true };
  }

  function legacySessionsListEntries() {
    return [...sessions.values()].map((session) => ({
      sid: session.sid,
      cwd: session.cwd,
      geometry: sessionGeometry(session),
    }));
  }

  function defaultNavigatorModel() {
    return buildNavigatorModel(
      [...sessions.values()].map((session) => ({ sid: session.sid, cwd: session.cwd })),
    );
  }

  function sendSessionCatalog(peer) {
    peer.send({ type: 'sessions.list', sessions: legacySessionsListEntries() });
    peer.send({
      type: 'sessions.navigator',
      version: SESSION_NAVIGATOR_MESSAGE_VERSION,
      model: navigatorModel ?? defaultNavigatorModel(),
    });
  }

  async function handleMessage(remotePeer, raw) {
    const message = JSON.parse(raw);
    receivedMessages.push(message);
    if (message.type === 'sessions.list') {
      sendSessionCatalog(remotePeer);
      return;
    }
    if (message.type === 'session.snapshot') {
      snapshotRequests.push({ sid: message.sid, at: Date.now() });
      remotePeer.subscribedSid = message.sid;
      const session = sessions.get(message.sid);
      if (!session) {
        remotePeer.send({ type: 'error', message: 'missing_sid' });
        return;
      }
      const result = await session.snapshotProvider(session);
      // `null`/`undefined` means "hold this one" — a case that needs exact
      // control over response timing (e.g. proving a snapshot/live overlap
      // window) sets a provider that returns this and answers later,
      // explicitly, via `sendSnapshotNow`. The request is still recorded
      // above either way.
      if (result == null) return;
      const fallbackGeometry = sessionGeometry(session);
      const geometry = normalizeGeometry(result.geometry, fallbackGeometry);
      remotePeer.send({
        type: 'session.snapshot',
        sid: message.sid,
        seq: result.seq,
        snapshot: result.snapshot ?? result.data ?? '',
        geometry,
      });
      return;
    }
    if (message.type === 'session.input') {
      inputs.push({ sid: message.sid, data: message.data });
      return;
    }
    if (message.type === 'session.submit') {
      const result = await submitHandler(message.sid, message.requestId, message.draft);
      submissions.push({ sid: message.sid, requestId: message.requestId, draft: message.draft, ...result });
      remotePeer.send({
        type: 'session.submit.result',
        sid: message.sid,
        requestId: message.requestId,
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
      });
      return;
    }
  }

  const socket = createRelaySocket({
    relayUrl,
    roomId: pairing.roomId,
    heartbeatMs: 2_000,
    random: () => 0,
  });
  const peer = createEncryptedPeer({
    pairing,
    socket,
    handleMessage,
    onAuthenticated: () => {
      authenticatedCount += 1;
      sendSessionCatalog(peer);
    },
    onFailure: (failure) => failures.push(failure),
  });
  peer.start();

  return {
    peer,
    get inputs() {
      return inputs;
    },
    get receivedMessages() {
      return [...receivedMessages];
    },
    get submissions() {
      return submissions;
    },
    get snapshotRequests() {
      return snapshotRequests;
    },
    get failures() {
      return failures;
    },
    get authenticatedCount() {
      return authenticatedCount;
    },
    addSession,
    /** Overrides one session's snapshot provider after creation — the seam
     *  a harness with its own authoritative `@xterm/headless` reference
     *  terminal uses to answer `session.snapshot` with an exact, precise
     *  `{ seq, data }` instead of the default buffer accumulator. */
    setSnapshotProvider(sid, fn) {
      const session = sessions.get(sid);
      if (session) session.snapshotProvider = fn;
    },
    setNavigatorModel(model) {
      navigatorModel = model;
    },
    setSubmitHandler(fn) {
      // No-arg (or explicit `undefined`) restores the default validator —
      // callers that temporarily override behavior for one assertion can
      // cleanly hand control back afterward instead of leaving
      // `submitHandler` as a non-callable `undefined`.
      submitHandler = fn ?? defaultSubmitHandler;
    },
    /** Sends a `pty.data` chunk AND appends it to that session's own
     *  accumulator/seq bookkeeping (used by the default snapshot
     *  provider) — the "normal, undisturbed" path for a harness that
     *  doesn't own a separate authoritative reference terminal.
     *
     *  PRODUCTION-GATED LIVE FANOUT: like the real desktop's
     *  `electron/remote/ptyFanout.ts`, the chunk only actually reaches the
     *  wire when this peer's `subscribedSid` (set only by a `session.snapshot`
     *  request — see `handleMessage` above) currently matches `sid`; a fresh
     *  or not-yet-(re)subscribed peer silently drops it on the floor, exactly
     *  like production. The accumulator itself still always updates —
     *  real production's underlying PTY buffer keeps accumulating
     *  regardless of which remote peer happens to be subscribed, so a
     *  later `session.snapshot` answer must reflect it either way. */
    sendPty(sid, seq, chunk, geometryEpoch) {
      const session = sessions.get(sid);
      if (session) {
        session.buffer += chunk;
        session.seq = seq;
      }
      const epoch = geometryEpoch ?? session?.geometryEpoch ?? 0;
      if (peer.subscribedSid === sid) {
        peer.send({ type: 'pty.data', sid, seq, chunk, geometryEpoch: epoch });
      }
    },
    /** Sends a raw `pty.data` chunk over the wire WITHOUT touching any
     *  session's accumulator — the escape hatch a harness that owns its
     *  own authoritative `@xterm/headless` reference terminal (and its
     *  own snapshotProvider reading from it) uses to inject duplicates,
     *  gaps, or stale/reordered frames precisely.
     *
     *  PRODUCTION-GATED LIVE FANOUT: gated exactly like `sendPty` above
     *  (and the real `ptyFanout.ts`) — only delivered while this peer's
     *  `subscribedSid` matches `sid`. A case that needs to prove a frame
     *  reaching the wire despite NOT (yet) being subscribed — e.g. a
     *  frame that was already in flight before a subscription changed —
     *  must use the deliberate, narrowly-scoped `sendInFlightPty` bypass
     *  below instead, never this one. */
    sendRawPty(sid, seq, chunk, geometryEpoch) {
      const session = sessions.get(sid);
      const epoch = geometryEpoch ?? session?.geometryEpoch ?? 0;
      if (peer.subscribedSid === sid) {
        peer.send({ type: 'pty.data', sid, seq, chunk, geometryEpoch: epoch });
      }
    },
    /** DELIBERATE IN-FLIGHT INJECTION — bypasses the `subscribedSid` gate
     *  entirely and always puts the frame on the wire, unconditionally,
     *  exactly like `sendRawPty` did before it was gated to match
     *  production. This does NOT model normal live fanout: it models one
     *  specific real-world race that gating alone cannot reproduce — a
     *  pty.data frame for the OLD session that was already handed to the
     *  transport (already "on the wire") in the instant before this
     *  peer's subscription actually flips to the newly selected session,
     *  so it can still arrive just after the switch. Reserved for that
     *  one stale-old-sid-tail assertion in the session-switch-race case;
     *  every other case must keep using the gated `sendPty`/`sendRawPty`
     *  above. */
    sendInFlightPty(sid, seq, chunk, geometryEpoch) {
      const session = sessions.get(sid);
      const epoch = geometryEpoch ?? session?.geometryEpoch ?? 0;
      peer.send({ type: 'pty.data', sid, seq, chunk, geometryEpoch: epoch });
    },
    /** Sends an arbitrary `session.snapshot` response directly, bypassing
     *  the per-session `snapshotProvider` — used to answer a specific
     *  gap-recovery request with a precisely chosen seq/payload. */
    sendSnapshotNow(sid, seq, snapshot, geometry) {
      const session = sessions.get(sid);
      if (session) {
        session.seq = seq;
        session.buffer = snapshot;
      }
      const fallbackGeometry = session ? sessionGeometry(session) : { cols: 120, rows: 30, epoch: 0 };
      const normalizedGeometry = normalizeGeometry(geometry, fallbackGeometry);
      peer.send({ type: 'session.snapshot', sid, seq, snapshot, geometry: normalizedGeometry });
    },
    sendResizeBarrier(sid, seq, snapshot, geometry) {
      const session = sessions.get(sid);
      if (!session) throw new Error(`unknown session: ${sid}`);
      const normalizedGeometry = normalizeGeometry(geometry, sessionGeometry(session));
      session.cols = normalizedGeometry.cols;
      session.rows = normalizedGeometry.rows;
      session.geometryEpoch = normalizedGeometry.epoch;
      session.seq = seq;
      session.buffer = snapshot;
      if (peer.subscribedSid === sid) {
        peer.send({ type: 'session.snapshot', sid, seq, snapshot, geometry: normalizedGeometry });
      }
    },
    /** Re-broadcasts the session catalog on demand (e.g. after
     *  dynamically adding a session or updating the navigator model). */
    broadcastSessionCatalog() {
      sendSessionCatalog(peer);
    },
    close() {
      peer.close();
    },
  };
}
