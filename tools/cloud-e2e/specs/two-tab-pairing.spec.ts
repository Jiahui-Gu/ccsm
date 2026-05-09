// Two-tab pairing spec (Task #82).
//
// Simulates two independent machines hitting the deployed cc-sm.pages.dev
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
// chain (URL ?token= → fetch /token → fail). cc-sm.pages.dev serves /token
// via the Pages Function + Worker tunnel, so we just navigate to '/' and
// let the SPA do its thing.
//
// Pre-R-27 expectation: with the single-token / single-tunnel cloud model,
// the second context is expected to fail (PTY output never appears or both
// tabs share one session). After R-27 lands, both tabs should each see
// their own sid and their own echoed uuid. This spec is the acceptance
// gate for R-27.
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

interface TabHandle {
  context: BrowserContext;
  page: Page;
  label: string;
  uuid: string;
}

async function openFreshTab(
  browser: import('@playwright/test').Browser,
  label: string,
): Promise<TabHandle> {
  const context = await browser.newContext();
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

async function bootSession(tab: TabHandle): Promise<string> {
  // Wait for the post-token-boot UI; if /token failed (no tunnel / bad
  // worker / cf outage) this never resolves and the test fails fast.
  await expect(tab.page.getByTestId('session-list')).toBeVisible({
    timeout: 30_000,
  });

  await tab.page.getByTestId('sidebar-new-session').click();
  await expect(tab.page.getByTestId('terminal-pane')).toBeVisible({
    timeout: 30_000,
  });

  // Read the sid off the just-rendered session row. The sidebar tags each
  // row with `data-testid="sidebar-session-<sid>"` (Sidebar.tsx:337). We
  // need the sid for the cross-tab uniqueness assertion below.
  const row = tab.page.getByTestId(/^sidebar-session-[0-9a-f]/).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  const testId = await row.getAttribute('data-testid');
  if (!testId) throw new Error(`[${tab.label}] sidebar session row has no data-testid`);
  const sid = testId.replace(/^sidebar-session-/, '');

  // Wait for the ws to actually reach OPEN before we type — same gate the
  // smoke spec uses. Without this, keystrokes race the createSession →
  // ws-open window (~340ms) and chars get dropped.
  await expect(tab.page.getByTestId('terminal-pane')).toHaveAttribute(
    'data-ws-state',
    'open',
    { timeout: 30_000 },
  );

  return sid;
}

async function echoUuid(tab: TabHandle): Promise<void> {
  const cmd = `echo cloud-e2e-${tab.uuid}`;
  // Click xterm's hidden textarea, not the outer pane (smoke R-22 fix —
  // clicking the pane div doesn't forward focus to xterm so chars get
  // dropped onto document.body).
  await tab.page.getByLabel('Terminal input').click();
  // pressSequentially + 30ms delay paces input closer to a real user so
  // xterm emits each keystroke as its own onData (smoke R-23 fix —
  // page.keyboard.type batches into len=3 onData events).
  await tab.page.getByLabel('Terminal input').pressSequentially(cmd, { delay: 30 });
  await tab.page.keyboard.press('Enter');
}

test('two tabs, two sessions, each tab sees only its own PTY echo', async ({
  browser,
}) => {
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
    await expect(tabA.page.getByTestId('terminal-pane')).toContainText(
      `cloud-e2e-${tabA.uuid}`,
      { timeout: 30_000 },
    );
    await expect(tabB.page.getByTestId('terminal-pane')).toContainText(
      `cloud-e2e-${tabB.uuid}`,
      { timeout: 30_000 },
    );

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
