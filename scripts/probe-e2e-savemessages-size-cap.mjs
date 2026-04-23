// E2E: db:saveMessages caps renderer-supplied payload size. The DB column
// is unbounded TEXT, so without a cap a malicious or buggy renderer could
// pin the WAL with gigabytes of JSON and balloon agentory.db past disk
// budget. Caps live in electron/main.ts:
//   - MAX_SESSION_ID_LEN  64   (uuid-ish session ids, ~36 chars)
//   - MAX_BLOCKS          50_000
//   - MAX_BLOCK_BYTES     1_000_000   (per-block JSON length)
//
// Asserts:
//   1. Oversized session id    → { ok:false, error:'payload_too_large' }
//      and DB unchanged for that id (loadMessages returns []).
//   2. Too many blocks          → same.
//   3. A single oversized block is dropped with a warn but the rest of
//      the payload still saves successfully (returns { ok:true }) and
//      loadMessages returns only the small blocks.

import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, startBundleServer, isolatedUserData } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-savemessages-size-cap] FAIL: ${msg}`);
  process.exit(1);
}

const { port: PORT, close: closeServer } = await startBundleServer(root);
const { dir: userDataDir, cleanup } = isolatedUserData('agentory-probe-savecap');

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    AGENTORY_DEV_PORT: String(PORT)
  }
});

try {
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.agentory, null, { timeout: 15_000 });

  const result = await win.evaluate(async () => {
    const out = {};
    // 1. Oversized sessionId.
    const longId = 'x'.repeat(200);
    out.bigId = await window.agentory.saveMessages(longId, [{ id: 'a', kind: 'user' }]);
    out.bigIdLoaded = await window.agentory.loadMessages(longId);
    // 2. Too many blocks (well above MAX_BLOCKS=50_000).
    const tooManyBlocks = Array.from({ length: 60_000 }, (_, i) => ({ id: `b${i}`, kind: 'user' }));
    out.tooMany = await window.agentory.saveMessages('s-too-many', tooManyBlocks);
    out.tooManyLoaded = await window.agentory.loadMessages('s-too-many');
    // 3. One oversized block among small ones — should drop the giant
    //    block and persist only the small ones.
    const giant = 'x'.repeat(1_500_000);
    const mixed = [
      { id: 'small-1', kind: 'user' },
      { id: 'big', kind: 'user', text: giant },
      { id: 'small-2', kind: 'assistant' }
    ];
    out.mixed = await window.agentory.saveMessages('s-mixed', mixed);
    out.mixedLoaded = await window.agentory.loadMessages('s-mixed');
    return out;
  });

  // 1.
  if (!result.bigId || result.bigId.ok !== false || result.bigId.error !== 'payload_too_large') {
    fail(`oversized sessionId expected payload_too_large, got ${JSON.stringify(result.bigId)}`);
  }
  if (!Array.isArray(result.bigIdLoaded) || result.bigIdLoaded.length !== 0) {
    fail(`DB should be untouched for oversized sessionId; loaded=${JSON.stringify(result.bigIdLoaded)}`);
  }
  // 2.
  if (!result.tooMany || result.tooMany.ok !== false || result.tooMany.error !== 'payload_too_large') {
    fail(`too-many-blocks expected payload_too_large, got ${JSON.stringify(result.tooMany)}`);
  }
  if (!Array.isArray(result.tooManyLoaded) || result.tooManyLoaded.length !== 0) {
    fail(`DB should be untouched for too-many-blocks; loaded length=${result.tooManyLoaded?.length}`);
  }
  // 3.
  if (!result.mixed || result.mixed.ok !== true) {
    fail(`mixed payload expected ok:true (giant dropped, rest saved), got ${JSON.stringify(result.mixed)}`);
  }
  if (!Array.isArray(result.mixedLoaded) || result.mixedLoaded.length !== 2) {
    fail(`expected 2 surviving blocks (small-1 + small-2), got ${result.mixedLoaded?.length}`);
  }
  const ids = result.mixedLoaded.map((b) => b.id).sort();
  if (ids.join(',') !== 'small-1,small-2') {
    fail(`surviving block ids expected [small-1,small-2], got [${ids.join(',')}]`);
  }

  console.log('\n[probe-e2e-savemessages-size-cap] OK');
  console.log('  size caps enforced; oversized payloads rejected, individual oversized blocks dropped');
} finally {
  await app.close();
  closeServer();
  cleanup();
}
