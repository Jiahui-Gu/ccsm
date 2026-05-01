# Review of chapter 07: Error handling and edge cases

Reviewer: R6 (Naming / consistency / clarity)
Round: 1

## Findings

### P2-1 (nice-to-have): "control-socket" hyphenated vs "control socket" two-word

**Where**:
- §1 line 22: "detect via **control-socket** `/healthz` poll" — hyphenated as adjective.
- §1 line 28: "data-socket — it MUST be re-implemented" — hyphenated as noun, but the construct reads like an adjective being used standalone.
- §5 line 132: "v0.4 daemon's data socket" — two words.

Cross-chapter:
- 02 / 09 / 11 use "control socket" / "data socket" (two words) as nouns.
- 03 / 09 use "data-socket dispatcher" / "data-socket envelope handler" (hyphenated as compound modifier — correct usage).

**Issue**: §1 line 28's "the data-socket" used as a noun (not modifying anything) is inconsistent with the convention. Convention should be: hyphenated as compound modifier ("data-socket envelope handler"); two words as standalone noun ("the data socket"). 07 §1 line 28 violates this.
**Why P2**: minor English style; doesn't affect implementation.
**Suggested fix**: §1 line 28 — change "the data-socket — it MUST" to "the data socket — it MUST".

### P2-2 (nice-to-have): "v0.3 §6" / "v0.3 §3.1.1" / "v0.3 frag-8" — three citation styles for v0.3 references

**Where**:
- §1 line 28: "v0.3 §6 migration-gate interceptor"
- §1 line 22: implicitly via cross-ref to chapter 02 §8.
- §1 line 38: "Daemon's existing storage-full handler (v0.3 frag-8)"
- §8 line 211: "v0.3 frag-8 covers"
- §8 line 215: "v0.3 frag-11 §11 + auto-update rollback"

**Issue**: "v0.3 §X" vs "v0.3 frag-X" vs "v0.3 frag-X §Y" — three forms. Chapter 11 line 22-29 lists specific fragment files (`frag-3.4.1-envelope-hardening.md`, `frag-3.5.1-pty-hardening.md`, etc.). The "§N" style without a fragment ID is ambiguous: is "v0.3 §6" a section in `docs/superpowers/specs/v0.3-daemon-split.md` or in a fragment?
**Why P2**: a reader trying to look up the cited material has to grep both the consolidated v0.3 spec and the fragments dir.
**Suggested fix**: pick one citation form. Recommend: always cite via the chapter 11 reference label, e.g. "(v0.3 §6 — see chapter 11 §1 reference to v0.3-daemon-split.md)" or short-form "(v0.3-daemon-split §6)" / "(frag-8 §X)". The 11 chapter then carries the path resolution.

### P2-3 (nice-to-have): "Browser tab backgrounded for >100s" wording could conflict with chapter 06 §4 heartbeat semantics

**Where**: §3 line 88-91:
> "Tab suspends or throttles event loop. HTTP/2 stream may or may not be killed by Cloudflare (heartbeats from daemon keep edge happy, but the browser may ignore them if throttled)."

Chapter 06 §4 line 107: "if no event (including heartbeat) received for 120s, client treats stream as dead and triggers reconnect."
**Issue**: 07 §3 doesn't reference 06 §4's 120s client-side timeout. Reader of 07 alone doesn't know whether "the stream is dead" is detected after 100s, 120s, or never. Cross-ref would tighten the description.
**Suggested fix**: 07 §3 line 88-91 — append "(client-side liveness check fires after 120s of no event per chapter 06 §4)".

## Cross-file findings (if any)

- P2-2 (v0.3 citation style) is cross-chapter (07, 02, 03, 11). Recommend a one-time pass at merge stage to normalize.
