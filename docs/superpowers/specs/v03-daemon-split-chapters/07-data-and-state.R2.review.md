# R2 (Security) review — 07-data-and-state

## P0

### P0-07-1 — Cross-user readability of `listener-a.json` (Linux/macOS) conflicts with daemon state mode `0700`

§2 last-paragraph: "All paths created with mode `0700` for the daemon's service account." But chapter 03 §3 places `listener-a.json` at `/run/ccsm/listener-a.json` (Linux) and `/Library/Application Support/ccsm/listener-a.json` (macOS), inside the daemon state root. The Electron client runs as the **logged-in user**, not as the daemon's service account, and MUST read this file to learn the transport. Two outcomes:

1. If the spec is taken literally (mode 0700 daemon-only), Electron cannot read the descriptor → cannot connect → product does not work.
2. If the implementer relaxes mode (e.g., 0644), then in the multi-user `ccsm` group case (ch 02 §2.3) every user can read it, AND on macOS where state is `/Library/...` every account can read it. Combined with chapter 03 P0-03-3/P1-03-3, the descriptor reveals the supervisor address, which means any account can curl `/shutdown` if peer-cred fallback is loose.

Spec must explicitly state: descriptor file lives at a per-user readable path (mode 0640 root:ccsm on Linux; mode 0644 on macOS *within* a public dir; or per-user path), AND must NOT include any secret (no JWT, no key material — current schema's `tlsCertPemBase64` is fine because public, but a private key would not be).

### P0-07-2 — `pty_snapshot.payload` and `pty_delta.payload` may contain conversation transcripts and secrets; SQLite-file ACL is the only protection

§3 schema. The daemon's SQLite file (`/var/lib/ccsm/state/ccsm.db` etc.) accumulates cleartext PTY bytes for every session. Chapter 02 §2.3 puts user uids into group `ccsm`; if the SQLite file is `mode 0660 root:ccsm`, every group member reads every other user's session transcripts (including API keys pasted into prompts). Spec must:
- Either keep DB at `mode 0600` daemon-only and route every read through an RPC that enforces ownership (then the linux multi-user model is OK because users can't `sqlite3` the file directly), OR
- Encrypt at-rest with a key bound to each principal.

§2 says "mode 0700 for the daemon's service account" which would prevent direct read — good — but please make this explicit for the DB file specifically (currently §2 talks about the *root* directory).

## P1

### P1-07-1 — Migration lock SHA256 in `locked.ts` lives in the same repo as the migration; not a real integrity check

§4: "a SHA256 of `001_initial.sql` is committed as a constant in `packages/daemon/src/db/migrations/locked.ts`; CI compares". Both files are editable in the same PR; CI passes if both are updated. The "lock" only catches accidental edits, not malicious. Mitigation either:
- Sign the SHA256 with a build-time key (heavy).
- Put the SHA256 in a separate signed-commit-only branch (out of band).
- Or downgrade the language: spec currently implies tamper-resistance; should explicitly say "this catches accidental edits only".

### P1-07-2 — `crash-raw.ndjson` import-on-boot parses unverified file content into UI-visible records

§3 (refs ch 09 §2): on boot, daemon scans `crash-raw.ndjson`, imports any not-yet-seen entries, then truncates. The file is in daemon state dir (mode 0700, good) but if an attacker writes to it (compromise of any process running as the service account, or a path-traversal bug elsewhere), arbitrary records appear in Settings → Crashes with attacker-chosen `summary`/`detail`. If the Electron renderer ever interprets these as anything other than escaped plain text (e.g., shows `detail` as HTML/Markdown for stack-trace formatting), stored XSS in the UI. Mandate: import path validates JSON shape, caps lengths, strips ANSI/control chars before persistence; renderer renders as escaped plain text only.

### P1-07-3 — `PRAGMA journal_mode = WAL` + multi-process access is undefined for the supervisor / installer

§1 spec mandates synchronous driver because "main thread coalesces writes". WAL allows multi-process readers. The Supervisor HTTP path is the same daemon process so OK. But the **installer** uses `curl /healthz` (ch 03 §7) — no DB access, OK. Reviewer concern: spec should explicitly state "no other process opens `ccsm.db`" — and the spec should reject any attempt to add a CLI tool that touches it without going through the daemon. (Per R2 angle 7 multi-process access "must be denied or coordinated".)

### P1-07-4 — DB corruption recovery silently nukes user data

§6: "On failure: rename `ccsm.db` → `ccsm.db.corrupt-<ts>`, start fresh with `001_initial.sql`". This is correct technically but — combined with `should_be_running=1` defaults (see P2-05-2) — every reboot of a corrupt DB resurrects nothing (sessions are gone) and silently loses every prior session, every crash log, every setting (including `claude_binary_path`!). If an attacker can force corruption (e.g., disk-full + power-cycle, or chown the file), they reset the daemon state — including resetting `claude_binary_path` to default, which may break or unbreak depending on context. Spec should require: corruption → daemon refuses to start, surfaces via Supervisor `/healthz` returning 503 with structured detail; user MUST run a manual recovery command. Silent reset is a security-relevant data-loss path.

## P2

### P2-07-1 — `env_json` and `claude_args_json` columns are JSON TEXT — JSON-parse on every session restore

If a malicious session row contains a billion-line JSON, daemon boot OOMs. Cap input size at INSERT time, validate at SELECT time.

### P2-07-2 — `pty_delta.payload BLOB` not bounded in spec

Per §3 schema. A misbehaving claude that emits 100 MB in 16 ms produces one delta of 100 MB (the segmenter caps at 16 KiB per ch 06 §3, fine — but the spec should state that the SQLite write coalescer also rejects oversized blobs as a defence-in-depth).

### P2-07-3 — Backup/Restore writes a plaintext snapshot to user-supplied path

§6: `VACUUM INTO '<path>'`. If the user enters `/tmp/world-readable.db`, every session transcript becomes world-readable. Spec should mandate the export path be inside a restricted dir, or warn the user explicitly.
