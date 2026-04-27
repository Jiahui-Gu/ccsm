# Dogfood R2 — bug log

Tracks UX gaps + bugs found during dogfood round 2. One section per
focus point. Append PASS sections too so coverage is visible.

## fp7: PASS

Stop / interrupt during streaming. All four checks green via
`scripts/dogfood-r2-fp7-probe.mjs` against the prebuilt prod bundle.

- A — Stop button visibility during streaming
  - `A-idle` PASS — Stop hidden in idle (composer shows Send only).
  - `A-streaming` PASS — Stop visible while `runningSessions[sid]` true.
    Captured `data-morph-state` attribute on the morph button to confirm
    it's the same primary button cycling Send -> Stop, not a separate
    chip. Screenshots: `01-idle.png`, `02-streaming-stop-visible.png`.
- B — Stop actually interrupts
  - PASS — clicking Stop synchronously sets `interruptedSessions[sid]=true`,
    `lastTurnEnd[sid]='interrupted'`, clears the message queue, and
    leaves the in-flight assistant block in place (no delete, no
    duplicate). After the synthesized SDK result frame, `runningSessions`
    flips false and the button morphs back to Send.
    `B-morph-back` PASS, `B-block-integrity` PASS.
    Screenshot: `03-after-stop.png`.
- C — Send next message after Stop
  - PASS — textarea is interactable, accepts input, Send button enabled.
    Continue-after-interrupt hint (task322 affordance) renders above the
    composer. Screenshot: `04-typing-followup.png`. Did NOT actually
    submit the follow-up since the probe seeds store directly (no real
    claude.exe wired into a long-running stream); that path is already
    covered by `harness-agent` `caseEscInterrupt` and
    `caseInterruptBanner` plus the real-CLI `caseSend` /
    `caseStreamingPartialFrames` cases.
- D — Stop with NO active stream (idempotent)
  - PASS — invoking `window.ccsm.agentInterrupt(sid)` while
    `runningSessions[sid]` is false leaves both `interruptedSessions`
    and `runningSessions` empty. The InputBar's `stop()` short-circuits
    on `if (!running) return;` (InputBar.tsx:776) before touching
    state, so no spurious "Interrupted" banner appears either.

### Notes

- The Stop UI is implemented as a morph of the primary Send button
  (`InputBar.tsx` ~L1196 — `data-morph-state="stop"|"send"`), not a
  separate chip. Esc also works as a global accelerator (line 590-614)
  and is regression-tested in `harness-agent.mjs` `caseEscInterrupt`
  including the inline `role="dialog"` exception.
- Existing harness coverage (`caseEscInterrupt`, `caseInterruptBanner`,
  `caseStreamingPartialFrames`) already locks the contract. This probe
  adds dogfood-grade screenshots + an end-to-end click-driven path
  through the real Send button to complement the keyboard-driven
  harness assertions.
- Continue-after-interrupt hint (task322) confirmed visible after stop
  with empty composer.

### Artifacts

- Probe: `scripts/dogfood-r2-fp7-probe.mjs`
- Screenshots: `docs/screenshots/dogfood-r2/fp7-stop/01..05*.png`
- Summary JSON: `docs/screenshots/dogfood-r2/fp7-stop/probe-summary.json`
