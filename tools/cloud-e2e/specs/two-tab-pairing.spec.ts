// Two-tab pairing spec (Task #82).
//
// Simulates two independent machines hitting the deployed ccsm-worker.jiahuigu.workers.dev
// SPA simultaneously. Each "machine" gets its own browser context (fresh
// storage / cookies — equivalent to a separate browser profile), opens the
// SPA, creates a new session, types a unique echo, and asserts that the
// terminal pane contains *its own* uuid (not the other tab's).
//
// Selectors / wait gates are taken from packages/smoke/tests/s3-happy-path.spec.ts:
//   - data-testid="session-list"   — post-token-boot UI is mounted
//   - sidebar-new-session button   — create a session
//   - data-testid="terminal-pane"  — xterm container; carries data-ws-state
//   - aria-label="Terminal input"  — xterm's hidden textarea (focus target)
//
// Token bootstrap: the SPA's hostConfig.ts already does the 3-step priority
// chain (URL ?token= → fetch /token → fail). ccsm-worker.jiahuigu.workers.dev serves /token
// via the Pages Function + Worker tunnel, so we just navigate to '/' and
// let the SPA do its thing.
//
// R-34 diagnostic gate (Task #95):
//   - data-ws-state="open" only proves the ws handshake reached
//     status==='attached' on the renderer side. It does NOT prove the PTY
//     actually emitted any bytes the browser was able to write into xterm.
//     Verifier-93 reported the harness still red after R-32 with dev claim
//     "xterm hidden textarea not visible"; we cannot tell from the previous
//     gate whether (a) xterm DOM never mounted, (b) PTY frames never reached
//     the browser, or (c) the textarea is CSS-hidden by SPA bug.
//   - This file therefore (1) installs a browser-side WebSocket frame
//     counter via addInitScript, (2) waits for an actual shell prompt to
//     render in .xterm-rows before clicking input, (3) on any failure dumps
//     screenshot + xterm container innerHTML + ws frame counts so the next
//     iteration has ground-truth evidence rather than narrative.
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface TabHandle {
  context: BrowserContext;
  page: Page;
  label: string;
  uuid: string;
}

const DUMP_DIR = join(process.cwd(), 'test-results', 'r34-diag');

// Browser-side init script: wraps WebSocket so we can count open / message /
// close events per tab. Exposed as window.__ccsmWsStats. Running as
// addInitScript means it loads before any SPA code touches WebSocket.
const WS_PROBE_INIT = `
(() => {
  if (window.__ccsmWsStats) return;
  const stats = {
    constructed: 0,
    opened: 0,
    messages: 0,
    bytes: 0,
    closed: 0,
    errors: 0,
    urls: [],
    lastErrorMsg: null,
    lastCloseCode: null,
  };
  window.__ccsmWsStats = stats;
  const NativeWS = window.WebSocket;
  function PatchedWS(url, protocols) {
    stats.constructed += 1;
    try { stats.urls.push(String(url)); } catch (_) {}
    const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
    ws.addEventListener('open', () => { stats.opened += 1; });
    ws.addEventListener('message', (ev) => {
      stats.messages += 1;
      const d = ev.data;
      if (typeof d === 'string') stats.bytes += d.length;
      else if (d && d.byteLength != null) stats.bytes += d.byteLength;
    });
    ws.addEventListener('close', (ev) => {
      stats.closed += 1;
      stats.lastCloseCode = ev.code;
    });
    ws.addEventListener('error', (ev) => {
      stats.errors += 1;
      stats.lastErrorMsg = (ev && ev.message) || 'unknown';
    });
    return ws;
  }
  PatchedWS.prototype = NativeWS.prototype;
  PatchedWS.CONNECTING = NativeWS.CONNECTING;
  PatchedWS.OPEN = NativeWS.OPEN;
  PatchedWS.CLOSING = NativeWS.CLOSING;
  PatchedWS.CLOSED = NativeWS.CLOSED;
  window.WebSocket = PatchedWS;
})();
`;

