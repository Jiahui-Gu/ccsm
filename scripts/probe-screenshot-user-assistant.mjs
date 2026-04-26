// Throwaway screenshot probe for PR #345 visual proof. Boots Electron with
// the production bundle, seeds a session containing user + assistant
// messages, then crops a screenshot of the chat surface so the PR body can
// show before/after frames. Not registered in run-all-e2e (it's not an
// assertion). Safe to delete after the PR merges.
//
// Usage: node scripts/probe-screenshot-user-assistant.mjs --out=after.png

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData, isolatedClaudeConfigDir } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const outArg = process.argv.find((a) => a.startsWith('--out='));
const outPath = path.resolve(REPO_ROOT, outArg ? outArg.slice('--out='.length) : 'screenshot.png');

const userData = isolatedUserData('ccsm-shot');
const claudeCfg = isolatedClaudeConfigDir('ccsm-shot-cfg');

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userData.dir}`],
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    CCSM_PROD_BUNDLE: '1',
    CCSM_E2E_HIDDEN: '1',
    CCSM_FIRST_RUN_GUARD: '0',
    CLAUDE_CONFIG_DIR: claudeCfg.dir
  }
});

const win = await appWindow(app);
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(800);

await win.evaluate(() => {
  window.__ccsmStore.setState({
    groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
    sessions: [{ id: 's1', name: 'demo', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
    activeId: 's1',
    tutorialSeen: true,
    messagesBySession: {
      s1: [
        { kind: 'user', id: 'u1', text: 'How do I add a unit test for the new debounce helper?' },
        { kind: 'assistant', id: 'a1', text: 'Add a `tests/util/debounce.test.ts` file. Import `debounce` from `src/util/debounce`, then assert that the function only fires once after the delay window elapses. Use vitest fake timers to control the clock.' },
        { kind: 'user', id: 'u2', text: 'Got it. Can you show me what the file should look like?' },
        { kind: 'assistant', id: 'a2', text: 'Here is a minimal version that covers the leading-edge and trailing-edge cases. The fake-timer setup keeps the test deterministic across CI machines.' }
      ]
    }
  });
});

await win.setViewportSize({ width: 1100, height: 700 }).catch(() => {});
await win.waitForTimeout(500);

const box = await win.evaluate(() => {
  const el = document.querySelector('[data-chat-stream]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
});

if (!box) {
  console.error('chat stream not found');
  await app.close();
  process.exit(1);
}

await win.screenshot({
  path: outPath,
  clip: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
});

console.log('wrote', outPath);
await app.close();
