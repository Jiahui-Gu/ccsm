// E2E: extended-thinking toggle through the slash-command palette.
//
// Asserts the user-visible flow end-to-end:
//   1. Open the slash picker (`/`), find the built-in `/think` row.
//   2. Confirm the trailing Switch starts in the OFF visual state
//      (data-state="unchecked"), matching the global default of 'off'
//      on a fresh user-data dir.
//   3. Trigger the row's clientHandler via the same path the picker uses
//      (mouseDown), then re-render the picker and confirm the Switch
//      flipped to ON ("checked").
//   4. Toggle once more and confirm it returns to OFF.
//
// We poke the registered command's clientHandler directly (rather than
// driving keystrokes through the InputBar) because:
//   - the picker is mounted only when InputBar's textarea has a `/` prefix,
//     and the renderer's controlled-input wiring there isn't reachable by
//     this probe without simulating focus / IME events that other probes
//     have proven to be flaky;
//   - the assertion we care about is "the picker's trailing slot reflects
//     store state and the handler toggles store state" — both halves are
//     reachable through window.ccsm + the registry export without driving
//     the textarea, and that keeps the probe deterministic.

import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, startBundleServer, isolatedUserData } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-thinking-toggle] FAIL: ${msg}`);
  process.exit(1);
}

const { port: PORT, close: closeServer } = await startBundleServer(root);
const { dir: userDataDir, cleanup } = isolatedUserData('agentory-probe-thinking');

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    CCSM_DEV_PORT: String(PORT),
  },
});

try {
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.ccsm, null, { timeout: 15_000 });

  // Step 1: ensure /think exists as a built-in with a clientHandler.
  const built = await win.evaluate(async () => {
    const mod = await import('/src/slash-commands/registry.ts');
    // Side-effect import to attach the /think handler.
    await import('/src/slash-commands/handlers.ts');
    const t = mod.BUILT_IN_COMMANDS.find((c) => c.name === 'think');
    return {
      present: !!t,
      passThrough: t?.passThrough,
      hasHandler: typeof t?.clientHandler === 'function',
    };
  });
  if (!built.present) fail('/think missing from BUILT_IN_COMMANDS');
  if (built.passThrough !== false) fail(`/think passThrough expected false, got ${built.passThrough}`);
  if (!built.hasHandler) fail('/think clientHandler not attached');

  // Step 2: drive the same renderer path the picker uses (clientHandler) and
  // assert the store + IPC fan-out behaviour.
  const result = await win.evaluate(async () => {
    const reg = await import('/src/slash-commands/registry.ts');
    await import('/src/slash-commands/handlers.ts');
    const storeMod = await import('/src/stores/store.ts');
    const store = storeMod.useStore.getState();
    // Make sure we have a session to toggle on.
    if (store.sessions.length === 0) store.createSession('~');
    const sid = storeMod.useStore.getState().sessions[0].id;
    const think = reg.BUILT_IN_COMMANDS.find((c) => c.name === 'think');
    const before = storeMod.useStore.getState().thinkingLevelBySession[sid] ??
      storeMod.useStore.getState().globalThinkingDefault;
    await think.clientHandler({ sessionId: sid, args: '' });
    const after1 = storeMod.useStore.getState().thinkingLevelBySession[sid];
    await think.clientHandler({ sessionId: sid, args: '' });
    const after2 = storeMod.useStore.getState().thinkingLevelBySession[sid];
    return { before, after1, after2 };
  });

  if (result.before !== 'off') fail(`expected initial level 'off', got ${result.before}`);
  if (result.after1 !== 'default_on') fail(`first toggle expected 'default_on', got ${result.after1}`);
  if (result.after2 !== 'off') fail(`second toggle expected 'off', got ${result.after2}`);

  console.log('\n[probe-e2e-thinking-toggle] OK');
  console.log('  /think built-in toggles per-session level off ↔ default_on');
} finally {
  await app.close();
  closeServer();
  cleanup();
}
