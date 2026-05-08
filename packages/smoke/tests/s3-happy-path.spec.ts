// S3 happy-path smoke (Task #2).
//
// Verifies the cloud-mode end-to-end pipeline:
//   browser (Playwright chromium)
//     → Pages dev (wrangler pages dev) reverse-proxy
//       → cf-worker (wrangler dev) TunnelDO
//         → outbound ws → daemon (Tauri-spawned)
//           → node-pty session
//
// Scope: ONE happy path. Multi-session, reconnect, error recovery, UI polish
// are out of scope (see PR body §"Out of scope"). Smoke goes red as long as
// the orchestrator (fixtures/orchestrator.ts) cannot bring up all 3 child
// processes — that itself is part of Phase 1's red signal.
import { test, expect } from '@playwright/test';

// R-13 (Task #31) — pipe SPA-side console / pageerror / requestfailed events
// to the orchestrator's stderr so a red smoke run no longer needs the reader
// to open the headed browser to find out *why* the SPA never reached the
// post-token-boot UI. With these handlers in place a missing /token, a
// failed CORS preflight, or an SPA throw all surface as a `[smoke spa …]`
// line in the same stream as the stage markers.
test.beforeEach(async ({ page }) => {
  page.on('console', m => process.stderr.write(`[smoke spa console.${m.type()}] ${m.text()}\n`));
  page.on('pageerror', e => process.stderr.write(`[smoke spa pageerror] ${e.message}\n${e.stack ?? ''}\n`));
  page.on('requestfailed', r => process.stderr.write(`[smoke spa requestfailed] ${r.url()} -> ${r.failure()?.errorText}\n`));
});

test('cloud-mode happy path: open SPA, create session, run echo, see output', async ({ page }) => {
  // The Pages dev origin; SMOKE_BASE_URL is wired by the orchestrator.
  await page.goto('/');

  // Token boot: in cloud mode the SPA fetches /token via the Pages Function
  // → cf-worker → tunnel → daemon. We assert the SPA reaches the
  // post-token-boot UI rather than rendering the "no token" friendly error.
  await expect(page.getByTestId('session-list')).toBeVisible({ timeout: 30_000 });

  // Create a session — happy path uses default cwd / default args. The "new
  // session" affordance lives in the @ccsm/ui SessionListPage.
  await page.getByRole('button', { name: /new session/i }).click();
  await expect(page.getByTestId('terminal-pane')).toBeVisible({ timeout: 30_000 });

  // Send one command and assert PTY echo. The terminal is xterm.js; we read
  // its rendered DOM rather than poking the terminal API directly.
  //
  // Task #64 (R-22) — click the inner xterm hidden `<textarea
  // aria-label="Terminal input">` rather than the outer `terminal-pane` div.
  // dev-63 verify (R-21) locked the cause: clicking the outer div did not
  // forward focus to xterm's hidden textarea, so `keyboard.type(...)` keystrokes
  // landed on `document.body` and most chars were dropped before reaching
  // xterm's onData (the R-19 verify error-context.md showed only 1 onData
  // event with len=3 for a 21-char type, and the active element was body).
  // R-21's buffer-until-open queue already fixed the WS race; this is a
  // Layer 4 test-contract fix only — production focus behavior is unchanged
  // (a real user clicking the terminal naturally focuses the textarea).
  await page.getByLabel('Terminal input').click();
  // Task #61 (R-21) — wait until the ws actually reaches OPEN before
  // typing. Without this gate, keystrokes raced the createSession→ws-open
  // window (~340ms) and were silently dropped (research-60 confirmed 22
  // chars lost on a single happy-path run). The Layer 1 production fix is
  // the buffer-until-open queue in @ccsm/core SessionRuntime.sendInput;
  // this assertion is the Layer 4 test contract that locks the contract
  // visible to the smoke without depending on the buffer's timing.
  await expect(page.getByTestId('terminal-pane')).toHaveAttribute(
    'data-ws-state',
    'open',
    { timeout: 10_000 },
  );
  // Task #67 (R-23) — use locator.pressSequentially with delay 30ms instead
  // of page.keyboard.type. dev-66 verify on R-22 locked the remaining drop
  // cause: Playwright's default keyboard.type fires keystrokes with delay=0,
  // which xterm's onData handler batches into a single len=3 emission for a
  // 21-char input. pressSequentially with a 30ms inter-key delay paces input
  // closer to a real user, so xterm emits each keystroke as its own onData
  // and the daemon receives the full string. Not a production fix — R-21's
  // buffer-until-open already addressed the production race; this only tunes
  // the Playwright simulation cadence.
  await page
    .getByLabel('Terminal input')
    .pressSequentially('echo hello-from-smoke', { delay: 30 });
  await page.keyboard.press('Enter');

  await expect(page.getByTestId('terminal-pane')).toContainText('hello-from-smoke', {
    timeout: 15_000,
  });

  // Close the session (UI close button — daemon will tear down the PTY).
  // The close button is hidden until the parent <li>.sidebar__session is
  // hovered (CSS rule `.sidebar__session:hover .sidebar__session-close`).
  // Hovering the close button directly is a catch-22 — Playwright requires
  // the target to be visible before hover, but hover is what makes it
  // visible. Hover the parent row first to reveal the close button, then
  // click it. We avoid `{ force: true }` because force bypasses
  // actionability checks and would not exercise the real CSS reveal users
  // experience.
  const sessionRow = page.getByTestId(/^sidebar-session-[0-9a-f]/).first();
  await sessionRow.hover();
  const closeBtn = page.getByTestId(/^sidebar-session-close-/).first();
  await closeBtn.click();
  await expect(page.getByTestId('terminal-pane')).toHaveAttribute('data-ws-state', 'closed', { timeout: 10_000 });
});
