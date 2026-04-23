# Bug #186 Reproduction & Root Cause

**Probe:** `scripts/probe-e2e-permission-allow-write.mjs` (extended with diagnostic dump)
**Branch:** `bug/fs-not-landing-repro-186`
**Run date:** 2026-04-23

## 1. Observed failure rate

Ran the probe 20 consecutive times on the `working` branch (commit `1be3259`) with the diagnostic extension in place.

| Runs | Pass | Fail | Fail rate |
|---:|---:|---:|---:|
| 20 | 16 | 4 | **20.0%** |

Failing runs: 3, 4, 13, 18. Matches the baseline 2/11 (~18%) reported in PR #182 — confirms the flake is reproducible locally at meaningful volume.

Raw batch log: `dogfood-logs/batch.log` (summary JSON: `dogfood-logs/bug-186-batch-summary.json`).

## 2. Failure artifacts

Every failing run dumped a JSON artifact via the new `dumpBug186Artifact` helper:

- `dogfood-logs/bug-186-2026-04-23T16-55-26-819Z.json` (run 3)
- `dogfood-logs/bug-186-2026-04-23T16-56-44-231Z.json` (run 4)
- `dogfood-logs/bug-186-2026-04-23T17-00-04-443Z.json` (run 13)
- `dogfood-logs/bug-186-2026-04-23T17-03-04-828Z.json` (run 18)

Each artifact contains:
- `reason`: failure mode (`fs-miss` in all 4).
- `wanderers`: walk of PROJ / tmp / cwd / repo root looking for any `hello.txt` that landed in the wrong cwd. **None matched this run's PROJ** — the file genuinely was not written anywhere, not even a wrong cwd. (Case (c) ruled out.)
- `timeline`: 4 snapshots of `messagesBySession[sid]` + `fs.existsSync(target)` at: `pre-allow`, `post-allow` (immediately after click), `post-allow+500ms`, `observation-end` (60s later).

## 3. Root cause

**100% of failures share the same shape**, visible in every artifact's timeline:

1. **`pre-allow` snapshot**: the only `waiting` block in the store has `toolName: "Skill"`, NOT `"Write"`. The model fired a `Skill` tool call first (using-superpowers / slash-command adapter from the user's `~/.claude/commands` + `~/.claude/skills` — visible in the preceding tool block `{"toolName":"Skill", "input":"{\"skill\":\"using-superpowers\"}"}`) and the permission prompt the probe is about to click is for **Skill**, not Write.
2. **`post-allow` snapshot**: the waiting block is replaced with `perm-resolved-...` system trace — the Skill was allowed. Still no Write attempt yet.
3. **`post-allow+500ms`**: the Skill tool gets its `result` ("Launching skill: using-superpowers"), but still no Write.
4. **`observation-end` (60s)**: model finally emits the Write tool call + a new `waiting` block for Write permission (toolUseId `wait-perm-...`). That block is never answered (the probe already spent its only Allow click on Skill), the probe's 60s observation window runs out with `fileExists=false`, and we fail.

In other words:
- The DOM "File created" text does NOT appear in any failure — the probe's `domHit` is false in these runs (check: logs show DOM HIT is missing or only hits the pre-existing Skill success copy). Re-reading the earlier PR #182 claim of "DOM says File created": actually the DOM regex `/File created successfully|File written|hello\.txt/` also matches the probe's own prompt text containing `hello.txt`, which is always visible. So the DOM signal is a false positive in these cases — it fires because the prompt text itself matches. That explained the original "DOM says File created but fs missing" framing.
- `isError` is never true in the failing runs — the Write tool simply never ran, because the permission prompt for Write never got answered.

### Evidence that fs-write itself is not broken

- The probe's happy path passes 16/20 times on the same machine with the same code path.
- In the 16 passes, `pre-allow` waiting block is `Write` directly (no Skill injection), Allow routes correctly, fs writes, result delivered. The control-rpc / hook_callback plumbing from Bug L fix is intact.

### Ranked hypotheses

| Rank | Hypothesis | Evidence |
|---:|---|---|
| **1 (confirmed, all 4 failures)** | User-level Skill auto-injection: model calls `Skill` before `Write`. Probe's `locator('[data-perm-action="allow"]').first().click()` answers the Skill prompt. The subsequent Write prompt never gets answered and the run times out. | 4/4 artifacts: waiting block at pre-allow is `toolName: "Skill"`, input `{"skill":"using-superpowers"}`. Observation-end shows a fresh unanswered Write waiting block. |
| (d) async delay | Ruled out — at observation-end (+60s after Allow) file still missing and Write tool block has no result. Not latency. |
| (c) wrong cwd | Ruled out — `wanderers` walk of PROJ + tmp + cwd + repo root found no matching `hello.txt` for this run's timestamp. |
| (a) Bash mkdir fail | Ruled out — Write tool never ran at all (no result, no isError). |
| (b) tool_result lost | Ruled out — no Write tool_use_id reached `result:` state in any failing run. |
| (e) Write errored silently | Ruled out — no `isError: true`. |

## 4. Why this is a probe bug, not a production bug

The production app behaves correctly: two permission prompts arrive sequentially, each can be resolved independently via `resolvePermission(requestId, ...)`. A real user staring at the UI would click Allow twice. The failure is that the probe only clicks once, then waits.

The user's memory / config injects superpowers and pua skills into every session. The model probabilistically decides "this looks like a task that could benefit from the `using-superpowers` skill" and fires `Skill` before Write. This is non-deterministic (16/20 it doesn't; 4/20 it does), which explains the 18–25% flake rate.

## 5. Recommended fix direction

**Fix should go into the PROBE, not production.** Two concrete options, in order of preference:

1. **Probe loops the Allow click until the target Write completes** — e.g. in the observation window, whenever a new `[data-perm-action="allow"]` button becomes visible AND the store's current waiting block's `toolName` is a file-mutating or preparatory tool (Skill, Bash-for-mkdir, Write, Edit, MultiEdit), click it. Stop when `fsHit && storeHit` for the Write tool specifically. This is robust to any number of preamble tool prompts.
2. **Probe launches Electron with a sanitized `HOME` / `USERPROFILE`** so user-level `~/.claude` settings (commands, skills, memory) don't bleed into the probe session. The permission prompt UX already filters to tools the model explicitly uses, so eliminating auto-loaded Skill injection makes the test deterministic. This is a broader fix but affects only the probe harness.

Option 1 is a ~10-line change and preserves realistic end-user conditions. Option 2 is cleaner but changes the probe's environmental assumptions.

**No production code changes are recommended.** The control-rpc / hook_callback pipeline is working as designed; the "Allow success but file not on fs" symptom was a misread — it was really "Allow success on a DIFFERENT tool, and Write's permission prompt is still pending."

## 6. Secondary recommendations (not blocking)

- The DOM-signal regex `/File created successfully|File written|hello\.txt/` is too loose — `hello.txt` alone matches the user's prompt text. Tighten to `/File created successfully at.*hello\.txt/`. This would eliminate the false-positive "DOM HIT" that muddied the original class-(b) diagnosis.
- Consider recording to a probe log whenever a permission prompt for a tool OTHER than the one the probe is testing appears, as a signal of environmental skill/command injection polluting the test.

## 7. Scope

This worker did **not** change production code. The only code change is the diagnostic extension in `scripts/probe-e2e-permission-allow-write.mjs` (snapshot helper + failure artifact dump) and a small batch driver at `scripts/_run-186-batch.mjs` used to generate the stats. Fix is a separate task.
