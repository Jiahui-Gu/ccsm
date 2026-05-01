# Review of chapter 01: Goals and non-goals
Reviewer: R1 (feature-preservation)
Round: 1

## Findings

### P1-1 (must-fix): G6 "Auto-start at OS boot" introduces a NEW user-facing product setting; justify or scope it as a hard prerequisite
**Where**: chapter 01 §1, goal G6; chapter 09 M4 deliverable #7
**Issue**: G6 adds a new Settings toggle + tray menu item + persistent OS-level startup behavior (Win startup folder shortcut / launchd `RunAtLoad` / systemd `WantedBy=default.target`). This is a brand-new product surface (new toggle, new tray menu entry) and a new persistent OS interaction the user did not have in v0.3. The chapter justifies it as "remote access depends on the daemon being up" — that framing makes it a hard prerequisite for G4 (web client reachable), but the spec does not say "feature is required ONLY because remote-access daemon must be up; if the user keeps Electron always-running, this toggle is not exposed". It currently reads as a generally-useful feature being added "while we're at it".
**Why P1**: per the user's rule ("v0.4 实际也是多加了个前端，也应该尽量不要改 feature"), even prerequisite features need the chapter to make the prerequisite linkage tight. Without an explicit "this exists ONLY to support remote access" framing, future PRs may grow it (auto-start UX polish, scheduling, etc.) as if it were a first-class feature. Reviewer (R1) cannot tell from current text whether the "tray menu item" component is strictly necessary (Settings pane alone could suffice).
**Suggested fix**: in §1 G6, add an explicit subsection: "Why surfaced in tray menu (not just Settings): <reason>" — OR drop the tray menu item and keep only the Settings toggle (smaller new surface). Also add to §4 (anti-goals) something like: "A4'. We will NOT iterate on auto-start UX in v0.4 beyond the single toggle; it is a remote-access prerequisite, not a feature axis."

### P2-1 (nice-to-have): make the "+frontend additive, no feature change" framing visible in §1 (primary goals header), not just §3 N3
**Where**: chapter 01, between §1 header and G1
**Issue**: The strong framing ("v0.4 is fundamentally a +frontend change ... not a feature redesign") lives in the chapter context block but is not echoed at the start of §1. A reader skimming primary goals might miss it. N3 in §3 ("Feature redesigns of the renderer") restates it but is a non-goal note rather than a top-of-section invariant.
**Why P2**: cosmetic. Improves discoverability of the discipline that anchors the whole spec.
**Suggested fix**: add a one-line invariant block at the top of §1: "**Invariant for §1:** every primary goal is either (a) the new client itself, (b) the protocol formalization required by the new client, or (c) a hard prerequisite for the new client to function. Goals that don't fit are demoted to non-goals."

## Cross-file findings

None for R1 from this chapter.
