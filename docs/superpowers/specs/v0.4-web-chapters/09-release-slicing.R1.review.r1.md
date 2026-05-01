# Review of chapter 09: Release slicing
Reviewer: R1 (feature-preservation)
Round: 1

## Findings

### P1-1 (must-fix): M4 deliverable #7 (Auto-start at OS boot) — same concern as chapter 01 G6; ensure scope is bootstrap-tight
**Where**: chapter 09 §5 M4 deliverable #7
**Issue**: M4 lists "Auto-start at OS boot setting (chapter 01 G6) — opt-in toggle, default OFF, persists across reboots." This is a new product feature (see chapter 01 R1 review finding P1-1). M4 inherits the same ambiguity: the deliverable does not bound what "the toggle" includes (Settings pane row only? Plus tray menu item? Plus first-run nudge?).
**Why P1**: M4 is the most schedule-pressured milestone (CF wiring + web deploy + dogfood gate). Without a tight spec on what "auto-start setting" includes, scope creep is most likely here.
**Suggested fix**: rewrite deliverable #7 to: "Auto-start at OS boot — single toggle in Settings → Remote access pane (NOT in tray menu; NOT a first-run nudge). Default OFF. Persists across reboots via standard mechanism per chapter 01 G6 + R12 (Win startup folder shortcut, launchd RunAtLoad, systemd user unit). No additional UX in v0.4." Cross-ref the chapter 01 R1 finding when fixing.

### P2-1 (nice-to-have): M3 "risk gate before M4" should explicitly forbid feature-scope additions discovered during M3 dogfood
**Where**: chapter 09 §4, "Risk gate before M4" paragraph
**Issue**: The gate says "if M3 dogfood reveals significant UX gaps (e.g. xterm.js rendering glitches in browser, keyboard shortcut conflicts), pause M4 and address. Don't paper over with Cloudflare polish." Good — but it doesn't address the OTHER failure mode: M3 dogfood might reveal "while we're using web, we noticed it would be nice to have <new feature X>". The gate should explicitly defer those.
**Why P2**: discipline reinforcement.
**Suggested fix**: append to the risk gate paragraph: "**Feature-scope discovery:** if M3 dogfood reveals desirable new features (better keyboard mappings for browsers, web-specific gestures, etc.), file them as v0.5+ candidates. v0.4 does NOT extend feature scope based on M3 findings; only fixes regressions and addresses gaps that block the +frontend deliverable."

### P2-2 (nice-to-have): per-milestone "feature-preservation check" in dogfood gate criteria
**Where**: chapter 09 §7, dogfood gates table
**Issue**: The dogfood gates check for regressions and stability. They do not explicitly include a "no new product features were added during this milestone beyond what was specced" sanity check. R1 angle suggests adding it.
**Why P2**: process improvement.
**Suggested fix**: in §7, add a new column or appended paragraph: "**R1 sanity check at every gate:** before closing a milestone, manager scans the milestone's PRs for any user-visible new surface (new bridge method, new UI component, new Settings row, new tray entry, new keyboard shortcut, new notification, new modal). Each MUST be traceable to a spec-listed deliverable; otherwise it is scope creep and gets reverted or deferred."

## Cross-file findings

The M4 #7 finding (P1-1 above) is the same concern as chapter 01 R1's P1-1 (auto-start at OS boot). Recommend ONE fixer touch both chapters with the same scope-narrowing language so the descriptions stay consistent.
