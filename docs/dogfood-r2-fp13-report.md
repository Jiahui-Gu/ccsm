# Dogfood r2 fp13 — 细节抠 (truncate / cwd / token / cost / pill / effort)

Branch: `dogfood-r2-fp13` off `origin/working` (HEAD c5d7209 — post #406)
Binary: installed `C:/Users/jiahuigu/AppData/Local/Programs/CCSM/CCSM.exe` (older bundle, predates #397/#403/#405/#406)
User-data: `C:/temp/ccsm-dogfood-r2-fp13` (wiped per run)
Probe: `scripts/probe-dogfood-r2-fp13-details.mjs`
Raw: `dogfood-logs/r2-fp13/findings.json`
Screenshots: `docs/screenshots/dogfood-r2/fp13-details/`

## Verdict: 1 FAIL · 2 PARTIAL · 3 PASS

| Check | Verdict | Detail |
|---|---|---|
| A. long session name truncate + tooltip | **FAIL** | 80-char name renders full-width with `text-overflow:clip` + `white-space:normal` + no `title` attr; sidebar entry wraps to 2 lines instead of truncating with ellipsis + tooltip |
| B. cwd basename in sidebar | **PASS** | `C:\Users\jiahuigu` shown as `jiahuigu` chip; full path not exposed |
| C. token usage display | **PARTIAL** | Context chip hidden by design until usage ≥50% (current run was 3.6% = 36005/1000000); usage captured in store but invisible to user at low fill |
| D. cost format | **PARTIAL** | `statsCostUsd=null` from proxy this run — display format unverified (probe couldn't observe format because no value) |
| E. status pill morph (Send ↔ Stop) | **PASS** | Send `aria="Send message"` `bg=oklch(0.975 0.003 240)` ↔ Stop `aria="Stop"` `bg=rgba(0,0,0,0)` ↔ back to Send. Transition visible. |
| F. effort badge + picker | **PASS** | Chip shows "High" (title "Deeper thinking (default).") matching `effortLevelBySession`. Picker has 6 options: Off / Low / Medium / High (default) / Extra high / Max |

## Real bugs

### Check A: sidebar long name doesn't truncate

- 80 'A' session name fills 250px width, renders 2 lines (no clip, no ellipsis, no hover tooltip)
- Computed CSS: `text-overflow: clip` (should be `ellipsis`); `white-space: normal` (should be `nowrap`); `overflow: visible`
- No `title` or `aria-label` attribute carries the full name → blind users + hover-discovery both broken
- Fix path: add `truncate` (or `[overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]`) to sidebar `<li>` text span + add `title={fullName}` for tooltip

## Notes (PARTIAL → not bugs, but worth surfacing)

### Check C: token chip hidden until 50%

- Current threshold: `>=50%` of `contextWindow`. With 1M context, that's 500K tokens — a normal session won't ever cross it.
- Trade-off: clean idle UI vs. user awareness of context cost. Manager call needed: lower threshold (e.g. 25% / 10%) OR always-visible compact display.

### Check D: cost = null

- `sessionStats[sid].costUsd = null` after a real round-trip via the same proxy used by fp1-fp12. Earlier probes (fp2 etc.) saw `costUsd=0.179275` so the wiring works in some runs. Likely proxy-frame-specific (no usage frame in this round). Not a UI bug per se; needs a separate probe to nail down which proxy responses populate cost.

### E: no separate sidebar waiting indicator

- Send/Stop morph in input bar IS the running indicator. There is no spinner/dot in the sidebar entry while streaming. If multi-session users want at-a-glance "which session is busy" this would be a gap, but matches current minimal sidebar density philosophy.

## Files added

- `scripts/probe-dogfood-r2-fp13-details.mjs`
- `docs/screenshots/dogfood-r2/fp13-details/check-{a..f}-*.png` (13 PNGs)
- `dogfood-logs/r2-fp13/{check-*.json, findings.json, snap-*.json, *.log}` (12 JSON + 2 logs)

## Methodology

- Real ccsm store schema (`messagesBySession`, `sessionStats[sid].costUsd`, `contextUsageBySession[sid]`, `effortLevelBySession[sid]`)
- Both `CCSM_CLAUDE_CONFIG_DIR` + `CLAUDE_CONFIG_DIR` set in launch env
- Real ccsm binary, real Anthropic proxy roundtrip (35835 input tokens captured)
- Probe driver crashed mid-Check-E analysis; report manually compiled from `findings.json` + screenshots (manager salvage, not a re-run)
