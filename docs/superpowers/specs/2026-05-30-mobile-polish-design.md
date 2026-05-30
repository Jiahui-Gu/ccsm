# Mobile Remote — Track A: Real-Device Polish (Design)

Date: 2026-05-30
Status: approved direction (user picked A and authorized autonomous push to merge)
Scope owner: parent session

## Goal

Make the already-phone-usable mobile remote client (`electron/remote/`) actually
pleasant on a real phone held in a real hand. PR #1422 made it *functional*
(resize, keybar, reconnect, seq-correct paint). This track closes the
real-device UX gaps that only show up on a touchscreen with a soft keyboard.

Non-goal: the transport abstraction (Track C), multi-client robustness
(Track B), and network-latency tuning (tailscale). Those are separate specs.

## Problem statement (verified against current `mobilePage.ts`)

The served page lays out as a flex column: `header / #sessions / #terminal /
#keybar`, and refits via a `window.resize` listener calling
`fitAddon.proposeDimensions()`. On a phone this has four concrete failures:

1. **Soft-keyboard occlusion.** On iOS Safari the on-screen keyboard does *not*
   shrink the layout viewport — it overlays it. `window.innerHeight` stays full,
   so our flex column keeps its height and the bottom of `#terminal` (and the
   whole `#keybar`) slides *under* the keyboard. The user types blind. Android
   Chrome resizes the visual viewport but the timing/units differ; relying on
   `window.resize` alone is unreliable.

2. **Orientation changes don't always refit.** Some mobile browsers fire
   `orientationchange` *before* the new viewport dimensions settle, so a single
   `resize`-driven `proposeDimensions()` reads stale geometry and the terminal
   ends up mis-sized until an unrelated reflow.

3. **No way to summon the keyboard / focus is fiddly.** `term.open()` mounts
   xterm but on touch there's no obvious affordance to focus the hidden textarea
   and raise the keyboard; tapping the terminal body is inconsistent.

4. **Not installable.** No web app manifest, no `apple-mobile-web-app-*` meta, no
   `theme-color`. The user runs it as a browser tab with URL chrome eating
   vertical space, instead of a full-screen standalone app.

## Design

All client-side work stays inside the single inlined page in
`electron/remote/mobilePage.ts`. One small server change adds a manifest route.

### 1. visualViewport-driven layout (fixes 1 + 2)

Drive layout height from `window.visualViewport` instead of trusting the flex
column to track the keyboard:

- On `visualViewport` `resize` and `scroll`, set the body height (or a CSS
  custom property `--app-height`) to `visualViewport.height`, so the column is
  always exactly the *visible* area above the keyboard. The keybar then stays
  pinned just above the keyboard rather than hiding behind it.
- After each geometry change, call the existing `scheduleFit()` (already
  debounced at 120 ms) so xterm re-proposes dims and we emit `session.resize`
  only when cols/rows actually change (the existing `lastSentCols/Rows` guard
  already prevents spam).
- Feature-detect: if `window.visualViewport` is absent (old browser / desktop),
  fall back to the current `window.resize` path. No regression for desktop dev.

This is the load-bearing fix. visualViewport is the standard, supported API for
exactly this problem on both iOS Safari and Android Chrome.

### 2. Reliable orientation refit (fixes 2)

Add an `orientationchange` listener that schedules a refit on a slightly longer
delay (e.g. a second `scheduleFit()` after ~250 ms) so it reads *settled*
geometry. Cheap, idempotent, guarded by the existing cols/rows dedupe.

### 3. Tap-to-focus (fixes 3)

On a `touchend`/`click` anywhere in `#terminal`, call `term.focus()`. xterm's
hidden textarea getting focus is what raises the soft keyboard. Keep it minimal —
no custom keyboard, no gesture layer. The hardware/software keyboard plus the
existing keybar (Esc/Tab/Ctrl/arrows/^C/Enter) is the input surface.

### 4. PWA manifest + standalone meta (fixes 4)

- **Server:** add a `/manifest.webmanifest` route in `mobileRemoteServer.ts`,
  token-gated the same way `/` is (reuse `tokenMatches`). Add a small
  `sendJson(res, body)` helper to `remoteHttp.ts` next to `sendHtml`/`sendText`.
  The manifest references `start_url` carrying the token so an installed icon
  reconnects authenticated. `display: "standalone"`, `theme-color: #0b1020`,
  `background_color: #0b1020`, name/short_name "CCSM Remote". No icon files
  shipped initially (manifest icons are optional for `standalone`); can add a
  data-URI icon later if needed.
- **Page head:** add `<link rel="manifest" href="/manifest.webmanifest?token=…">`
  (token read from `location.search` so it matches the current session),
  `<meta name="theme-color" content="#0b1020">`,
  `<meta name="apple-mobile-web-app-capable" content="yes">`,
  `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`.

## Files touched

- `electron/remote/mobilePage.ts` — visualViewport layout, orientation refit,
  tap-to-focus, head meta + manifest link. (Bulk of the change; all client JS.)
- `electron/remote/mobileRemoteServer.ts` — `/manifest.webmanifest` route.
- `electron/remote/remoteHttp.ts` — `sendJson` helper.
- `electron/__tests__/mobileRemoteServer.test.ts` — assert manifest route is
  token-gated (200 with token, 401 without) and returns valid JSON with
  `display: standalone`.

## Error handling / edge cases

- `visualViewport` absent → fall back to `window.resize` (desktop, old browsers).
- Manifest route without/with-wrong token → 401, same shape as `/`.
- Token in `start_url`/manifest link is the *existing* session token already in
  the URL — no new secret, no new logging. It is already in the page URL the user
  loaded; the manifest does not widen exposure.
- Refit dedupe (`lastSentCols/Rows`) already prevents resize spam from the extra
  listeners.

## Testing

1. **Unit (committed):** manifest route token-gating + JSON shape in
   `mobileRemoteServer.test.ts`.
2. **Headless browser proof (scratch harness, rebuilt — `.mrharness/` was not
   committed):** boot the real compiled server against a fake ptyHost, load the
   real served HTML in headless Chromium, and assert:
   - body/app height tracks a simulated `visualViewport.height` shrink (keyboard
     open) — the keybar stays within the visible box.
   - `/manifest.webmanifest?token=…` is reachable and parses.
   - existing PR #1422 behaviors still pass (mount+paint, fit→resize, live poll,
     reconnect) — regression guard.
   Screenshots preserved to `%TEMP%/ccsm-mobile-proof/`.
3. **Real device:** the *only* thing headless can't prove is the actual iOS/
   Android soft-keyboard interaction and install-to-homescreen. Per the user's
   instruction, the user does the final real-phone pass after the track lands.
   This spec explicitly flags soft-keyboard occlusion and standalone install as
   the two dimensions requiring the user's real-device confirmation.

## Local gate before push

`npm run typecheck` + `npm run lint` + `npm test` + the harness-ui proof must all
be green locally before opening the PR (per local-pre-push-gate memory).

## Out of scope (explicitly deferred)

- WS heartbeat / multi-client / disconnect buffering → Track B.
- Transport abstraction (`window.ccsm` IPC/WS unification) → Track C.
- tailscale latency tuning → network-layer, not code; can't headless-verify.
