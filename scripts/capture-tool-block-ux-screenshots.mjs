// One-off screenshot capture for the tool-block UX triad PR (A2-NEW-5/6/7).
// Not wired into run-all-e2e — it's a manual helper for PR evidence.
//
// Run: node scripts/capture-tool-block-ux-screenshots.mjs
// Output: scripts/.artifacts/tool-block-ux-*.png
import { _electron as electron } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(__dirname, '.artifacts');
fs.mkdirSync(outDir, { recursive: true });

const app = await electron.launch({
  args: [root],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'production', AGENTORY_E2E: '1', AGENTORY_PROD_BUNDLE: '1' }
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
// Wait for store bootstrap.
await win.waitForFunction(() => !!window.__agentoryStore, null, { timeout: 10000 });

// Seed session so the chat stream has a home to live in.
await win.evaluate(() => {
  window.__agentoryStore.setState({
    cliStatus: { state: 'found', binaryPath: '<harness>', version: null }
  });
});

// Scenario 1: running Bash tools showing elapsed counters. We seed three
// in-flight blocks with faked startedAt spacing so the screenshot shows
// distinct times. Since startedAt is captured on render we let each block
// mount a few hundred ms apart.
async function scenarioElapsed() {
  const sid = 's-shot-elapsed';
  await win.evaluate((s) => {
    window.__agentoryStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: s, name: 'elapsed', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: s,
      runningSessions: { [s]: true },
      messagesBySession: {
        [s]: [
          { kind: 'user', id: 'u', text: 'run three things in parallel' },
          { kind: 'tool', id: 't1', name: 'Bash', brief: 'ping -n 5 127.0.0.1', expanded: false, toolUseId: 'tu1' }
        ]
      }
    });
  }, sid);
  await win.waitForTimeout(1200);
  await win.evaluate((s) => {
    const st = window.__agentoryStore.getState();
    const prev = st.messagesBySession[s] ?? [];
    window.__agentoryStore.setState({
      messagesBySession: {
        ...st.messagesBySession,
        [s]: [...prev, { kind: 'tool', id: 't2', name: 'Bash', brief: 'npm test', expanded: false, toolUseId: 'tu2' }]
      }
    });
  }, sid);
  await win.waitForTimeout(1200);
  await win.evaluate((s) => {
    const st = window.__agentoryStore.getState();
    const prev = st.messagesBySession[s] ?? [];
    window.__agentoryStore.setState({
      messagesBySession: {
        ...st.messagesBySession,
        [s]: [...prev, { kind: 'tool', id: 't3', name: 'Bash', brief: 'docker build .', expanded: false, toolUseId: 'tu3' }]
      }
    });
  }, sid);
  await win.waitForTimeout(1100);

  const out = path.join(outDir, 'tool-block-ux-elapsed.png');
  await win.screenshot({ path: out });
  console.log('saved', out);
}

async function scenarioDropped() {
  const sid = 's-shot-dropped';
  await win.evaluate((s) => {
    window.__agentoryStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: s, name: 'dropped', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: s,
      runningSessions: {},
      messagesBySession: {
        [s]: [
          { kind: 'user', id: 'u', text: 'read three files' },
          { kind: 'tool', id: 't1', name: 'Read', brief: 'src/foo.ts', expanded: false, toolUseId: 'tu1', result: 'export const foo = 1;\n' },
          { kind: 'tool', id: 't2', name: 'Read', brief: 'src/bar.ts', expanded: false, toolUseId: 'tu2', result: '' },
          { kind: 'tool', id: 't3', name: 'Read', brief: 'src/baz.ts', expanded: false, toolUseId: 'tu3', result: 'export const baz = 3;\n' }
        ]
      }
    });
  }, sid);
  await win.waitForTimeout(400);
  const out = path.join(outDir, 'tool-block-ux-dropped.png');
  await win.screenshot({ path: out });
  console.log('saved', out);
}

async function scenarioStalled() {
  const sid = 's-shot-stalled';
  // Flip renderer Date.now so the stall threshold (30s) has passed.
  // We install a Date proxy that reports "now + 45s" forever in this
  // session; only screenshot so we don't worry about leakage.
  await win.evaluate((s) => {
    const realNow = Date.now.bind(Date);
    const shift = 45_000;
    Date.now = () => realNow() + shift;
    window.__agentoryStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: s, name: 'stalled', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: s,
      runningSessions: { [s]: true },
      messagesBySession: {
        [s]: [
          { kind: 'user', id: 'u', text: 'do the slow thing' },
          { kind: 'tool', id: 't1', name: 'Bash', brief: 'slow-command --wait', expanded: false, toolUseId: 'tu1' }
        ]
      }
    });
  }, sid);
  await win.waitForTimeout(400);
  const out = path.join(outDir, 'tool-block-ux-stalled.png');
  await win.screenshot({ path: out });
  console.log('saved', out);
}

await scenarioElapsed();
await scenarioDropped();
await scenarioStalled();

await app.close();