async function openFreshTab(
  browser: import('@playwright/test').Browser,
  label: string,
): Promise<TabHandle> {
  const context = await browser.newContext();
  // Install ws probe BEFORE any page navigation runs SPA code.
  await context.addInitScript(WS_PROBE_INIT);
  const page = await context.newPage();

  // Mirror smoke's diagnostics: pipe SPA console / pageerror / requestfailed
  // into the test process stderr so a red run is debuggable from the trace
  // alone without re-running headed.
  page.on('console', m =>
    process.stderr.write(`[${label} console.${m.type()}] ${m.text()}\n`),
  );
  page.on('pageerror', e =>
    process.stderr.write(`[${label} pageerror] ${e.message}\n${e.stack ?? ''}\n`),
  );
  page.on('requestfailed', r =>
    process.stderr.write(
      `[${label} requestfailed] ${r.url()} -> ${r.failure()?.errorText}\n`,
    ),
  );

  await page.goto('/');
  return { context, page, label, uuid: randomUUID() };
}

interface DiagSnapshot {
  label: string;
  url: string;
  wsState: string | null;
  paneVisible: boolean;
  xtermPresent: boolean;
  xtermRowsText: string;
  xtermInnerHtmlLen: number;
  textareaPresent: boolean;
  textareaVisible: boolean;
  textareaRect: { width: number; height: number; visible: boolean } | null;
  wsStats: unknown;
  consoleErrorCount: number;
}

async function snapshot(tab: TabHandle): Promise<DiagSnapshot> {
  const page = tab.page;
  const wsState = await page
    .getByTestId('terminal-pane')
    .getAttribute('data-ws-state')
    .catch(() => null);
  const paneVisible = await page
    .getByTestId('terminal-pane')
    .isVisible()
    .catch(() => false);

  const xtermInfo = await page.evaluate(() => {
    const pane = document.querySelector('[data-testid="terminal-pane"]');
    const xtermScreen = document.querySelector('.xterm-screen');
    const rows = document.querySelector('.xterm-rows');
    const textarea = document.querySelector(
      'textarea[aria-label="Terminal input"]',
    ) as HTMLTextAreaElement | null;
    let rect: { width: number; height: number; visible: boolean } | null = null;
    let textareaVisible = false;
    if (textarea) {
      const r = textarea.getBoundingClientRect();
      const cs = getComputedStyle(textarea);
      const visible =
        cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
      rect = { width: r.width, height: r.height, visible };
      // xterm's textarea is intentionally off-screen but should still be
      // event-receptive (display!='none' && visibility!='hidden').
      textareaVisible = visible;
    }
    return {
      xtermPresent: !!xtermScreen,
      xtermRowsText: rows ? (rows as HTMLElement).innerText.slice(0, 4000) : '',
      xtermInnerHtmlLen: pane ? pane.innerHTML.length : 0,
      textareaPresent: !!textarea,
      textareaVisible,
      rect,
    };
  });

  const wsStats = await page.evaluate(
    () => (window as unknown as { __ccsmWsStats?: unknown }).__ccsmWsStats ?? null,
  );

  return {
    label: tab.label,
    url: page.url(),
    wsState,
    paneVisible,
    xtermPresent: xtermInfo.xtermPresent,
    xtermRowsText: xtermInfo.xtermRowsText,
    xtermInnerHtmlLen: xtermInfo.xtermInnerHtmlLen,
    textareaPresent: xtermInfo.textareaPresent,
    textareaVisible: xtermInfo.textareaVisible,
    textareaRect: xtermInfo.rect,
    wsStats,
    consoleErrorCount: 0,
  };
}

