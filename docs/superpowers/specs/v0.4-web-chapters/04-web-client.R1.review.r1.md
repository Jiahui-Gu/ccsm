# Review of chapter 04: Web client
Reviewer: R1 (feature-preservation)
Round: 1

## Findings

### P2-1 (nice-to-have): §6 "Reload page" button is a new UI surface in the unreachable banner
**Where**: chapter 04 §6, step 4 ("Banner has a 'Retry' button that calls `transport.reconnect()` and a 'Reload page' button.")
**Issue**: The v0.3 `daemon.unreachable` banner has a "Retry" button (per v0.3 §6.8). v0.4 adds a second button "Reload page". This is a small new UI element specific to the web client (Reload page is a meaningful action in browser; in Electron it would be a window reload). Per R1 discipline, every new user-visible surface — even a button — should be tagged as required-by-the-new-client.
**Why P2**: the button is required for the web client (browser reload semantics differ from Electron) so this is acceptable, but unflagged.
**Suggested fix**: in §6 step 4, append: "**Per-platform divergence:** the existing 'Retry' button is shared with Electron (unchanged from v0.3 §6.8). The 'Reload page' button is web-only (no Electron equivalent — Electron uses 'Retry' only). The bridge surface for the banner is unchanged; per-platform conditional rendering at the button level."

### P2-2 (nice-to-have): §8 "no theme / appearance settings unique to web" — good explicit non-goal; consider promoting to chapter 01 N-list
**Where**: chapter 04 §8, "No theme / appearance settings unique to web" paragraph
**Issue**: This is a valuable explicit feature-preservation guard ("same dark/light theme as Electron, sourced from same Settings RPC"). It currently lives only in chapter 04. R1 thinks it would be more discoverable in chapter 01's Non-goals list (with §3 N-numbered framing).
**Why P2**: cosmetic / discoverability.
**Suggested fix**: add a cross-ref from chapter 01 §3 (e.g. as a sub-bullet under N3) pointing to chapter 04 §8 for "no web-specific appearance settings".

## Cross-file findings

None for R1.
