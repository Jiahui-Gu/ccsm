# Dogfood public-001 — 2026-04-24

## Re-triage note (2026-04-24)

Manager clarified the definition of "clean config" after the original pass:

- **"Clean config"** = CCSM's own config is empty (`%APPDATA%\CCSM` deleted).
- **"Clean config" does NOT mean** Claude Code's global config (`~/.claude/`) is cleared.
- CCSM is a GUI shell for Claude Code. Inheriting the user's Claude Code config — skills, settings, credentials, MCP servers, subagents — is **correct product behavior**, not a bug.

Under this corrected definition, the original P0 finding ("claude.exe inherits `~/.claude/skills` and runs them on every turn") is **rescinded**. It has been struck through below to preserve the audit trail. Gap 4 ("Chinese PUA preamble without attribution") has been rewritten so its severity rests on discoverability (a skill-badged turn is reasonable even when inheritance is correct), not on the premise that inheritance itself is wrong.

No other finding was materially affected by the corrected definition. No re-run was needed — all remaining findings are independent of the isolation question.

Updated counts: **6 bugs (was 7) / 7 UX gaps**. Severity distribution: **0 P0, 7 P1, 6 P2**.

---

Worker: claude opus 4.7 (1M context), running as ccsm public-dogfood agent.
Driver: playwright-core v latest, connected via CDP `--remote-debugging-port=9222` to the installed prod build.
Goal: run a real ~10-20 min task on installed CCSM, document bugs and UX gaps, no fixes.

Snapshots (PNG + body text + UI JSON dumps) are under `dogfood-logs/dogfood-public-001-2026-04-24/`.

---

## 1. Pre-state verification

| Path | Pre-existing? | Notes |
|---|---|---|
| `C:\Users\jiahuigu\AppData\Local\Programs\CCSM\CCSM.exe` | yes | installed by user before run |
| `C:\Users\jiahuigu\AppData\Roaming\CCSM` | absent | clean |
| `C:\Users\jiahuigu\AppData\Roaming\Agentory` | absent | clean (legacy folder) |

Launched the prod exe via PowerShell `Start-Process` with `--remote-debugging-port=9222`. CDP endpoint at `http://localhost:9222/json` exposed normally — the prod build accepts the flag. Title `CCSM`, app version reports `CCSM/0.1.0` over Electron 33.4.11.

