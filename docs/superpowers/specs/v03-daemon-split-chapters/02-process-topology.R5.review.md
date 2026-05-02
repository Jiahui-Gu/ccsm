# R5 review — 02-process-topology.md

## P0

### P0-02-1. macOS UDS path inconsistent across chapters
- Chapter 02 §2.2 says UDS is `/var/run/ccsm/daemon.sock`.
- Chapter 03 §2 (`makeListenerA`) hard-codes `"/var/run/ccsm/daemon.sock"` for darwin (consistent).
- Chapter 03 §3 lists macOS listener descriptor at `/Library/Application Support/ccsm/listener-a.json`.
- Chapter 14 §1.2 spike "macos-uds-cross-user" repeats `/var/run/ccsm/daemon.sock`.
- BUT modern macOS (System Integrity Protection) restricts third-party writes to `/var/run/`. Spec implicitly assumes this works. **This is an unflagged P0 risk**: the path may be unwritable even by root on signed-but-not-Apple-issued binaries — and the spike kill-criterion does not call out SIP. Add SIP check to [macos-uds-cross-user] kill-criterion AND consider `/var/run/com.ccsm.daemon/` (reverse-DNS subdir) per Apple convention.

## P1

### P1-02-1. `%PROGRAMDATA%` vs `%ProgramData%` casing
Chapter 02 uses `%ProgramData%`; chapter 07/10/14 use `%PROGRAMDATA%`; chapter 10 §5.1 uses `%ProgramData%` again. Pick one — Microsoft docs use `%ProgramData%`. Single replace_all across spec.

### P1-02-2. macOS service account `_ccsm` mentioned in 02 + 10 + 15 but only "created by installer pkg postinstall" — does not state UID range
macOS dedicated service users conventionally use UIDs in 200-400 range with no login shell. Pin: `_ccsm` system user with UID in `__APPLEINTERNAL_RESERVED` range or `dscl` allocation rules. Without this a downstream installer dev will pick a colliding UID.

### P1-02-3. "Per-user Electron joins group via installer step OR daemon writes a per-user proxy socket — MUST-SPIKE"
Two alternatives, no decision, no spike id. Cross-check: chapter 14 has [macos-uds-cross-user] which only covers the first option. Add a second spike OR fold the "per-user proxy" path into the existing spike's fallback (chapter 14 §1.2 fallback already mentions it — make 02 §2.2 explicitly point at [macos-uds-cross-user]).

### P1-02-4. "Per-user Electron joins group via postinst, requires logout/login" (linux §2.3)
"requires logout/login" is a UX failure mode for the installer ship-gate test. Either: (a) installer warns user explicitly, (b) postinst applies the group via `newgrp` for the running session, (c) document as a "first-launch needs reboot" caveat in chapter 10 §5.3 and chapter 12 §4.4. Currently silent.

### P1-02-5. Vague verbs
- §1 "Hosts" column: "all session/PTY/SQLite state" — fine, but "claude CLI subprocess(es) ... per session lifetime" is not pinned: what about session in `EXITED` state — does claude CLI process linger? Chapter 06 implies no but chapter 02 doesn't say.
- §6 "Daemon may restart at any time" — "at any time" hides the question of whether daemon notifies clients via stream-end first. Chapter 02 §4 covers shutdown notification; chapter 02 §6 should reference §4 explicitly.

### P1-02-6. Startup step 5: "instantiate Listener trait array (slot 0 = Listener A; slot 1 = `null` reserved for v0.4 Listener B)"
Chapter 03 §6 says daemon code MUST contain the exact comment `// listeners[1] = makeListenerB(env);  // v0.4`. Chapter 02 §3 step 5 does NOT show this. Cross-reference is missing — a reviewer reading 02 in isolation could conclude the slot is just a `null` literal, not a reserved-by-comment line. Add "(see [03](./03-listeners-and-transport.md) §6 for the reserved comment line)" to step 5.

### P1-02-7. Recovery line: "First failure → restart after 5s; second failure → restart after 30s; subsequent → run no command"
"Run no command" on third failure means no auto-restart, but section §4 / §6 / chapter 13 phase 11 ship-gate (b) testing says daemon "survives" SIGKILL of Electron (not daemon SIGKILL). For daemon-itself crash recovery, "subsequent → no command" leaves the daemon offline forever until reboot — is that intentional? If yes, document why crash log capture is more important than restart loop. If no, fix the recovery policy.

## Scalability hotspots

### S1-02-1. "claude CLI subprocess(es)" with no cap on session count
§1 implies one claude CLI per session. No cap on session count in any chapter. Pin (e.g. 64 concurrent sessions in v0.3, enforce via `CreateSession` returning `ResourceExhausted`) — otherwise OOMs on user with 200 sessions become a support nightmare.

## Markdown hygiene
- §1 table OK. §2 sub-headings use `####` directly under `###`; OK (no skip).
- §6 uses bullet list. §7 v0.4 delta uses bullets. OK.
