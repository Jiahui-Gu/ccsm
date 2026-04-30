# Dogfood r2 fp11 — i18n + markdown + long-output report

**Worker:** dogfood r2 fp11
**Branch:** `dogfood-r2-fp11`
**Date:** 2026-04-27
**Probe:** [`scripts/probe-dogfood-r2-fp11-i18n-markdown-long.mjs`](../scripts/probe-dogfood-r2-fp11-i18n-markdown-long.mjs)
**Screenshots:** [`docs/screenshots/dogfood-r2/fp11-i18n-md-long/`](screenshots/dogfood-r2/fp11-i18n-md-long/)
**Logs:** `dogfood-logs/r2-fp11/`

## Summary

| Check | Topic | Verdict |
|-------|-------|--------|
| A | Chinese prompt + Chinese reply | PASS |
| B | Markdown element rendering | PASS |
| C | Long output (200 lines) — scroll, auto-stick, jump-to-latest | PASS |
| D | Long markdown truncation / "show more" affordance | PARTIAL |
| E | Mixed CJK + English prompt round-trip | PASS |
| F | 500-char single-line wrap | **FAIL** |

Overall: **5/6 working**. One real layout bug (F): a long unbreakable single-line response causes the chat stream to overflow horizontally instead of wrapping. One feature-gap observation (D): no expand/collapse affordance for long assistant blocks.

---

## Check A — Chinese prompt → Chinese reply

**Prompt:** `用三句话介绍一下今天天气怎么测，很感谢`

**Reply (excerpt):**
> 以下是三句话介绍如何查看今天的天气：
> 1. **查看天气应用**：使用手机自带的天气应用或下载墨迹天气、Weather Channel 等 App，输入所在城市即可获取实时天气数据。
> 2. **搜索引擎查询**：在百度、Google 等搜索引擎中直接输入"今天天气"或"[城市名] 天气"，会自动显示当前温度、湿度及预报信息。
> 3. **查看官方气象网站**：访问中国气象局官网（weather.com.cn）或当地气象局网站，可获取更详细、更权威的天气预报及预警信息。

143 CJK chars / 225 total. No U+FFFD (replacement chars), no `???` runs. Renders cleanly.

**Verdict:** PASS

---

## Check B — Markdown element rendering

**Prompt asked the model to emit:** h1, ul (3), ol (3), js code block, blockquote, **bold**, *italic*, inline `foo`.

**Rendered DOM analysis (last assistant block):**

| Element | Result |
|---------|--------|
| `<h1>` | font-size 21px, weight 600 (body 15px) — visually distinct |
| `<ul>` | 3 items, `list-style-type: disc` |
| `<ol>` | 3 items, `list-style-type: decimal` |
| `<pre><code class="language-javascript">` | font: `JetBrains Mono Variable / JetBrains Mono / Sarasa Mono SC / Source Han Mono SC / ui-monospace / SF Mono / Menlo / Consolas / monospace` |
| `<blockquote>` | rendered |
| `<strong>` | rendered (bold weight) |
| `<em>` | rendered (`font-style: italic`) |
| inline `<code>` (not in `<pre>`) | 1 found, monospace JetBrains Mono, `padding: 3.5px`, `bg-bg-elevated` |

**Verdict:** PASS — all 8 markdown elements render correctly with appropriate semantics and styling.

---

## Check C — Long output (count 1..200)

200 numbered lines streamed in. Scroll metrics post-stream:

```
scrollHeight=5480 clientHeight=648 scrollTop=4832.5 distanceFromBottom=-0.5
```

Auto-stuck to bottom while streaming (distance -0.5px). User can scroll back to top (`scrollTop` -> 0). When not at bottom, **"Jump to latest"** button appears (verified by aria-label in DOM after scrolling up).

**Verdict:** PASS — scroll behavior, auto-stick, and jump-to-latest affordance all work.

