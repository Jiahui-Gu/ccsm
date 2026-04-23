# Focus-Restore Probe Flake Investigation

## Symptom

`scripts/probe-e2e-a11y-focus-restore.mjs` (added in PR #164) was flaky.
Contracts 2 and 3 (Settings and CommandPalette focus restoration) sometimes
asserted `document.activeElement` was the session `<li>` and sometimes
found the chat textarea instead.

## What the probe asserted

> Click session row -> focus stays on `<li>` -> open Settings (Cmd+,) ->
> close (Esc) -> focus restored to the same `<li>`.

It also tried to "anchor" focus on the row via `await sessionLi.focus()`
plus a 120ms `waitForTimeout` in the hope that the post-click focus
orchestration would settle, then poll-confirm the row was focused.

## What actually happens in the product

`selectSession()` in `src/stores/store.ts` (lines 567-571) intentionally
bumps `focusInputNonce`:

```ts
// Bump so the InputBar pulls focus -- matches Claude Desktop's UX
// when clicking a session in the sidebar.
focusInputNonce: s.focusInputNonce + 1
```

`InputBar` watches that nonce (lines 212-230) and pulls focus into the
chat textarea:

```ts
const ae = document.activeElement as HTMLElement | null;
if (ae && ae !== textareaRef.current) {
  const tag = ae.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || ae.isContentEditable) return;
}
textareaRef.current?.focus();
```

The skip-guard explicitly does NOT cover the session `<li>` (which has
`role="option"`, not `INPUT`/`TEXTAREA`/`contentEditable`). So after
ANY mouse click on a session row, focus ends up on the textarea, by
design.

The arrow-key sidebar navigation path bypasses `selectSession()` and
keeps focus on the row -- but the probe uses mouse clicks, so it always
hits the focus-theft path.

## Why "anchoring" didn't actually anchor

The probe called `sessionLi.focus()` after a 120ms wait, then polled.
But the nonce-driven effect runs on the NEXT React render after the
nonce changes -- not synchronously with the click. With a 120ms wait
the effect usually had already fired, so the manual `.focus()` won.
But under load, the render could be deferred past the wait, the manual
focus would land first, then the effect would fire and yank focus
into the textarea AFTER the probe's poll succeeded -- and the same
yank would still be in flight when the probe opened Settings, so on
close the captured `previousRef` would be the textarea, not the row.

Net result: probe was racing the product's own focus orchestration.

## Real user flow

1. Click session row.
2. Focus immediately moves to chat textarea (intentional, matches
   Claude Desktop).
3. User opens Settings via Cmd+, (or CommandPalette via Ctrl+F).
4. `useFocusRestore` captures the textarea.
5. User dismisses with Esc.
6. `handleCloseAutoFocus` restores focus to the textarea.

## Verdict

No product bug. The probe was asserting an unreachable intermediate
state ("focus on `<li>` after a mouse click"). Rewriting contracts 2
and 3 to assert the real contract -- "focus restored to whatever was
focused before the dialog opened, in practice the textarea" -- removes
the race entirely.

The fallback-selector branch in `useFocusRestore` (when capture is
null, fall back to active session row) is correct defensive code but
is unreachable from the click flow above. Cover it with a JSDOM unit
test, not an e2e probe.
