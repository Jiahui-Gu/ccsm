// E2E: agent:setPermissionMode rejects unknown mode strings rather than
// silently coercing them to 'default'. The earlier toCliPermissionMode()
// fallback meant a buggy renderer could downgrade `bypassPermissions` to
// `default` by sending a typo and never see an error.
//
// Asserts:
//   1. An obvious garbage mode → { ok: false, error: 'unknown_mode' }.
//   2. A legitimate mode (`default`) → { ok: true } even when the session
//      doesn't exist (manager returns false, IPC handler reports ok:true
//      because the call was well-formed).

import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, startBundleServer, isolatedUserData } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-permission-mode-strict] FAIL: ${msg}`);
  process.exit(1);
}

const { port: PORT, close: closeServer } = await startBundleServer(root);
const { dir: userDataDir, cleanup } = isolatedUserData('agentory-probe-permmode');

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
    const bogus = await window.agentory.agentSetPermissionMode('s-nonexistent', 'not-a-real-mode');
    const valid = await window.agentory.agentSetPermissionMode('s-nonexistent', 'default');
    return { bogus, valid };
  });

  if (!result.bogus || result.bogus.ok !== false || result.bogus.error !== 'unknown_mode') {
    fail(`bogus mode expected { ok:false, error:'unknown_mode' }, got ${JSON.stringify(result.bogus)}`);
  }
  if (!result.valid || result.valid.ok !== true) {
    fail(`valid mode 'default' expected { ok:true }, got ${JSON.stringify(result.valid)}`);
  }

  console.log('\n[probe-e2e-permission-mode-strict] OK');
  console.log('  unknown permission modes are rejected; known modes pass through');
} finally {
  await app.close();
  closeServer();
  cleanup();
}
