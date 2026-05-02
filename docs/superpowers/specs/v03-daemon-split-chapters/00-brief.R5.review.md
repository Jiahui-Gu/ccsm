# R5 review — 00-brief.md

Brief is the input contract; R5 angle = check that brief's locked decisions are consistently named and reflected across chapters. Findings about gaps in chapters are flagged in those chapters' R5 files. This file lists brief-internal issues plus brief-vs-chapter naming drift.

## P0

(none — brief is the source of truth; consistency drift is recorded against the chapters that drift)

## P1

### P1-B-1. "ccsm-daemon" used in both diagram and chapter-2 service name without explicit "is the same identifier"
Brief diagram shows `ccsm-daemon` as the binary name (line 84). Brief §7 mandates Windows Service registration but does not pin the service name. Chapter 02 §2.1 picks `ccsm-daemon` as service name AND brief §11(d) ship-gate verifies `taskkill /F /IM electron.exe`, not the daemon name — implicit but reviewers must trust the chain. **Suggest**: brief glossary line stating "binary file name == OS service identifier == `ccsm-daemon`" so cross-chapter uses can not drift.

### P1-B-2. Brief §11(b) wording "taskkill /F /IM electron.exe" is product-specific
The Electron exe filename is not pinned anywhere (chapter 08/10 do not name the binary). Pin in chapter 10 §4 or the brief acceptance criterion will not be testable.

## Notes (not findings, just observations for downstream)

- Brief §1 says Listener B is "a stub array slot — no socket bound, no JWT middleware code shipped". Chapter 03 §6 implements this as `makeListenerB` that **throws** if called, plus a code-comment line. The brief did not ask for a throwing factory; chapter 03's choice is stricter than the brief (good — fail-fast). Verdict: compatible, no finding.
- Brief §6 demands forever-stable vs v0.3-internal label "on every proto message". Chapter 04 §7 has a labels table but only enumerates message-level labels for ~7 categories; verify in 04 review that **every** message in chapter 04 is covered (it appears to be, transitively, but not explicitly per-message).
