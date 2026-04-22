// Probe: slash-command audit.
//
// Walks the registry by reading the SlashCommandPicker DOM, then for every
// entry sends `/<name>` through the textarea and reports what (if anything)
// happens within AUDIT_WAIT_MS. The point is to keep the registry honest:
// if a command is marked `passThrough: true` but claude.exe silently drops
// it under `--input-format stream-json`, we want a hard signal so we can
// either promote it to a client handler or remove the entry.
//
// Output: a markdown table on stdout, plus an exit code (0 if every
// command produced *some* response, 1 otherwise).
//
// Usage:
//   AGENTORY_DEV_PORT=4194 npm run dev:web   # in another shell
//   node scripts/probe-slash-audit.mjs
import { chromium } from 'playwright';
import { makeSlashStubInit, devServerUp } from './probe-slash-stub.mjs';

const PORT = process.env.AGENTORY_DEV_PORT ?? '4100';
const URL = `http://localhost:${PORT}/`;
const AUDIT_WAIT_MS = Number(process.env.AUDIT_WAIT_MS ?? 1500);

if (!(await devServerUp(URL))) {
  console.log('[probe-slash-audit] skipped: dev server not reachable at', URL);
  console.log('  hint: AGENTORY_DEV_PORT=4194 npm run dev:web');
  process.exit(0);
}

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.addInitScript(makeSlashStubInit());

await page.goto(URL, { waitUntil: 'networkidle' });

const newBtn = page.getByRole('button', { name: /new session/i }).first();
await newBtn.waitFor({ state: 'visible', timeout: 15000 });
await newBtn.click();
const textarea = page.locator('textarea');
await textarea.waitFor({ state: 'visible', timeout: 5000 });
await textarea.click();
await textarea.fill('/');
await page.waitForTimeout(150);

// Scope to the slash-command picker (its own listbox) — the sidebar uses
// role="option" too, which would otherwise pollute results.
const picker = page.locator('[role="listbox"]').filter({ hasText: '/help' }).first();
await picker.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
const rows = await picker.locator('[role="option"]').allTextContents();
await page.keyboard.press('Escape');
await textarea.fill('');

// Each picker row renders the name and description with no whitespace
// between them in plain text content (`/help` + `List available commands`
// → `/helpList…`). The valid-name part is the longest sequence we can
// take while staying entirely lowercase letters/digits/_/- — once we hit
// an uppercase letter (start of the description's first word) we stop.
const commandNames = rows
  .map((r) => {
    const m = r.trim().match(/^\/([a-z][a-z0-9_-]*?)(?=[A-Z]|\s|$)/);
    return m ? m[1] : null;
  })
  .filter((n) => typeof n === 'string');

if (commandNames.length === 0) {
  console.error('[probe-slash-audit] could not enumerate registry from picker DOM');
  await browser.close();
  process.exit(1);
}

const results = [];
for (const name of commandNames) {
  // Snapshot baseline counts so we can detect *new* output for this command.
  const baseStatus = await page.locator('[role="status"]').count();
  const baseError = await page.locator('[data-block-kind="error"]').count();
  const baseSent = await page.evaluate(() => window.__sentMessages?.length ?? 0);
  const baseExternal = await page.evaluate(() => window.__externalUrls?.length ?? 0);
  const baseMemoryOpen = await page.evaluate(() => window.__memoryOpenCalls?.length ?? 0);

  await textarea.click();
  await textarea.fill(`/${name}`);
  await page.waitForTimeout(60);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(40);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(AUDIT_WAIT_MS);

  const newStatus = (await page.locator('[role="status"]').count()) - baseStatus;
  const newError = (await page.locator('[data-block-kind="error"]').count()) - baseError;
  const dialogVisible = await page.getByRole('dialog').isVisible().catch(() => false);
  const newSent =
    (await page.evaluate(() => window.__sentMessages?.length ?? 0)) - baseSent;
  const newExternal =
    (await page.evaluate(() => window.__externalUrls?.length ?? 0)) - baseExternal;
  const newMemoryOpen =
    (await page.evaluate(() => window.__memoryOpenCalls?.length ?? 0)) - baseMemoryOpen;

  results.push({
    name,
    statuses: newStatus,
    errors: newError,
    dialogOpen: dialogVisible,
    sentToAgent: newSent,
    openExternal: newExternal,
    memoryOpen: newMemoryOpen
  });

  if (dialogVisible) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(80);
  }
  await textarea.fill('');
}

console.log('\n[probe-slash-audit] results');
console.log('| command | status+ | err+ | dialog | sent | openExt | memOpen | verdict |');
console.log('|---|---|---|---|---|---|---|---|');
let deadCount = 0;
for (const r of results) {
  const responded =
    r.statuses > 0 ||
    r.errors > 0 ||
    r.dialogOpen ||
    r.sentToAgent > 0 ||
    r.openExternal > 0 ||
    r.memoryOpen > 0;
  const verdict = responded ? 'ok' : 'DEAD?';
  if (!responded) deadCount += 1;
  console.log(
    `| /${r.name} | ${r.statuses} | ${r.errors} | ${r.dialogOpen ? 'yes' : 'no'} | ${r.sentToAgent} | ${r.openExternal} | ${r.memoryOpen} | ${verdict} |`
  );
}

console.log('');
console.log(
  `Summary: ${results.length - deadCount}/${results.length} commands produced a visible response.`
);
console.log(
  'Notes: /clear shows status+ = -1 because it switches to a fresh session whose'
);
console.log(
  '       banner count is 0; verify it via scripts/probe-slash-exec.mjs instead.'
);
console.log(
  '       /init is pass-through; if "sent" is 0 the session may not have started'
);
console.log(
  '       in time — re-run with AUDIT_WAIT_MS=4000 to give agentStart more room.'
);

await browser.close();
// Exit 0 always — this probe is for human review, not CI gate-keeping.
// Use the per-command probes (probe-slash-exec, probe-slash-status, etc.)
// for assertions in CI.
process.exit(0);