async function dumpFailure(tab: TabHandle, stage: string, err: unknown): Promise<void> {
  await mkdir(DUMP_DIR, { recursive: true }).catch(() => {});
  const stamp = `${Date.now()}-${tab.label}-${stage}`;
  try {
    await tab.page.screenshot({
      path: join(DUMP_DIR, `${stamp}.png`),
      fullPage: true,
    });
  } catch (e) {
    process.stderr.write(`[${tab.label} dump] screenshot failed: ${(e as Error).message}\n`);
  }
  try {
    const html = await tab.page
      .getByTestId('terminal-pane')
      .innerHTML()
      .catch(() => '<terminal-pane not found>');
    await writeFile(join(DUMP_DIR, `${stamp}-pane.html`), html, 'utf8');
  } catch (e) {
    process.stderr.write(`[${tab.label} dump] pane html failed: ${(e as Error).message}\n`);
  }
  try {
    const snap = await snapshot(tab);
    await writeFile(
      join(DUMP_DIR, `${stamp}-snap.json`),
      JSON.stringify({ stage, error: String(err), ...snap }, null, 2),
      'utf8',
    );
    process.stderr.write(
      `\n[R-34 DIAG ${tab.label} stage=${stage}] ${JSON.stringify({
        wsState: snap.wsState,
        paneVisible: snap.paneVisible,
        xtermPresent: snap.xtermPresent,
        xtermRowsTextLen: snap.xtermRowsText.length,
        xtermRowsTextPreview: snap.xtermRowsText.slice(0, 300),
        textareaPresent: snap.textareaPresent,
        textareaVisible: snap.textareaVisible,
        textareaRect: snap.textareaRect,
        wsStats: snap.wsStats,
        url: snap.url,
      })}\n`,
    );
  } catch (e) {
    process.stderr.write(`[${tab.label} dump] snapshot failed: ${(e as Error).message}\n`);
  }
}

