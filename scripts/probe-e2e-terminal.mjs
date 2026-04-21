// Verify Terminal pane integration: seed a Bash tool block into the store,
// expand it in the UI, and confirm the xterm host renders with ANSI-colored
// text converted into real DOM colors.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-terminal] FAIL: ${msg}`);
  process.exit(1);
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' }
});
const win = await appWindow(app);
win.on('console', (m) => console.log(`[renderer:${m.type()}] ${m.text()}`));
win.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.__agentoryStore, null, { timeout: 15000 });

const sessionId = await win.evaluate(() => {
  const st = window.__agentoryStore.getState();
  // Dismiss tutorial if present (the landing page covers ChatStream).
  if (!st.tutorialSeen && st.setTutorialSeen) st.setTutorialSeen(true);
  const existing = st.sessions.find((s) => s.cwd === '~/terminal-probe');
  if (!existing) st.createSession('~/terminal-probe');
  const st2 = window.__agentoryStore.getState();
  const probe = st2.sessions.find((s) => s.cwd === '~/terminal-probe') ?? st2.sessions[st2.sessions.length - 1];
  if (probe && st2.activeId !== probe.id) st2.selectSession(probe.id);
  return window.__agentoryStore.getState().activeId;
});
console.log(`[probe-terminal] active session: ${sessionId}`);
if (!sessionId) fail('no active session id');

// Seed a Bash tool block with ANSI-colored output (green + red).
await win.evaluate((sid) => {
  const ESC = String.fromCharCode(27);
  const ansi = `total 8\r\n${ESC}[32mdrwxr-xr-x${ESC}[0m 2 user user 4096 Apr 21 10:00 ${ESC}[34msrc${ESC}[0m\r\n-rw-r--r-- 1 user user  123 Apr 21 10:00 ${ESC}[31merror.log${ESC}[0m\r\n`;
  window.__agentoryStore.getState().appendBlocks(sid, [
    {
      kind: 'tool',
      id: 'tu-probe',
      name: 'Bash',
      brief: 'ls -la --color=always',
      expanded: false,
      toolUseId: 'tu-probe',
      input: { command: 'ls -la --color=always' },
      result: ansi
    }
  ]);
}, sessionId);

await new Promise((r) => setTimeout(r, 200));

// Sanity: confirm the block landed in state under the active session.
const blockSummary = await win.evaluate((sid) => {
  const st = window.__agentoryStore.getState();
  const blocks = st.messagesBySession[sid] ?? [];
  return blocks.map((b) => ({ kind: b.kind, id: b.id, name: b.name }));
}, sessionId);
console.log('[probe-terminal] blocks in active session:', JSON.stringify(blockSummary));

// Sanity: is ChatStream mounted at all?
const chatRendered = await win.evaluate(() => {
  // Our ChatStream renders either EmptyState (text "Ready when you are.")
  // or a list of blocks inside a max-w-[1100px] container.
  const ready = !!document.body.innerText?.includes('Ready when you are.');
  const hasList = !!document.querySelector('.max-w-\\[1100px\\]');
  const toolButtons = document.querySelectorAll('.font-mono.text-sm button[aria-expanded]').length;
  return { ready, hasList, toolButtons };
});
console.log('[probe-terminal] chat render state:', JSON.stringify(chatRendered));

// Expand the Bash tool row — target the chat-stream ToolBlock specifically.
// ChatStream ToolBlock is wrapped in `.font-mono.text-sm` so that class
// combo uniquely disambiguates from sidebar group-header expand buttons.
const candidates = win.locator('.font-mono.text-sm button[aria-expanded]');
const btnCount = await candidates.count();
console.log(`[probe-terminal] chat tool expand buttons: ${btnCount}`);
if (btnCount === 0) fail('no ChatStream ToolBlock button found');
await candidates.first().click();
await new Promise((r) => setTimeout(r, 500));

// The xterm host element should appear.
const hostCount = await win.locator('[data-testid="terminal-host"]').count();
if (hostCount !== 1) {
  const summary = await win.evaluate(() => {
    const toolButtons = Array.from(document.querySelectorAll('.font-mono.text-sm button[aria-expanded]'));
    return toolButtons.map((b) => ({
      aria: b.getAttribute('aria-expanded'),
      outer: b.outerHTML.slice(0, 300),
      nextSiblingOuter: b.parentElement?.outerHTML?.slice(0, 2500) ?? null
    }));
  });
  console.log('--- chat tool buttons after click ---');
  console.log(JSON.stringify(summary, null, 2));
  fail(`expected 1 terminal-host, got ${hostCount}`);
}

// xterm renders into a .xterm container inside the host.
const xtermCount = await win.locator('[data-testid="terminal-host"] .xterm').count();
if (xtermCount !== 1) fail(`expected 1 .xterm inside host, got ${xtermCount}`);

// The rendered screen should contain our filenames somewhere.
const screenText = await win.locator('[data-testid="terminal-host"] .xterm-screen').innerText();
if (!screenText.includes('src')) fail(`terminal missing 'src' text; got: ${screenText.slice(0, 200)}`);
if (!screenText.includes('error.log')) fail(`terminal missing 'error.log'; got: ${screenText.slice(0, 200)}`);

// Grab a small DOM snippet so the PR has visual evidence.
const snippet = await win.evaluate(() => {
  const host = document.querySelector('[data-testid="terminal-host"]');
  if (!host) return '(no host)';
  // Just take the inner first 600 chars.
  return host.innerHTML.slice(0, 600);
});

console.log('[probe-terminal] OK');
console.log('  terminal host mounted, xterm rendered, ANSI payload visible');
console.log('--- DOM snippet ---');
console.log(snippet);

await app.close();
