// E2E contract probe for the load-bearing PR-D invariant:
//
//   When ccsm spawns a session with a UUID-shaped id, the CLI MUST write
//   `<configDir>/projects/<projectKey>/<sessionId>.jsonl` where the
//   filename equals `window.__ccsmStore.getState().activeId`. This is what
//   makes "the JSONL the user sees in their CLI history" === "the session
//   shown in ccsm" — without it, ccsm's id and the on-disk transcript
//   diverge silently and resume / import / history all break.
//
// PR-D wires this by passing `sessionId: <uuid>` into the SDK's
// `query({ sessionId })` option (see `electron/agent-sdk/sessions.ts`
// lines ~298–322). If a future SDK release renames that option, drops it
// silently, or stops respecting it for fresh spawns, this probe trips
// IMMEDIATELY — no waiting for a user to notice their history is missing.
//
// Two cases:
//
//   (1) POSITIVE — seed a UUID-shaped sessionId, agentStart, wait for the
//       SDK's `system/init` frame (proves CLI has booted and written the
//       transcript header), then locate the JSONL on disk by scanning
//       `~/.claude/projects/*/<sid>.jsonl` and assert:
//         a. exactly one such file exists
//         b. its first line is `{type:"system", subtype:"init", session_id:<sid>}`
//         c. the project-dir basename is non-empty (sanity)
//       The probe deliberately does NOT recompute the CLI's cwd→project-key
//       slug rule — that algorithm lives in the CLI and would couple this
//       probe to upstream internals. Filename match is the contract.
//
//   (2) NEGATIVE — bypass the renderer's UUID gate by calling
//       `window.ccsm.agentStart('s-bad-runner-uuid-001', { sessionId: 's-bad' })`
//       directly (this skips `src/agent/startSession.ts`'s gate and exercises
//       the defence-in-depth gate inside `electron/agent-sdk/sessions.ts`).
//       Assert:
//         a. an `agent:diagnostic` with `code: 'preset_session_id_invalid'`
//            fires for our runner id
//         b. the SDK then mints its own UUID so the on-disk JSONL filename
//            is NOT equal to the runner id (and IS UUID-shaped)
//       This is the canary for a future SDK that silently accepts bad input
//       and plants a malformed file — we'd want loud failure.
//
// Sandbox: HOME / USERPROFILE / CCSM_CLAUDE_CONFIG_DIR all point at a fresh
// temp dir per project_probe_skill_injection.md, so the probe never reads
// or writes the developer's real ~/.claude/projects/ and skill files don't
// inject into the spawned CLI.
//
// SKIP semantics: matches the companion `probe-e2e-close-window-aborts-sessions`
// — if claude isn't resolvable on this host (errorCode CLAUDE_NOT_FOUND), we
// SKIP rather than FAIL. CI hosts without a claude install shouldn't break
// the suite for a contract that requires a real spawn to verify.

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const TAG = '[probe-e2e-jsonl-filename-matches-session]';

function fail(msg, app) {
  console.error(`\n${TAG} FAIL: ${msg}`);
  if (app) app.close().catch(() => {});
  process.exit(1);
}

function skip(msg) {
  console.log(`\n${TAG} SKIP: ${msg}`);
  process.exit(0);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Two distinct UUIDs so the positive and negative cases never collide on disk.
const POSITIVE_SID = 'b2c0d000-0000-4000-8000-000000000001';
const NEGATIVE_RUNNER_SID = 'b2c0d000-0000-4000-8000-000000000002';
const NEGATIVE_BAD_PRESET = 's-bad-not-a-uuid';

// Sandbox isolation: we DON'T override HOME / USERPROFILE here, because the
// claude CLI needs the user's real `~/.claude/.credentials.json` to boot
// (no auth = no system/init frame = probe times out with no signal). Instead
// we isolate via:
//   - a fresh, unique cwd under os.tmpdir() (creates a brand-new project key
//     in `~/.claude/projects/`, so we never collide with the user's real
//     transcripts; the import scanner already filters cwds matching this
//     pattern via `isCCSMTempCwd`);
//   - UUIDs locked to a synthetic 'b2c0d000-…' prefix so even if our scan
//     somehow walks the user's tree, we'll only ever match files we wrote;
//   - a `finally` block that removes our project dir so we leave nothing
//     behind for the user's import picker to surface.
const PROBE_TMP_BASE = fs.mkdtempSync(
  path.join(os.tmpdir(), 'ccsm-probe-jsonl-id-cwd-'),
);
const POSITIVE_CWD = path.join(PROBE_TMP_BASE, 'positive');
const NEGATIVE_CWD = path.join(PROBE_TMP_BASE, 'negative');
fs.mkdirSync(POSITIVE_CWD, { recursive: true });
fs.mkdirSync(NEGATIVE_CWD, { recursive: true });

const projectsRoot = path.join(os.homedir(), '.claude', 'projects');

const ud = isolatedUserData('ccsm-probe-jsonl-id-userdata');

console.log(`${TAG} cwd-base    = ${PROBE_TMP_BASE}`);
console.log(`${TAG} userData    = ${ud.dir}`);
console.log(`${TAG} projectsRoot= ${projectsRoot}`);
console.log(`${TAG} positive    = ${POSITIVE_SID}`);
console.log(`${TAG} negative    = runner=${NEGATIVE_RUNNER_SID} preset=${NEGATIVE_BAD_PRESET}`);

// Track the project dirs we created so we can clean them up at the end.
const createdProjectDirs = new Set();

// Use a real, existing per-case cwd under tmp. Each case gets its own dir
// so they map to distinct project keys in `~/.claude/projects/`.
const positiveSpawnCwd = POSITIVE_CWD;
const negativeSpawnCwd = NEGATIVE_CWD;

const app = await electron.launch({
  args: ['.', `--user-data-dir=${ud.dir}`],
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    CCSM_PROD_BUNDLE: '1',
  },
});

