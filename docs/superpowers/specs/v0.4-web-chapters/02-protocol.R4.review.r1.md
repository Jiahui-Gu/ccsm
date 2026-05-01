# Review of chapter 02: Protocol (Connect + Protobuf + buf)

Reviewer: R4 (Scalability / performance)
Round: 1

## Findings

### P1-1 (must-fix): `buf breaking` against `main` doubles every PR's CI critical path
**Where**: chapter 02 §4 ("CI gates" + "Why `buf breaking` against `main` not against the latest tag").
**Issue**: The CI says `buf lint` + `buf breaking --against '.git#branch=main,subdir=proto'` + `buf generate && git diff --exit-code gen/` runs on every PR touching `proto/**` or `gen/**`. Chapter 08 §2 puts this at "~30s on GitHub-hosted runner". That budget assumes a hot runner; real cost is dominated by `buf` cold install + git fetch of `main`. With ~12 bridge-swap PRs in M2 — each touching `proto/` AND `gen/` — every PR pays the breaking-check cost AND the `buf generate` regen cost. Worst, `git diff --exit-code gen/` will trip on ANY whitespace / generator-version drift across runner environments (different `buf` minor versions emit slightly different ESM output ordering).
**Why P1**: Spec promises ~30s; if it routinely lands at 90-120s and frequently flakes on `gen/` diff (a known protobuf-es behavior across versions), the M2 bridge-swap window becomes a CI rebase storm (precisely the migration-window risk chapter 08 §9 already worries about). Performance budget must be defended at spec time, not absorbed at PR review time.
**Suggested fix**:
1. Pin the **exact** `@bufbuild/buf` and `protoc-gen-es` patch versions (chapter 11 §8 currently says `^2.x` — caret breaks pin; lock to `=2.X.Y`).
2. Cache `buf` binary in GH Actions (`actions/cache@v4` keyed on lockfile).
3. Run `buf breaking` only when `proto/**` changes, NOT when only `gen/**` changes (a `gen/` regen with no `.proto` change cannot be wire-breaking).
4. State explicit per-step time budget in §4 ("buf lint: ≤5s, breaking: ≤15s, generate+diff: ≤10s").

### P1-2 (must-fix): `gen/ts/` vendored under git is a repo-size + diff-noise time bomb
**Where**: chapter 02 §2 G2 ("Why vendored codegen") and §5 ("Output dir: gen/ts/ccsm/v1/. Vendored (committed).").
**Issue**: Every proto edit produces a corresponding diff in `gen/ts/` that is 5-20× the size of the `.proto` change. Across ~46 RPCs + the M2 swap PRs, the `gen/` directory will accumulate enough churn to:
- Bloat `git clone` time (every historical regen lives forever in pack files).
- Dominate every `git log -p` / `git blame` for downstream renderer code maintainers.
- Make `git diff` on PRs unreviewable without `:!gen/` exclusions.

Chapter 02 §5 also asserts `gen/ts/` MUST be ESM and that "pkg handles ESM-to-CJS interop" — at v0.3 daemon packaging time `@yao-pkg/pkg` ESM interop has been a known pain point; spec doesn't budget the daemon build-time cost of running ESM-to-CJS through pkg for ~46 stub files.
**Why P1**: This determines repo size growth rate and developer `git` UX for the next year. v0.3 packaging memory says ESM in pkg is fragile; a perf-spec must call this out, not bury it.
**Suggested fix**:
1. Add `.gitattributes` entry: `gen/** linguist-generated=true -diff` so GitHub collapses the diff.
2. Document expected `gen/` line count growth per release (rough budget: <10 KLOC at v0.4.0; >30 KLOC = revisit vendoring).
3. Spike-test `pkg` against generated ESM Connect stubs BEFORE M1 freezes the toolchain choice — if pkg chokes, we need to know now, not at M2 packaging time.
4. Consider a CI-only "regenerate at install" mode for the daemon build (skip vendoring, regen during `npm run build`) as fallback if pkg-ESM proves fragile.

### P1-3 (must-fix): HTTP/2 frame cap of 16 MiB is contradicted by HTTP/2 spec
**Where**: chapter 02 §8 table row "16 MiB frame cap" → "HTTP/2 `SETTINGS_MAX_FRAME_SIZE` capped at 16 MiB on the daemon's `Http2Server`. Connect rejects oversized streams natively."
**Issue**: HTTP/2 RFC 7540 section 6.5.2 caps `SETTINGS_MAX_FRAME_SIZE` at **2^24-1 = 16,777,215 bytes ≈ 16 MiB minus 1 byte**, AND the value advertised is the **per-FRAME** limit, NOT a per-message or per-stream size cap. A single Connect message can be split across many DATA frames; the protobuf message itself can still be GBs and Connect-Node will happily decode it on the heap. The spec conflates "frame cap" (transport) with "message cap" (application). v0.3's envelope had a real per-message cap; Connect needs an explicit `readMaxBytes` interceptor on every server route to preserve it.
**Why P1**: This is a real DoS surface (single malformed PTY input or `db:save` could OOM the daemon) AND a perf claim ("cap preserved") that the design doesn't actually deliver. Inheritance table is wrong.
**Suggested fix**:
1. Replace the table cell with: "**Per-message** cap implemented via Connect-Node `readMaxBytes` option on every route (default 4 MiB; PTY input route raised to 1 MiB, `db:save` route raised to 16 MiB). HTTP/2 frame size is a separate transport setting we leave at Node default 16 KiB."
2. Add a §8 sub-section listing per-RPC `readMaxBytes` values (a small table — 5 rows max).
3. Add an interceptor that logs + rate-limits messages near the cap so we can detect attack patterns.

### P2-1 (nice-to-have): Per-keystroke unary RPC overhead under-quantified
**Where**: chapter 02 §1 (half-duplex caveat) crossing into chapter 06 §3.
**Issue**: Spec asserts "Per-keystroke unary RPCs over HTTP/2 are cheap (multiplexed on the existing connection)". True, but each unary still pays: 1 HEADERS frame out (~50-100 bytes after HPACK), 1 DATA frame (~10-20 bytes for one keystroke), 1 HEADERS frame back (response trailers), JWT validation interceptor cost remote-side (jose verify ~0.5-2ms even with cached JWKS), trace-id ULID generation, pino log line. At 90 wpm = ~7.5 keys/sec ≈ 7.5 RPCs/sec/session before the 5ms coalesce, and the coalesce only helps for paste. Idle desktop typing remains chatty. No measurement budget given.
**Why P2**: Won't break v0.4 launch but determines whether multi-client typing feels native. Worth a one-sentence target.
**Suggested fix**: Add an explicit performance budget in §1: "Per-keystroke unary RPC end-to-end latency target: ≤15 ms over local socket, ≤80 ms over Cloudflare Tunnel from same continent." Measured in M3 dogfood gate.

## Cross-file findings

**X-R4-A**: `readMaxBytes` per-route caps need to appear in chapters 02, 06 (PTY), and 07 (storage.full edge case). Single fixer.

**X-R4-B**: `gen/ts/` vendoring policy interacts with chapter 04 (web bundle size) and chapter 08 (CI budget). Should be one consistent decision across all three chapters.
