# R5 review — 12-testing-strategy.md

## P0

### P0-12-1. Ship-gate (c) test naming/extension inconsistency
Chapter 12 §4.3 says "Test name `pty-soak-1h`. Specified in [06] §8." Chapter 06 §8 says test file `packages/daemon/test/integration/pty-soak.test.ts` (`.test.ts`) AND Electron-side `packages/electron/test/e2e/pty-soak-reconnect.test.ts`. Chapter 11 §6 CI invokes `pnpm run test:pty-soak`. Chapter 12 §3 elsewhere uses `.spec.ts` extension. Pick one extension. Pin one canonical test name. Currently 3 different file-name candidates implies 3 different tests.

### P0-12-2. Ship-gate (b) test file path inconsistency
- Chapter 08 §7 describes ship-gate (b) E2E test inline (no path).
- Chapter 12 §4.2 says `packages/electron/test/e2e/sigkill-reattach.spec.ts`.
- Chapter 13 phase 11 references "(b) sigkill-reattach.spec.ts per [12] §4.2".

OK consistent across 12+13. Chapter 08 §7 should add the file path for completeness.

### P0-12-3. `claude-sim` test binary build location and language
§5 "shipped a test build `claude-sim` in `packages/daemon/test/fixtures/claude-sim/`" and "tiny Go or Rust binary cross-compiled in CI alongside the daemon". **Pick one language now** — Go and Rust have different toolchain costs. Cross-compile matrix differs (Go: trivial; Rust: needs `cross` or per-target runners). Phase 5 (PTY host) acceptance can't proceed without `claude-sim` built. P0 for downstream — this is an undefined dep.

## P1

### P1-12-1. Per-RPC integration coverage criterion
§6 "every RPC in [04] MUST have at least one integration test exercising the happy path and at least one exercising an error path." §3 lists 8 integration test files. Cross-check against chapter 04's RPCs:
- SessionService: 6 RPCs (Hello, ListSessions, GetSession, CreateSession, DestroySession, WatchSessions). Covered by `connect-roundtrip.spec.ts` and `version-mismatch.spec.ts`.
- PtyService: 3 (Attach, SendInput, Resize). Covered by `pty-attach-stream`, `pty-reattach`, `pty-too-far-behind`. **Resize test missing.**
- CrashService: 2. `crash-stream.spec.ts` covers stream; **`GetCrashLog` happy/error path not listed.**
- SettingsService: 2. `settings-roundtrip.spec.ts` covers happy. **No error-path test listed.**

Either expand §3's test list OR loosen §6's "MUST". P1.

### P1-12-2. `peer-cred-rejection.spec.ts`
§3 includes it. Chapter 03 §5 says "If peer-cred resolution fails ... the middleware throws `Unauthenticated`." The integration test "connects with a synthesized non-owning peer-cred" — non-owning is different from peer-cred-resolution-failure. Two different scenarios:
- (a) peer-cred lookup fails (returns `Unauthenticated`).
- (b) peer-cred succeeds but caller's owner_id doesn't match the session (returns `PermissionDenied` per chapter 05 §4).

Pin both.

### P1-12-3. Vague verbs
- §6 "untested" for "UI-shell code (windowing, tray)" — pinned, OK.
- §7 "do NOT block PRs — too noisy in CI; manual triage gates ship" — pinned.

### P1-12-4. CI orchestration
Chapter 11 §6 has a separate CI sketch. Chapter 12 §4 references jobs but doesn't show the wiring. Cross-link 12 §4.* job names to 11 §6 job blocks. Currently a downstream worker has to mentally diff two YAMLs.

### P1-12-5. Performance budgets
§7 lists 5 metrics. None are unit-tested in §2. Pin: `bench/*.spec.ts` files in `packages/daemon/test/bench/` (path implied by file names but not declared in chapter 11 §2 directory layout). Add to layout.

## Scalability hotspots

### S1-12-1. Coverage target "80% line coverage on @ccsm/daemon/src"
Aggressive but reasonable. No mention of how `dist/`, `gen/`, `test/` exclusions are wired (vitest config). Pin in 11 or here.

## Markdown hygiene
- PowerShell pseudo-flow in §4.4 fence-tagged `powershell`. Good.
- Bash blocks tagged `bash`. Good.
- §1 table OK.
