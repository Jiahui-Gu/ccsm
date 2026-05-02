# R1 (feature-preservation) review of 01-overview.md

The overview frames v0.3 as a pure backend/frontend split with v0.4 as additive. The feature-preservation issue here is that the chapter's "ship-gate" framing (zero IPC residue, daemon survives SIGKILL, PTY zero-loss, installer roundtrip) covers the *plumbing* of the split but does not require feature parity with v0.2. The chapter therefore implicitly licenses chapters 04 and 08 to drop user features without flagging the loss.

## P0 findings (block ship; user-visible feature drops or breaks)

### P0.1 Goals list omits "feature parity with v0.2" as an explicit goal

**Location**: §1 ("Goals (v0.3)")
**Current behavior**: today's app has notify pipeline (toasts, badges, halo flashes), session rename via SDK, importable-session scan, custom titlebar window controls, in-app updater, OS folder picker, recent-CWD popover, theme/font preferences, drafts, default-model auto-detect from `~/.claude/settings.json`, locale push, OSC-title parsing, click-toast-to-focus, multi-user data isolation. (See `08-electron-client-migration.R1.review.md` for the full enumeration.)

**Spec behavior**: the seven listed goals are: process split, single transport, system service, frozen wire schema, PTY zero-loss reconnect, clean installer round-trip, crash collector local-only. **No goal mentions feature parity** with v0.2.

**Gap**: Without feature parity as a goal, chapters 04 (proto) and 08 (electron migration) are not held to a "every existing feature is preserved" standard — and indeed they aren't (P0 findings in those review files document the dropped features). A pure refactor must, by definition, preserve features.

**Suggested fix**: add Goal §1.8 — "**Feature parity with v0.2.** Every user-visible feature in v0.2 is preserved or has its loss explicitly enumerated in §2 (non-goals). The acceptance test is `the dogfooded user notices nothing different except daemon-survives-Electron-restart and daemon survives logout`." Without this, the spec is doing more than a refactor — it's silently slimming down the product.

### P0.2 Non-goals table lists only v0.4 deferrals; says nothing about v0.2 features being dropped

**Location**: §2 ("Non-goals (v0.3, deferred to v0.4)")
**Spec behavior**: the table covers web/ios/cf-tunnel/cf-access/oauth/upload/multi-principal — all things that don't exist today. Nothing about features that DO exist today and are about to be dropped.

**Gap**: the user upgrading v0.2 → v0.3 will be surprised by missing features (rename, import, notify, theme persistence, etc.). The non-goals table is the place to call them out so reviewers see them and either restore or accept the loss.

**Suggested fix**: add a second table "v0.2 features intentionally dropped in v0.3 (re-added later)" or "v0.2 features deliberately preserved (verified by ship-gate (e))." Either approach forces the spec to enumerate; silence allows silent loss.

## P1 findings (must-fix; UX regression or silent migration)

### P1.1 No mention of user-data migration in the overview's scope statement

**Location**: §3 ("Scope reduction from the diagram")
**Current behavior**: existing v0.2 users have on-disk state in per-user `app.getPath('userData')` paths.
**Spec behavior**: §3 enumerates what's IN scope (daemon internals, listener A, supervisor, Electron client) and what's OUT (cloudflared, listener B runtime, web/ios clients) — but doesn't mention that migrating existing user data is in or out of scope.
**Gap**: see `07-data-and-state.R1.review.md` P0.2 for the full data-loss case. Overview's silence cascades.
**Suggested fix**: add a bullet in §3: "✅/❌ Migrate v0.2 on-disk user data (sessions, app_state) to the v0.3 daemon DB" — pick one and reference chapter 07 §4.5 (which itself needs to be added).

### P1.2 Glossary doesn't define "feature parity" or reference the v0.2 baseline

Per P0.1, with no reference baseline, future reviewers can't grep against "what we had". Suggest adding one line to glossary §6: "**v0.2 baseline** = the Electron-only single-process app shipped at tag v0.2.0 (commit X). Reviewers SHOULD treat this commit as the feature reference for v0.3 parity."

## P2 findings (defer)

(none distinct from chapters 04 / 07 / 08 reviews)
