# Review of chapter 05: Cloudflare layer
Reviewer: R1 (feature-preservation)
Round: 1

## Findings

### P1-1 (must-fix): §6 "Setup wizard 3-step copy/paste flow" is a new product surface (modal flow + new Settings pane); spec should explicitly anchor it as bootstrap-only, not a feature axis
**Where**: chapter 05 §6, "Setup flow (first-time user)"
**Issue**: §6 introduces:
- A new "Remote access" pane in Electron Settings.
- A 3-step wizard with link buttons that open external URLs.
- Persistent storage of CF tunnel token + team name + AUD.
- A "Disabling remote access" toggle that stops cloudflared and closes the TCP listener.

This is a substantial new product surface (new Settings pane, new wizard modal flow, new toggles). It IS required to bootstrap remote access (G4) — without it, the user cannot reach the web client. So under R1's "required by the new client" exception, it is permitted. However:

1. The chapter does not explicitly state "this surface exists ONLY to bootstrap remote access; v0.4 will NOT iterate on its UX (no copy improvements, no progress bar polish, no theming) beyond the minimum needed to function." Without this, a future contributor could treat the wizard as a polish target inside v0.4.
2. The "Optional" step 3 ("deploy the web client. Open this link to fork the ccsm Pages project") is borderline — a "fork ccsm Pages project" link is an entry to a new code surface (Pages project template, GitHub OAuth flow we don't otherwise own). It may be a setup convenience but it is not strictly required for v0.4 functionality (the user can deploy Pages independently per chapter 04 §4 GitHub-integration).
3. v0.5 improvement note ("if user grants API token, we can auto-create all three") implies the wizard will evolve — fine — but it does not lock v0.4's scope.

**Why P1**: the wizard is the largest new visible surface in v0.4 outside of the web client itself. Without an explicit "do-not-polish in v0.4" anchor, this is the most likely vector for "while we're at it" feature creep during M4 implementation.
**Suggested fix**:
1. Add a §6 closing paragraph: "**Wizard scope discipline:** v0.4 ships the minimum wizard needed to capture the 3 values (tunnel token, team name, app AUD). No copy A/B testing, no inline-help video embedding, no progress animations beyond a basic spinner. UX iteration is a v0.5+ slice if real users (not the author) onboard."
2. Reconsider step 3 ("optional Pages deploy"). Either drop it (and let chapter 04 §4 remain the only documented Pages setup path), or explicitly say "step 3 is a convenience link only — it does not require user action for the wizard to complete; the wizard's success criterion is steps 1+2 complete."

### P2-1 (nice-to-have): §1 "Disabling remote access" toggle behavior — confirm it does not change Electron-local behavior at all
**Where**: chapter 05 §6, last paragraph "Disabling remote access"
**Issue**: When the user toggles remote-access off, daemon stops cloudflared and closes the TCP listener. The chapter does not explicitly state: "Local Electron client continues to function identically; the user observes zero change in their desktop session list, settings, or running PTYs." This is almost certainly the intent and design, but spelling it out reinforces the +frontend-additive framing.
**Why P2**: cosmetic / clarity. Reduces risk of an implementer accidentally tying daemon-local state to the remote toggle.
**Suggested fix**: append to the "Disabling remote access" paragraph: "Disabling does NOT touch any local data socket, local PTY sessions, or Electron-renderer state. The Electron client continues to operate exactly as before; only the web ingress is removed."

### P2-2 (nice-to-have): §3 "session_duration: 24h" — confirm not surfacing to user as a setting in v0.4
**Where**: chapter 05 §3, Cloudflare Access policy block
**Issue**: 24h session is locked in the Access policy. The chapter does not explicitly say "the session_duration is NOT user-tunable in the v0.4 Settings UI." A reasonable v0.4-scope reader expects this; an over-eager implementer might add a "Session length" setting under Remote access.
**Why P2**: cosmetic guardrail.
**Suggested fix**: append to §3: "**Not surfaced in Settings:** session_duration is a Cloudflare-side policy value, not a v0.4 user-tunable setting. The user changes it in the Cloudflare dashboard if desired."

## Cross-file findings

None for R1 from this chapter.