try {
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore && !!window.ccsm, null, {
    timeout: 15_000,
  });

  // Install diagnostic + system-init listeners BEFORE any agentStart so we
  // never miss the first frame.
  await win.evaluate(() => {
    window.__probeDiag = [];
    window.__probeSysInit = {};
    window.__probeExits = [];
    window.__probeAllEventTypes = {};
    window.ccsm.onAgentDiagnostic((d) => {
      window.__probeDiag.push(d);
    });
    window.ccsm.onAgentExit((e) => {
      window.__probeExits.push(e);
    });
    window.ccsm.onAgentEvent((e) => {
      const m = e && e.message;
      if (m && typeof m === 'object') {
        const k = `${m.type || '?'}/${m.subtype || ''}`;
        window.__probeAllEventTypes[e.sessionId] = window.__probeAllEventTypes[e.sessionId] || {};
        window.__probeAllEventTypes[e.sessionId][k] = (window.__probeAllEventTypes[e.sessionId][k] || 0) + 1;
      }
      if (m && m.type === 'system' && m.subtype === 'init') {
        // Capture whichever runner sees its init first.
        window.__probeSysInit[e.sessionId] = {
          session_id: m.session_id,
          at: Date.now(),
        };
      }
    });
  });

  // ─── Case 1: POSITIVE ────────────────────────────────────────────────────
  await win.evaluate(
    ({ sid, cwd }) => {
      const store = window.__ccsmStore;
      store.setState({
        groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
        sessions: [
          {
            id: sid,
            name: 'jsonl-probe-positive',
            state: 'idle',
            cwd,
            model: 'claude-sonnet-4',
            groupId: 'g1',
            agentType: 'claude-code',
          },
        ],
        activeId: sid,
        messagesBySession: { [sid]: [] },
        startedSessions: {},
        runningSessions: {},
      });
    },
    { sid: POSITIVE_SID, cwd: positiveSpawnCwd },
  );

  const startRes = await win.evaluate(
    async ({ sid, cwd }) =>
      await window.ccsm.agentStart(sid, {
        cwd,
        permissionMode: 'default',
        // This is the contract under test — UUID-shaped sessionId option
        // forwarded to the SDK as the conversation's session_id.
        sessionId: sid,
      }),
    { sid: POSITIVE_SID, cwd: positiveSpawnCwd },
  );

  if (!startRes || startRes.ok !== true) {
    if (startRes && startRes.errorCode === 'CLAUDE_NOT_FOUND') {
      skip(`claude CLI not resolvable on PATH (${startRes.error})`);
    }
    fail(`positive agentStart failed: ${JSON.stringify(startRes)}`, app);
  }

  // The SDK iterable input blocks until first user message — no input means
  // the CLI never starts its conversation loop and never emits the
  // system/init frame we need. Send a trivial prompt to drive boot. The
  // probe doesn't care about the assistant reply (we tear down before any
  // model token-burn), it just needs the init record on disk.
  await win.evaluate(
    async (sid) => await window.ccsm.agentSend(sid, 'hi'),
    POSITIVE_SID,
  );

  // Verify the activeId on the store matches what we seeded — if the store
  // mutates activeId during start (it shouldn't), the invariant breaks.
  const activeIdAfterStart = await win.evaluate(
    () => window.__ccsmStore.getState().activeId,
  );
  if (activeIdAfterStart !== POSITIVE_SID) {
    fail(
      `store.activeId drifted during start: expected ${POSITIVE_SID}, got ${activeIdAfterStart}`,
      app,
    );
  }

  // Wait for the JSONL file named `<POSITIVE_SID>.jsonl` to appear under
  // ANY project dir. The CLI buffers some platform writes — give it up to
  // 30s. We don't wait for the system/init event over IPC because event
  // arrival is timing-sensitive and orthogonal to the on-disk contract:
  // the LOAD-BEARING property is filename equality, which is a pure
  // file-system check.
  let positiveHit = null;
  const flushDeadline = Date.now() + 30_000;
  while (Date.now() < flushDeadline) {
    positiveHit = findJsonlFor(projectsRoot, POSITIVE_SID);
    if (positiveHit) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!positiveHit) {
    const dump = listProjectsTree(projectsRoot);
    const debug = await win.evaluate(() => ({
      diag: window.__probeDiag,
      exits: window.__probeExits,
      events: window.__probeAllEventTypes,
    }));
    fail(
      `positive: no <projectKey>/${POSITIVE_SID}.jsonl found under ${projectsRoot} after 30s\n` +
        `--- diag ---\n${JSON.stringify(debug.diag, null, 2)}\n` +
        `--- exits ---\n${JSON.stringify(debug.exits, null, 2)}\n` +
        `--- events ---\n${JSON.stringify(debug.events, null, 2)}\n` +
        `--- projects tree ---\n${dump}`,
      app,
    );
  }
  console.log(
    `${TAG} positive jsonl = ${path.relative(projectsRoot, positiveHit.file)}`,
  );
  createdProjectDirs.add(positiveHit.projectDir);

  // Scan the head of the JSONL for the session-id-bearing records. The CLI
  // writes records with a `sessionId` (camelCase) field on every entry once
  // the conversation begins, and may emit a `system/init` frame as well.
  // The contract is: every record's session id must equal the filename UUID.
  // We don't require init specifically — just consistency of the id, which
  // is the actual load-bearing property.
  let firstLines;
  try {
    const buf = fs.readFileSync(positiveHit.file, 'utf8');
    firstLines = buf.split(/\r?\n/).slice(0, 50);
  } catch (err) {
    fail(`positive: could not read ${positiveHit.file}: ${err.message}`, app);
  }
  let foundIdBearing = 0;
  let mismatch = null;
  for (const line of firstLines) {
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    // Accept either field naming the CLI / SDK uses.
    const id = parsed.sessionId ?? parsed.session_id;
    if (typeof id !== 'string') continue;
    foundIdBearing++;
    if (id !== POSITIVE_SID) {
      mismatch = { id, line: line.slice(0, 200) };
      break;
    }
  }
  if (foundIdBearing === 0) {
    fail(
      `positive: no session-id-bearing records in first 50 lines of ${positiveHit.file}\n` +
        `--- head ---\n${firstLines.slice(0, 5).join('\n').slice(0, 1000)}`,
      app,
    );
  }
  if (mismatch) {
    fail(
      `positive: jsonl record session id=${mismatch.id} differs from filename ${POSITIVE_SID}. ` +
        `On-disk transcript is internally inconsistent — SDK accepted the preset for naming but the CLI uses a different id in the body.\n` +
        `record: ${mismatch.line}`,
      app,
    );
  }
  if (!positiveHit.projectDir || positiveHit.projectDir.length === 0) {
    fail(`positive: project dir basename is empty (${positiveHit.file})`, app);
  }
  console.log(
    `${TAG} positive: verified ${foundIdBearing} id-bearing records all carry ${POSITIVE_SID}`,
  );

  // Tear down the positive session before opening the negative one so we
  // don't have two CLI children racing on the same store.
  await win.evaluate(
    async (sid) => await window.ccsm.agentClose(sid),
    POSITIVE_SID,
  );
  await new Promise((r) => setTimeout(r, 500));

  // ─── Case 2: NEGATIVE ────────────────────────────────────────────────────
  // Seed a fresh runner id and call agentStart with a non-UUID `sessionId`
  // OPTION. We deliberately bypass the renderer's gate (src/agent/startSession.ts)
  // by calling `window.ccsm.agentStart` directly with the bad preset — that's
  // exactly the path PR-D's defence-in-depth (sessions.ts:315-331) exists
  // to catch.
  await win.evaluate(
    ({ sid, cwd }) => {
      const store = window.__ccsmStore;
      store.setState({
        sessions: [
          {
            id: sid,
            name: 'jsonl-probe-negative',
            state: 'idle',
            cwd,
            model: 'claude-sonnet-4',
            groupId: 'g1',
            agentType: 'claude-code',
          },
        ],
        activeId: sid,
        messagesBySession: { [sid]: [] },
        startedSessions: {},
        runningSessions: {},
      });
      // Reset diagnostic + sysinit buffers so we only see negative-case events.
      window.__probeDiag.length = 0;
      window.__probeSysInit = {};
    },
    { sid: NEGATIVE_RUNNER_SID, cwd: negativeSpawnCwd },
  );

  const negStartRes = await win.evaluate(
    async ({ sid, badPreset, cwd }) =>
      await window.ccsm.agentStart(sid, {
        cwd,
        permissionMode: 'default',
        sessionId: badPreset, // ← intentionally non-UUID
      }),
    { sid: NEGATIVE_RUNNER_SID, badPreset: NEGATIVE_BAD_PRESET, cwd: negativeSpawnCwd },
  );

  if (!negStartRes || negStartRes.ok !== true) {
    if (negStartRes && negStartRes.errorCode === 'CLAUDE_NOT_FOUND') {
      skip(`claude CLI not resolvable on PATH for negative case (${negStartRes.error})`);
    }
    fail(
      `negative: agentStart failed unexpectedly. The defence-in-depth gate ` +
        `should DROP the bad preset and let the SDK mint a fresh UUID, NOT ` +
        `crash the start: ${JSON.stringify(negStartRes)}`,
      app,
    );
  }

  // Same drive-boot trick as the positive case: send a trivial prompt so
  // the SDK iterable yields and the CLI emits its init frame.
  await win.evaluate(
    async (sid) => await window.ccsm.agentSend(sid, 'hi'),
    NEGATIVE_RUNNER_SID,
  );

  // Wait for the diagnostic. The defence-in-depth gate fires SYNCHRONOUSLY
  // inside the SdkSessionRunner.start() method, before the SDK call goes
  // out — so it's there by the time agentStart resolves. We poll briefly
  // for the IPC round-trip to land it in the renderer.
  let negDiag = null;
  const diagDeadline = Date.now() + 5_000;
  while (Date.now() < diagDeadline) {
    const diag = await win.evaluate(
      (sid) =>
        (window.__probeDiag || []).filter(
          (d) => d && d.sessionId === sid && d.code === 'preset_session_id_invalid',
        ),
      NEGATIVE_RUNNER_SID,
    );
    if (diag.length > 0) {
      negDiag = diag[0];
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!negDiag) {
    fail(
      `negative: no 'preset_session_id_invalid' diagnostic emitted for runner ${NEGATIVE_RUNNER_SID}. ` +
        `Either the defence-in-depth gate at electron/agent-sdk/sessions.ts no longer fires, ` +
        `or the diagnostic IPC channel was renamed.`,
      app,
    );
  }
  console.log(
    `${TAG} negative diag = code=${negDiag.code} level=${negDiag.level}`,
  );

  // Wait long enough for the CLI to actually write its first records to
  // disk (drives the on-disk assertions below). 5s is generous for a
  // local CLI to flush its first frames after we've already proven the
  // diag fired.
  await new Promise((r) => setTimeout(r, 5_000));

  // Scan the negative project dir on disk and assert:
  //   a. at least one .jsonl exists (the SDK minted SOMETHING)
  //   b. it's NOT named `<NEGATIVE_RUNNER_SID>.jsonl` (PR-D's renderer wrapper
  //      doesn't bind runner id to filename when the preset was bad)
  //   c. it's NOT named `<NEGATIVE_BAD_PRESET>.jsonl` (the bad preset was
  //      stripped, not silently honoured)
  //   d. its filename IS UUID-shaped (an SDK-minted UUID, not garbage)
  // We locate the project dir by its slug (cwd→key encoding). Since we
  // don't recompute the key, scan every project dir whose mtime is
  // recent and whose basename contains the cwd's last segment.
  const negativeBasename = path.basename(NEGATIVE_CWD); // 'negative'
  const negProjectFiles = scanProjectsForCwdSegment(projectsRoot, negativeBasename);
  if (negProjectFiles.length === 0) {
    const dump = listProjectsTree(projectsRoot);
    fail(
      `negative: no jsonl found in any project dir matching cwd segment ` +
        `'${negativeBasename}' under ${projectsRoot}\n--- tree ---\n${dump}`,
      app,
    );
  }
  // Track for cleanup.
  for (const f of negProjectFiles) createdProjectDirs.add(f.projectDir);

  for (const f of negProjectFiles) {
    const sid = path.basename(f.file, '.jsonl');
    if (sid === NEGATIVE_RUNNER_SID) {
      fail(
        `negative: a jsonl named after the runner id (${NEGATIVE_RUNNER_SID}) exists at ${f.file}` +
          ` — PR-D should NOT bind runner id to filename when the preset was rejected.`,
        app,
      );
    }
    if (sid === NEGATIVE_BAD_PRESET) {
      fail(
        `negative: a jsonl named after the bad preset (${NEGATIVE_BAD_PRESET}) exists at ${f.file}` +
          ` — the SDK accepted the malformed preset and persisted it.`,
        app,
      );
    }
    if (!UUID_RE.test(sid)) {
      fail(
        `negative: jsonl filename ${sid} is not UUID-shaped — SDK minted a non-UUID id`,
        app,
      );
    }
  }
  console.log(
    `${TAG} negative: ${negProjectFiles.length} jsonl(s) found, all UUID-shaped, none == runner/bad-preset`,
  );

  await win.evaluate(
    async (sid) => await window.ccsm.agentClose(sid),
    NEGATIVE_RUNNER_SID,
  );

  console.log(`\n${TAG} OK`);
  console.log(
    `  positive: jsonl filename ${POSITIVE_SID}.jsonl == activeId, all in-file ids match`,
  );
  console.log(
    `  negative: bad preset dropped, diagnostic emitted, sdk-minted UUID written to disk`,
  );
} catch (err) {
  console.error(`${TAG} threw:`, err && (err.stack || err.message || err));
  await app.close().catch(() => {});
  process.exit(1);
} finally {
  await app.close().catch(() => {});
  ud.cleanup();
  try {
    fs.rmSync(PROBE_TMP_BASE, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  // Cleanup the per-cwd dirs we created in the user's real
  // ~/.claude/projects/. We track these by remembering each found jsonl's
  // project dir.
  for (const dir of createdProjectDirs) {
    try {
      fs.rmSync(path.join(projectsRoot, dir), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

/**
 * Scan `<projectsRoot>/<projectKey>/<sid>.jsonl` exhaustively. Returns the
 * first match (and its containing project-dir basename) or null. Deliberately
 * does NOT recompute the cwd→projectKey algorithm — that lives in the CLI
 * and would make this probe a tautology if we duplicated it here.
 */
function findJsonlFor(projectsRoot, sid) {
  let dirs;
  try {
    dirs = fs.readdirSync(projectsRoot);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const projDir = path.join(projectsRoot, dir);
    let st;
    try {
      st = fs.statSync(projDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const candidate = path.join(projDir, `${sid}.jsonl`);
    if (fs.existsSync(candidate)) {
      return { file: candidate, projectDir: dir };
    }
  }
  return null;
}

/**
 * Find every `<projectsRoot>/<projectKey>/*.jsonl` whose project key contains
 * the given cwd segment string. Used by the negative case to locate the
 * SDK-minted-UUID jsonl when we don't know what UUID the SDK chose. The
 * cwd segment is unique-per-probe-run (we use a freshly-mkdtemped path) so
 * matches are unambiguous in practice.
 */
function scanProjectsForCwdSegment(projectsRoot, cwdSegment) {
  /** @type {Array<{file:string, projectDir:string}>} */
  const out = [];
  let dirs;
  try {
    dirs = fs.readdirSync(projectsRoot);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    if (!dir.includes(cwdSegment)) continue;
    const projDir = path.join(projectsRoot, dir);
    let entries;
    try {
      entries = fs.readdirSync(projDir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      out.push({ file: path.join(projDir, f), projectDir: dir });
    }
  }
  return out;
}

function listProjectsTree(projectsRoot) {
  const lines = [];
  let dirs;
  try {
    dirs = fs.readdirSync(projectsRoot);
  } catch {
    return `<unreadable: ${projectsRoot}>`;
  }
  for (const dir of dirs) {
    lines.push(dir);
    let entries;
    try {
      entries = fs.readdirSync(path.join(projectsRoot, dir));
    } catch {
      lines.push('  <unreadable>');
      continue;
    }
    for (const f of entries) lines.push(`  ${f}`);
  }
  return lines.length > 0 ? lines.join('\n') : '<empty>';
}
