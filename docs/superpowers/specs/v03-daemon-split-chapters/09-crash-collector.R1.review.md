# R1 (feature-preservation) review of 09-crash-collector.md

The crash collector chapter is internally coherent for daemon-side crashes, but introduces a bifurcation that drops a v0.2 user-visible behavior: today's Electron app reports crashes via Sentry (with user opt-out). Spec moves crash capture to daemon-local SQLite only and is silent on the existing Sentry path.

## P1 findings (must-fix; UX regression or silent migration)

### P1.1 Two crash-reporting systems, two opt-outs, one user

**Location**: §1 (capture sources), §5 (settings UI surface)
**Current behavior**:
- Electron-side: `electron/sentry/init.ts` initializes Sentry main + renderer. The user's `crashReporting` opt-out preference (`electron/prefs/crashReporting.ts`) gates whether Sentry sends data to Anthropic's Sentry service. This is a NETWORK upload that exists today.
- Daemon side (post-split): new local-only SQLite log per this chapter; no upload in v0.3.

**Spec behavior**: chapter 09 covers daemon-side capture and explicitly says "no network upload in v0.3." Says nothing about the existing Electron Sentry. Settings UI in §5 is for the SQLite log only. The user's existing `crashReporting` opt-out lives in `app_state` (P0 of 07-data-and-state review) and currently has no daemon home.

**Gap**:
- The user has TWO crash-reporting planes after the split: Sentry (Electron-only, network upload, opt-out today) + local SQLite log (daemon-only, no upload). The "crash reporting" toggle in v0.2's Settings only governs Sentry; if the user toggles it off in v0.3, the new SQLite log keeps recording (no upload, but it accumulates regardless).
- The Sentry pref is not in `Settings`; if it's stranded in renderer-only state, the user re-toggles after every fresh install.
- v0.4 adds upload — at that point the SQLite log becomes a network channel too, with its own toggle, and now the user has TWO opt-outs.

**Suggested fix**:
1. Add `Settings.sentry_enabled` (boolean, default true matching today) to chapter 04 §6 so the toggle has a wire-stable home.
2. Chapter 09 §5 must say "the existing Settings → Crash Reporting → Send to Sentry toggle is preserved and reads `Settings.sentry_enabled`. The local SQLite log is independent and always-on (capped per §3)."
3. v0.4 upload UI must reuse the same toggle mental model — one "share crash data" master toggle, sub-toggles for Sentry and Anthropic upload.

### P1.2 Daemon crashes after Electron exit produce no user-visible signal

**Location**: §5 ("Settings UI surface")
**Current behavior**: today's app crashes kill the visible app; user sees an OS dialog or just relaunches manually.
**Spec behavior**: daemon runs as a system service. If it crashes while no Electron is running, the service manager restarts it and the entry lands in SQLite. User notices on next Electron launch... but only if they open Settings → Crash Reporting tab.

**Gap**: silent recurring crashes are now invisible to the user. v0.2 user sees the app crash; v0.3 user sees nothing until they go looking.

**Suggested fix**: Settings → first-page surface a "X crashes since you last looked" badge or a passive in-app banner on launch ("ccsm-daemon restarted N times in the last 24h — view crash log"). Cheap UX addition, big regression-prevention. Or document explicit acceptance of the loss.

## P2 findings (defer)

### P2.1 `crash-raw.ndjson` is not exposed via RPC for fatal-during-RPC scenarios

§2 says the daemon imports the file on next boot. If the daemon is wedged (boot loop), the user has no RPC path to read these. Today with Sentry, you'd at least see the network-uploaded report via Anthropic's tooling. Acceptable in v0.3 given crash collector is local-only by brief §10; flag for v0.4 review.
