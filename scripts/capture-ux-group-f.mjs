// One-off screenshot capture for UX audit Group F (task #310 follow-up).
// Boots the harness electron app, seeds:
//   1. a session with assistant text + tool block (ChatStream gap)
//   2. a session with an unanswered AskUserQuestion (QuestionBlock body+footer)
//   3. opens the SettingsDialog (Field margin-bottom vs panel padding)
//
// Writes 3 region screenshots per --label run:
//   docs/screenshots/group-f-<label>-chat.png
//   docs/screenshots/group-f-<label>-question.png
//   docs/screenshots/group-f-<label>-settings.png
//
// Usage:
//   node scripts/capture-ux-group-f.mjs --label=before
//   node scripts/capture-ux-group-f.mjs --label=after

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const labelArg = process.argv.find((a) => a.startsWith('--label=')) ?? '--label=before';
const label = labelArg.slice('--label='.length);
const outDir = path.join(REPO_ROOT, 'docs/screenshots');
fs.mkdirSync(outDir, { recursive: true });

const env = {
  ...process.env,
  CCSM_E2E_HIDDEN: '1',
  CCSM_PROD_BUNDLE: '1',
  CCSM_OPEN_IN_EDITOR_NOOP: '1'
};

const app = await electron.launch({
  args: [path.join(REPO_ROOT, 'dist/electron/main.js')],
  env
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 20_000 });

// Reset prefs and seed a session, then append assistant + tool blocks via
// store actions so ChatStream re-renders with content.
await win.evaluate(() => {
  try { window.localStorage.removeItem('ccsm:preferences'); } catch {}
  const st = window.__ccsmStore;
  st.setState({
    groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
    sessions: [
      {
        id: 's-cap-f', name: 'group-f-capture', state: 'idle', cwd: 'C:/x',
        model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code'
      }
    ],
    activeId: 's-cap-f',
    messagesBySession: { 's-cap-f': [] },
    tutorialSeen: true
  });
});
await win.waitForTimeout(200);
await win.evaluate(() => {
  const st = window.__ccsmStore.getState();
  st.appendBlocks('s-cap-f', [
    { kind: 'user', id: 'u1', text: 'List the files in src/.' },
    {
      kind: 'assistant',
      id: 'a1',
      segments: [{ kind: 'text', text: 'I will scan the directory and report back.' }]
    },
    {
      kind: 'tool',
      id: 't1',
      toolUseId: 'tu1',
      name: 'Bash',
      input: { command: 'ls src/' },
      result: 'components\nstores\nelectron\n'
    },
    {
      kind: 'assistant',
      id: 'a2',
      segments: [{ kind: 'text', text: 'src/ contains components, stores, and electron sources.' }]
    }
  ]);
});
await win.waitForTimeout(500);

// 1. Chat stream — capture the actual rendered chat wrapper.
const vp = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
const chatRect = await win.evaluate(() => {
  const main = document.querySelector('main');
  if (!main) return null;
  const candidates = Array.from(main.querySelectorAll('div'));
  const wrap = candidates.find((el) => {
    const cs = getComputedStyle(el);
    return cs.display === 'flex'
      && cs.flexDirection === 'column'
      && el.className.includes('max-w-[1100px]');
  });
  if (!wrap) return null;
  const r = wrap.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
});
if (chatRect) {
  const pad = 8;
  await win.screenshot({
    path: path.join(outDir, `group-f-${label}-chat.png`),
    clip: {
      x: Math.max(0, Math.round(chatRect.x - pad)),
      y: Math.max(0, Math.round(chatRect.y - pad)),
      width: Math.min(vp.w, Math.round(chatRect.w + pad * 2)),
      height: Math.min(vp.h - Math.round(chatRect.y), Math.round(chatRect.h + pad * 2))
    }
  });
} else {
  await win.screenshot({ path: path.join(outDir, `group-f-${label}-chat.png`) });
}

// 2. Seed a question block — pure renderer state, mirrors harness-perm cases.
await win.evaluate(() => {
  const st = window.__ccsmStore.getState();
  st.appendBlocks('s-cap-f', [
    {
      kind: 'question',
      id: 'q-cap-f',
      questions: [
        {
          question: 'Which files should we keep?',
          options: [
            { label: 'Only .ts files' },
            { label: 'All source files' },
            { label: 'Skip generated assets' }
          ]
        }
      ]
    }
  ]);
});
await win.waitForSelector('[data-testid="question-submit"]', { timeout: 5000 });
await win.waitForTimeout(200);

const qboxRect = await win.evaluate(() => {
  const submit = document.querySelector('[data-testid="question-submit"]');
  if (!submit) return null;
  // Walk up to the question card container (the motion.div with role=dialog).
  let el = submit;
  for (let i = 0; i < 10 && el; i += 1) {
    if (el.getAttribute && el.getAttribute('role') === 'dialog') break;
    el = el.parentElement;
  }
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
});
if (qboxRect) {
  const pad = 8;
  await win.screenshot({
    path: path.join(outDir, `group-f-${label}-question.png`),
    clip: {
      x: Math.max(0, Math.round(qboxRect.x - pad)),
      y: Math.max(0, Math.round(qboxRect.y - pad)),
      width: Math.min(vp.w, Math.round(qboxRect.w + pad * 2)),
      height: Math.min(vp.h, Math.round(qboxRect.h + pad * 2))
    }
  });
} else {
  // Fallback: full-window if we couldn't locate.
  await win.screenshot({ path: path.join(outDir, `group-f-${label}-question.png`) });
}

// 3. Open Settings dialog. Use store openSettings if available, else click.
const opened = await win.evaluate(() => {
  const st = window.__ccsmStore.getState();
  if (typeof st.openSettings === 'function') {
    st.openSettings('appearance');
    return 'store';
  }
  return null;
});
if (!opened) {
  // Fallback: click the Settings button.
  const settingsBtn = win.locator('button', { hasText: /^Settings$/ }).first();
  await settingsBtn.click();
}
await win.waitForSelector('[role="dialog"][aria-label]', { timeout: 5000 });
await win.waitForTimeout(300);

const dialogRect = await win.evaluate(() => {
  const d = document.querySelector('[role="dialog"][data-modal-dialog], [role="dialog"][aria-modal="true"]');
  if (!d) return null;
  const r = d.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
});
if (dialogRect) {
  const pad = 12;
  await win.screenshot({
    path: path.join(outDir, `group-f-${label}-settings.png`),
    clip: {
      x: Math.max(0, Math.round(dialogRect.x - pad)),
      y: Math.max(0, Math.round(dialogRect.y - pad)),
      width: Math.min(vp.w, Math.round(dialogRect.w + pad * 2)),
      height: Math.min(vp.h, Math.round(dialogRect.h + pad * 2))
    }
  });
} else {
  await win.screenshot({ path: path.join(outDir, `group-f-${label}-settings.png`) });
}

console.log(
  `wrote docs/screenshots/group-f-${label}-{chat,question,settings}.png ` +
  `(vp=${vp.w}x${vp.h})`
);

await app.close();