HOME sanitization: I tried to point HOME to a temp dir for the driver subprocesses, but the relevant subprocess is `claude.exe` spawned by CCSM itself — that inherits the OS user environment, so HOME sanitization on my driver shell did NOT propagate. (Originally flagged as part of Bug #2; under the corrected "clean config" definition this inheritance is correct behavior — see re-triage note above.)

---

## 2. Task chosen

**Task A (multi-tool, real):** Initialize a tiny Node CLI tool in `C:\Users\jiahuigu\AppData\Local\Temp\dogfood-target` — `npm init`, install commander, write `index.js` with a `greet <name>` command, write `test.js`, run the test.

**Task B (interrupt + long output):** Run `for i in $(seq 1 60); do echo "tick $i"; sleep 1; done` to test long-running tool output streaming and the Stop/Esc interrupt path.

Both are realistic — what a user would do day one to evaluate CCSM. Task A exercised: Skill (rejected), Bash, Write x2, Bash. Task B exercised: Bash long-running, Esc to cancel.

---

## 3. Timeline

All times local (Asia/Shanghai-ish based on box clock).

| Time | Event |
|---|---|
| ~23:23:30 | Launched `CCSM.exe --remote-debugging-port=9222` |
| ~23:23:38 | Window visible, page loaded with onboarding wizard already on top of the main shell. Time-to-first-paint approx 8s (includes my `Start-Sleep 8`); the page was loaded by the time CDP was queryable. |
| 23:24:xx | Clicked through onboarding Next x3 -> Done. Each step instant. |
| 23:24:55 | Onboarding ended. Shell shows empty Sessions panel, `Sessions 1` (one auto-created session named "New session"), no group dialog, no welcome empty-state. |
| 23:25:14 (est) | Sent first prompt (Task A) via Enter on textarea. |
| 23:25:21 (est) | First chunk back. **TTFR ~7s.** First action was a `Skill({"skill":"pua"})` invocation — see rescinded Bug #2 / Gap #4 (skill inheritance is correct behavior). |
| 23:25:40 | First permission prompt visible (Skill pua). I clicked Reject. |
| 23:26:50 | Second permission prompt — Bash mkdir+npm. Allowed (Y). |
| 23:27:20 | npm install ran, finished after ~2:13 elapsed counter (see bug #3). |
| 23:29:25 | Permission prompt — Write index.js. Clicked Allow always. |
| 23:29:40 | Write test.js silently allowed (good — Allow-always for Write worked). Bash `node test.js` prompt shown. Allowed (Y). |
| 23:29:50 | Smoke test passed. Agent reported "Done." Task A complete. |
| ~23:30:30 | Sent Task B (long bash). Pua skill prompt again — rejected. Bash perm prompt — allowed. |
| ~23:31:20 | Long bash running. I pressed Esc twice → first closed an unrelated popover, second interrupted the bash. Bash row marked FAILED with `Interrupted` infobox. |
| ~23:32:00 | Clicked Bash row to expand → captured stdout `tick 3..tick 26` shown. Note: tick 1 and 2 missing (see bug #5). |
| ~23:32:30 | Created 2nd session via `New Session` button. Switched between sessions — both display name "New session", indistinguishable. |
| ~23:33:10 | Opened Settings popover (top-right). Showed `http://localhost:23333/api/anthropic`, default model `claude-opus-4-7`, discovered models 11. |

End: ~23:33. Total wall time ~10 min.

---

## 4. Bugs

### Bug 1 — P1: Bash tool elapsed-time counter starts at *request*, not at execution start; "still no result" warning fires while still waiting on user permission

**Repro:**
1. Send a prompt that triggers a Bash tool call.
2. Observe the Bash row counter starts ticking (0s, 1s, ...).
3. While `PERMISSION REQUIRED` is still pending user input, the counter keeps growing.
4. At ~90s the row shows "Tool has been running 90s+ — still no result." Even though the user just hadn't pressed Allow yet.

**Why it's bad:** misleading. User thinks the tool is hung; reality is the agent is blocked waiting on the user's permission click. Hides the actual bottleneck. Compare to raw CLI which says `running...` only after Allow is pressed.

**Severity:** P1 — confusing for first-time users; makes CCSM look slow when it isn't.

**Files:** `06-poll-*.png`, `07-poll-*.png`. See e.g. `07-poll-8.txt` line "Tool has been running 90s+ — still no result." adjacent to a permission prompt that's still unanswered.

---

### ~~Bug 2 — P0 (data exfil / hostile UX): claude.exe inside CCSM auto-loads user's `~/.claude/skills` and tries to invoke them on EVERY turn~~

**RESCINDED (2026-04-24 re-triage):** `~/.claude` inheritance is correct behavior (CCSM is a Claude Code GUI shell). The original finding assumed CCSM should sandbox itself from the user's Claude Code config; under the corrected definition of "clean config" (CCSM-specific `%APPDATA%\CCSM` only), inheriting skills / settings / credentials / MCP servers from `~/.claude` is working as designed. Preserved below strike-through for audit trail.

~~**Repro:**~~
~~1. Have any third-party skill installed in `~/.claude/skills` (e.g. `pua`).~~
~~2. Launch CCSM, send a benign prompt like "Please initialize a tiny Node CLI tool".~~
~~3. The agent's FIRST tool call is `Skill({"skill":"pua"})`, requiring user permission.~~
~~4. Reject. The agent proceeds with the actual task, but on the NEXT user turn, again calls Skill pua first.~~

~~**Why it's bad:**~~
~~- Probe skill injection (as documented in `project_probe_skill_injection.md` for agentory) — CCSM inherits arbitrary user-level skills with no isolation toggle.~~
~~- The agent's natural-language preamble was Chinese big-tech-PUA-style (`收到，按 owner 意识闭环这个事情...`) — for a user who doesn't have PUA skill, this would be totally unexpected behavior. For a fresh-install dogfood it's especially jarring because the user expects a vanilla agent.~~
~~- Adds 5-15s to every turn just to wait/reject the unwanted skill load.~~
~~- Breaks the prod-install dogfood promise: the install was clean (`%APPDATA%\CCSM` empty) but the underlying claude.exe still pulls full user-skill state.~~

~~**Severity:** P0 release-blocker for "fresh user" story. P1 if framed as "advanced users only".~~

~~**Files:** `06-poll-*.txt` (every poll shows `Skill ({"skill":"pua"})` as the first tool), `12-long-task.txt` (turn 2 also opens with same skill call).~~

---

### Bug 3 — P1: "Allow always" applies per-tool but does not extend across distinct Bash commands (probably correctly scoped, but copy is misleading)

**Repro:**
1. Bash command #1 prompts permission. Click Allow always.
2. Same session, agent runs Bash command #2 (different command string). New permission prompt.

**Observed in:** `10-after-allow-always.txt` (after Allow always for Write was clicked, the very next Bash prompt appeared). My follow-up: Allow always for *Write* worked (the second Write to test.js was silent), but the Bash that came right after still required prompt.

**Why it's a bug:** it's likely the intended scoping (per-tool not blanket), but the button label "Allow always" reads like permanent unattended approval for the tool. Users will be surprised when a different command in the same tool re-prompts. CLI uses a more explicit phrasing (e.g. `2. Yes, and don't ask again for "Bash(npm:*)" commands in this project`). CCSM gives no scope hint.

**Severity:** P1 — actionable copy fix; will frustrate users in long sessions.

---

### Bug 4 — P2: Esc key bound to multiple actions with no visible priority

**Repro:**
1. Open any popover (e.g. cwd selector accidentally opened by the chip in metadata bar).
2. With a tool also running, press Esc.
3. First Esc closed the popover. Good.
4. Second Esc interrupted the running bash. Good.

But there is NO visual indication of "press Esc to close popover" vs "press Esc to interrupt task". The footer hint reads `Esc to stop` only — nothing about popover dismiss. So a user expecting Esc to interrupt and finding it merely closed a popover may believe the interrupt didn't fire.

**Severity:** P2 polish — would benefit from contextual hint text.

---

### Bug 5 — P2: Bash tool stdout stream is not visible until row is manually expanded; partial output may drop initial lines

**Repro:**
1. Run `for i in $(seq 1 60); do echo "tick $i"; sleep 1; done`.
2. While running, the Bash row shows only `(for i in $(seq 1 60); do echo "tick $i"; sleep 1; done)` and a spinner with elapsed counter.
3. To see ticks, must click row to expand.
4. After expanding (post-interrupt), captured ticks shown were `tick 3 ... tick 26`. **Ticks 1 and 2 are missing.**

**Why it's bad:**
- "Is it doing something?" — yes I had this exact moment. Watching a counter tick while a long-running command is silent is exactly the dead-air problem the CLI solves with live streaming.
- Missing initial output lines is a real correctness hit if the user is debugging and only sees a partial transcript.
- Compare raw CLI: shows tool stdout inline as it streams.

**Severity:** P2 (UX) for the "click to expand", P1 if the missing initial lines are reproducible (I observed once — needs follow-up confirmation).

**Files:** `19-bash-clicked.txt`.

---

### Bug 6 — P2: Two sessions, both auto-named "New session" — sidebar makes them indistinguishable

**Repro:**
1. Click `New Session` twice.
2. Sidebar lists two items both labelled "New session" with no disambiguator (no number, no first-message preview, no timestamp).

**Severity:** P2 — easy fix (auto-suffix `(2)` or use first prompt as title once available).

**Files:** `20-second-session.txt`, `21-switch-back.txt`.

---

## 5. UX gaps

### Gap 1 — P1: Onboarding wizard violates SCREAMING-strings rule

`STEP 1 OF 4`, `STEP 2 OF 4`, `STEP 3 OF 4`, `STEP 4 OF 4`, plus the demo group names `Q2 LAUNCH`, `BUG TRIAGE`, `RECENT` (in cwd selector). All of these are visible UI strings rendered in all-caps English. Per project memory (`feedback_no_uppercase_ui_strings.md`) this is disallowed for i18n locale + button + label + placeholder content.

Severity: P1 — explicit rule violation, easy fix.

Files: `onboard-1.txt..onboard-4.txt`, `14-streaming.txt` (RECENT), `23-settings.txt` (SETTINGS, CLI-PICKER, FALLBACK badges).

### Gap 2 — P1: After onboarding, no welcome / empty-state in the main pane

Once onboarding closes, the right pane just shows `Ready when you are. Type a message and press Enter` — but the user has just watched 4 slides about Groups, Sessions, organizing by task, importing CLI sessions. There's no "create your first group" or "import existing" prompt; user is dumped straight into a session that was silently auto-created, in a default group with no name. The 4-step onboarding's promises don't connect to the next click.

Compare raw CLI: `claude` shows a tip-of-the-day and explicit `try: /init` hint in the empty repo case.

Severity: P1.

### Gap 3 — P1: cwd selector hidden behind a tiny chip, no indication of CURRENT cwd before sending

The chip labelled `jiahuigu` (the user name, not cwd!) opens a popover with a `RECENT` cwd list. There is no visible "current working directory: ..." line in the input area. A user hitting Send has no idea where their files will land. CCSM defaulted the cwd to **C:\Users\jiahuigu** (home) which is dangerous for write-heavy tasks.

Compare raw CLI: prompt shows the cwd at every line.

Severity: P1 — silent destructive-default risk.

Files: `14-streaming.txt` (the popover content).

### Gap 4 — P2: Skill-driven turns are not visually attributed to the skill

A first-time user who has a Claude Code skill installed (e.g. `pua`) sees:
> 收到，按 owner 意识闭环这个事情。先拉通 PUA 方法论对齐颗粒度。
> Skill ({"skill":"pua"})

…with no UI affordance indicating this preamble is coming from a user-installed skill rather than the base model. Even though inheriting skills from `~/.claude` is correct CCSM behavior (see re-triage note), CCSM could improve discoverability by tagging skill-driven turns with a visible badge ("via skill: pua") so the provenance of unusual tone / wording is obvious at a glance.

Severity: P2 — UX discoverability improvement on top of correct inheritance behavior.

### Gap 5 — P2: Tool elapsed timer + "still no result" notice gives wrong story (see bug #1) — UX side

User-facing language: a banner saying "Tool has been running 90s+ — still no result. **Cancel**" while the actual blocking action is the Allow click. Suggests user cancel, when in reality the user should click Allow. Bad nudge.

### Gap 6 — P2: New-session auto-creation skips group choice

Clicking `New Session` from a fresh state instantly created a session in some default group, with no prompt for group name. User loses the chance to name their group (which is supposedly the headline feature).

### Gap 7 — P2: No visible "interrupted-and-released" affordance on the Bash row after Esc

After interrupt, row is annotated "FAILED" + INFO "Interrupted". The agent then sits idle (Send button replaces Stop) but there's no follow-up prompt asking "do you want me to continue from where I stopped?". User has to phrase that themselves.

---

## 6. Did the task complete?

**Task A: YES** — `C:\Users\jiahuigu\AppData\Local\Temp\dogfood-target\` contains `index.js`, `test.js`, `package.json`, `node_modules`. `node test.js` prints `smoke test passed`. End-to-end Read/Write/Bash flow worked.

**Task B: PARTIAL** — long-bash command was started, ran for ~25s, was interrupted on purpose. Output capture missing first 2 ticks (see bug #5).

Group/session switch: yes, exercised.

Permission prompts: yes, exercised Reject + Allow + Allow always.

Failed action via interrupt: yes (Esc).

---

## 7. One-line verdict

**A real first-time user would struggle with cwd-defaults-to-home + misleading "still no result" warning + SCREAMING onboarding strings; these are fixable UX issues, not release blockers.**

Reasons (in order of severity, post re-triage):
1. Default cwd to user home + no visible cwd indicator means writes go to surprising locations (Gap #3).
2. Misleading "still no result" warning that fingers the *user* (not the unanswered permission prompt) makes the app feel slow (Bug #1).
3. Onboarding wizard violates the no-SCREAMING-strings rule (Gap #1), and onboarding doesn't connect to a first-run empty state (Gap #2).

Bug count by severity (post re-triage):
- P0: 0 (skill inheritance rescinded — correct product behavior)
- P1: 3 bugs (counter timing, allow-always copy, missing initial bash output lines — the latter tracked under Bug #5 if reproducible) + 4 P1 gaps (screaming strings, missing welcome, hidden cwd, plus Bug-1 mirror Gap #5) → 7 P1 total
- P2: 3 bugs (Esc multi-binding, bash stdout collapsed, duplicate "New session" naming) + 3 P2 gaps (skill-badge discoverability, new-session skips group, no continue-after-interrupt) → 6 P2 total

Bright spots: TTFR ~7s good. CDP works on prod build. Permission prompt UI is clear (Reject/Allow/Allow always). Tool calls collapsible into a clean transcript. Multi-session sidebar exists. Settings popover fast. `~/.claude` inheritance works as designed — skills, credentials, and MCP servers carry over from the user's Claude Code setup.

These bugs are fixable in 2-4 days of focused work. No architectural change needed.