// PTY-output gate: poll the live xterm rows until a shell prompt character
// renders. We accept '$ ', '> ', '# ', 'PS ' (cmd / bash / zsh / fish /
// pwsh). Anything in xterm-rows that's longer than 1 char is also acceptable
// (some shells emit MOTD / banner before prompt — that still proves PTY→ws→
// xterm is alive). 30s upper bound matches the other gates.
async function waitForPtyOutput(tab: TabHandle, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  while (Date.now() < deadline) {
    const text = await tab.page
      .evaluate(() => {
        const rows = document.querySelector('.xterm-rows');
        return rows ? (rows as HTMLElement).innerText : '';
      })
      .catch(() => '');
    lastText = text;
    if (
      /[\$>#]\s/.test(text) ||
      /PS\s/.test(text) ||
      // Any non-trivial multi-line content also proves bytes flowed.
      text.replace(/\s+/g, '').length >= 3
    ) {
      return text;
    }
    await tab.page.waitForTimeout(250);
  }
  throw new Error(
    `[${tab.label}] PTY output gate timed out after ${timeoutMs}ms; last xterm-rows text (${lastText.length} chars) = ${JSON.stringify(lastText.slice(0, 200))}`,
  );
}

async function bootSession(tab: TabHandle): Promise<string> {
  // Wait for the post-token-boot UI; if /token failed (no tunnel / bad
  // worker / cf outage) this never resolves and the test fails fast.
  try {
    await expect(tab.page.getByTestId('session-list')).toBeVisible({
      timeout: 30_000,
    });
  } catch (err) {
    await dumpFailure(tab, 'session-list', err);
    throw err;
  }

  await tab.page.getByTestId('sidebar-new-session').click();
  try {
    await expect(tab.page.getByTestId('terminal-pane')).toBeVisible({
      timeout: 30_000,
    });
  } catch (err) {
    await dumpFailure(tab, 'terminal-pane-visible', err);
    throw err;
  }

  // Read the sid off the just-rendered session row. The sidebar tags each
  // row with `data-testid="sidebar-session-<sid>"` (Sidebar.tsx:337). We
  // need the sid for the cross-tab uniqueness assertion below.
  const row = tab.page.getByTestId(/^sidebar-session-[0-9a-f]/).first();
  try {
    await expect(row).toBeVisible({ timeout: 30_000 });
  } catch (err) {
    await dumpFailure(tab, 'sidebar-session-row', err);
    throw err;
  }
  const testId = await row.getAttribute('data-testid');
  if (!testId) throw new Error(`[${tab.label}] sidebar session row has no data-testid`);
  const sid = testId.replace(/^sidebar-session-/, '');

  // Wait for the ws to actually reach OPEN (renderer-side) — same gate the
  // smoke spec uses. NOT sufficient on its own (R-34): see PTY gate below.
  try {
    await expect(tab.page.getByTestId('terminal-pane')).toHaveAttribute(
      'data-ws-state',
      'open',
      { timeout: 30_000 },
    );
  } catch (err) {
    await dumpFailure(tab, 'ws-state-open', err);
    throw err;
  }

  // R-34 PTY-output gate: ws=open is necessary but not sufficient. Wait for
  // bytes to actually flow PTY → ws → xterm before we click input. If this
  // fails we dump enough state to classify the failure.
  try {
    await waitForPtyOutput(tab);
  } catch (err) {
    await dumpFailure(tab, 'pty-output', err);
    throw err;
  }

  return sid;
}

async function echoUuid(tab: TabHandle): Promise<void> {
  const cmd = `echo cloud-e2e-${tab.uuid}`;
  // Click xterm's hidden textarea, not the outer pane (smoke R-22 fix —
  // clicking the pane div doesn't forward focus to xterm so chars get
  // dropped onto document.body).
  try {
    await tab.page.getByLabel('Terminal input').click();
  } catch (err) {
    await dumpFailure(tab, 'textarea-click', err);
    throw err;
  }
  // pressSequentially + 30ms delay paces input closer to a real user so
  // xterm emits each keystroke as its own onData (smoke R-23 fix —
  // page.keyboard.type batches into len=3 onData events).
  await tab.page.getByLabel('Terminal input').pressSequentially(cmd, { delay: 30 });
  await tab.page.keyboard.press('Enter');
}

test('two tabs, two sessions, each tab sees only its own PTY echo', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const tabA = await openFreshTab(browser, 'tabA');
  const tabB = await openFreshTab(browser, 'tabB');

  try {
    // Boot both sessions in parallel — this is the whole point: two
    // "machines" hitting the cloud SPA at the same time. R-27 is what makes
    // this work; before R-27 the second tab is expected to be red.
    const [sidA, sidB] = await Promise.all([bootSession(tabA), bootSession(tabB)]);

    expect(sidA, 'tabA sid must be non-empty').toBeTruthy();
    expect(sidB, 'tabB sid must be non-empty').toBeTruthy();
    expect(
      sidA,
      'tabA and tabB must get distinct sids (each tab is a separate session)',
    ).not.toEqual(sidB);

    // Type each tab's unique echo command in parallel.
    await Promise.all([echoUuid(tabA), echoUuid(tabB)]);

    // Each tab's terminal must contain ITS OWN uuid.
    try {
      await expect(tabA.page.getByTestId('terminal-pane')).toContainText(
        `cloud-e2e-${tabA.uuid}`,
        { timeout: 30_000 },
      );
    } catch (err) {
      await dumpFailure(tabA, 'echo-not-rendered', err);
      throw err;
    }
    try {
      await expect(tabB.page.getByTestId('terminal-pane')).toContainText(
        `cloud-e2e-${tabB.uuid}`,
        { timeout: 30_000 },
      );
    } catch (err) {
      await dumpFailure(tabB, 'echo-not-rendered', err);
      throw err;
    }

    // Cross-contamination check: tabA's terminal must NOT contain tabB's
    // uuid (and vice versa). If the cloud routes both tabs to the same
    // PTY, this assertion catches it.
    const aText = await tabA.page.getByTestId('terminal-pane').innerText();
    const bText = await tabB.page.getByTestId('terminal-pane').innerText();
    expect(aText, 'tabA must not see tabB uuid').not.toContain(tabB.uuid);
    expect(bText, 'tabB must not see tabA uuid').not.toContain(tabA.uuid);
  } finally {
    await tabA.context.close();
    await tabB.context.close();
  }
});