Screenshots: `check-c-long-output-bottom.png`, `check-c-scrolled-to-top.png`, `check-c-jump-button.png`.

---

## Check D — Long markdown truncation / "show more"

For a long assistant block (the count-to-200 reply, ~4400px tall), no expand/collapse affordance was found:

```
expandBtnText: null
clipping: null
blockScrollHeight: 4400
blockClientHeight: 4400
```

Block renders inline at full height with no max-height clip. Long output is shown in full and the **outer chat container** is what scrolls (covered in Check C). Bash tool blocks have a "Show full output (N lines)" expand control (per fp8 probe), but assistant markdown blocks do not.

**Verdict:** PARTIAL — feature gap noted. May be intentional (chat UX prefers full inline rendering, parent scroll handles overflow), but not fixed by this worker per scope.

Screenshot: `check-d-truncation.png`.

---

## Check E — Mixed CJK + English

**Prompt:** `summarize 这段内容: hello 世界 こんにちは`

**Reply (excerpt):**
> The content is a simple multilingual greeting saying **"Hello"** in three languages:
> - **English**: hello
> - **Chinese**: 世界 (world) — though this means "world," it's commonly paired with "hello" as in "Hello World"
> - **Japanese**: こんにちは (Konnichiwa) — "Hello/Good afternoon"

Stats: CJK=2, Japanese hiragana/katakana=5, hasLatin=true, mojibake=false.

**Verdict:** PASS — three scripts (Latin, CJK han, Japanese hiragana) round-trip cleanly.

---

## Check F — Single 500-char line

**Prompt:** `output a single line of 500 'a' characters with no spaces and no newlines, then stop.`

**Reply:** longest run of 'a' = 506, total length 506. Model produced the line.

**Layout analysis (assistant block):**

```
blockWidth      = 978
streamWidth     = 1016
blockOverflowsStream = false   (block itself stays within stream container width)
pWordBreak      = "normal"
pOverflowWrap   = "normal"
pWhiteSpace     = "pre-wrap"
streamScrollWidth = 4297
streamClientWidth = 1006
hasHorizontalOverflow = TRUE   (4297 > 1006)
```

The unbreakable 500-`a` run does NOT wrap because `word-break: normal` + `overflow-wrap: normal` only break at word boundaries, and 500 contiguous letters with no break opportunities have no boundary. The chat stream container ends up with a horizontal scroll area ~4× its visible width. Visual confirmation: the `a` line extends far past the right edge of the chat container in the screenshot.

**Verdict:** FAIL — long unbreakable single-line responses break layout. Recommended fix (NOT applied by this worker per scope): add `overflow-wrap: anywhere` (or `word-break: break-word`) to the assistant block's `<p>` so unbreakable runs wrap at any character. CodeBlock already handles this differently (it has its own scroll container); the regression is on plain prose `<p>`.

Screenshot: `check-f-long-line.png`.

---

## Setup notes

- HOME sanitized via `HOME=/tmp/ccsm-fp11-home USERPROFILE=/tmp/ccsm-fp11-home` to avoid skill-injection (per `feedback_probe_skill_injection.md`).
- Per `project_renderer_reads_claude_config_dir.md` gotcha: probe sets BOTH `CCSM_CLAUDE_CONFIG_DIR` and `CLAUDE_CONFIG_DIR` in the Playwright launch env so the renderer's commands-loader picks up the bare one.
- Isolated user-data dir wiped fresh: `C:\temp\ccsm-dogfood-r2-fp11`.
- Proxy: `ANTHROPIC_BASE_URL=http://localhost:23333/api/anthropic` (Agent Maestro).
- All 6 prompts answered (cost: small, total wall time: ~30s).
- DOM selector note: the installed CCSM bundle does NOT yet contain `data-assistant-block-id` (added post-merge in #397). Probe falls back to `[data-type-scale-role="assistant-body"]` which is present in the bundle. Once the next CCSM build is installed, the more specific selector will work too.
