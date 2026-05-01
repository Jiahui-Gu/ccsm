# Review of chapter 08: Testing

Reviewer: R4 (Scalability / performance)
Round: 1

## Findings

### P1-1 (must-fix): Worst-case PR CI of 17 min ignores Cloudflare Pages preview latency + flake retries
**Where**: chapter 08 §9 ("Total worst-case PR CI: ~17 minutes... Comparable to v0.3 baseline (~6 min) plus the new web/multi-client surface.").
**Issue**: 17 min is the **happy path serial sum**, but in practice:
- GitHub Actions queues add 0-5 min on busy days.
- `cf-smoke.yml` says "nightly cron + release tag" — fine, but `pages-preview.yml` (Cloudflare-managed) is "every PR" with "external" runtime. Pages preview build runs `npm install + buf generate + tsc + vite build` cold every time. Realistic Pages preview build of an SPA this size: 4-7 min. This isn't in the 17-min total but a contributor waiting on PR-check completion still waits for it.
- Playwright on real Chromium has a per-test flake rate of 1-3% even when "stable"; 6 cases × 6 retry budget = real-world e2e runtime can double.
- Multi-client e2e (L5) needs daemon spawned + Electron spawned + Playwright Chromium spawned in one CI runner — concurrency cost on a 2-CPU GH runner is the limit.
**Why P1**: PR cycle time is the spec's perf-of-the-development-process. v0.3 was ~6 min; v0.4 jumping to 17+ min nominal (likely 25+ min wall-clock) is a major regression for contributor flow.
**Suggested fix**:
1. Parallelize: Daemon-unit + daemon-contract should run as separate jobs, not serial. Both depend only on daemon code.
2. Skip cascade: if `proto.yml` fails, short-circuit downstream `daemon-contract.yml` (no point running).
3. Add explicit wall-clock budget: "PR-time CI (95th percentile, including queue + flake retry): ≤25 min." Track in chapter 09 dogfood gates.
4. Document that Pages preview build is in addition; estimate it.

### P1-2 (must-fix): `vite preview` + Playwright web e2e doesn't actually exercise HTTP/2 path
**Where**: chapter 08 §5 ("Where Playwright runs: GitHub Actions, headed Chromium. Web build served via `vite preview` on localhost:4173. Daemon on localhost:7878. Test browser navigates `http://localhost:4173/`...").
**Issue**: `vite preview` serves over HTTP/1.1 by default (Node's stock http server). Playwright's Chromium → localhost on HTTP/1.1 → proxy via vite middleware → daemon HTTP/2. The browser never speaks HTTP/2 in this test. Real prod path: Browser ↔ Cloudflare edge (HTTP/2 or HTTP/3) ↔ cloudflared (HTTP/2) ↔ daemon (HTTP/2). Test misses streaming behaviors specific to HTTP/2 multiplexing, header compression, flow control.

Specifically: Connect-Web's behavior under HTTP/2 server-streaming is very different from HTTP/1.1 (which uses chunked transfer encoding + a different framing). v0.4 design assumes HTTP/2 throughout (chapter 02 §1, chapter 05 §8 forces `--protocol http2`). The test framework doesn't validate that assumption.
**Why P1**: The test stack diverges from prod on the most-novel transport behavior. Bugs in stream backpressure, heartbeat, multi-client coherence under HTTP/2 will not be caught in CI.
**Suggested fix**:
1. Configure `vite preview` with HTTPS + HTTP/2 (Node 18+ has `http2` server; Vite plugin `@vitejs/plugin-basic-ssl` provides cert; explicit HTTP/2 config).
2. OR: serve the built SPA via a tiny Node HTTP/2 server (~30 LOC) instead of `vite preview`.
3. L6 (Cloudflare smoke) covers real HTTP/2 e2e but only nightly — too late for catching regressions.

### P2-1 (nice-to-have): No size-budget regression test on `gen/ts/`
**Where**: chapter 08 §2 (proto+buf gates).
**Issue**: `buf` gates catch wire-breakage and lint, NOT codegen output size growth. Adding a single big message can balloon `gen/ts/` (and hence the web bundle) by 50+ KB without any CI signal.
**Why P2**: Bundle-size gate (chapter 10 R10) catches the downstream effect. Upstream gate would catch it earlier.
**Suggested fix**: Add `wc -l gen/ts/**` line-count check to `proto.yml`; fail if growth exceeds 10% per PR. Cheap to compute.

### P2-2 (nice-to-have): Multi-client coherence e2e is single-pair; doesn't stress the fanout
**Where**: chapter 08 §6 ("Multi-client coherence test").
**Issue**: One Electron + one web tab = 2 subscribers. Doesn't test the fanout-registry under the cap from chapter 06 R4 P0-2 (suggested 8 subscribers). No test for the reconnect-storm scenario.
**Why P2**: Real failures will surface in dogfood, not CI; but a load case is cheap.
**Suggested fix**: Add an L5b case: 1 daemon + 5 web clients (5 Playwright contexts, each one tab) on the same session. Assert all 5 see consistent input/output for a 30s burst. Adds ~1 min to multi-client suite.

## Cross-file findings

**X-R4-H**: HTTP/2 test path crosses chapter 04 (web build), 05 (cloudflared), 08 (this chapter). Single fixer to align.
