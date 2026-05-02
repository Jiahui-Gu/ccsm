# 04 — Proto and RPC Surface — R4 (Testability + Ship-Gate Coverage)

## P0 — `buf breaking` job is "only on PRs after v0.3 tag"; pre-tag drift is unprotected

§8 / chapter 11 §6 / chapter 13 §2 phase 1: "`buf breaking` job exists but only activates against the v0.3 release tag (no-op until tagged)."

The forever-stability story relies on `buf breaking`. Between phase 1 (proto first frozen) and phase 12 (v0.3 tag), proto files will be edited by every phase that adds a handler / fixes a bug. No mechanical gate prevents an editor from changing a field number or removing a field "to fix a typo." By tag time, the v0.3 schema is whatever was last committed — possibly already drifted from the chapter-04 spec.

Two fixes:
1. **Lockfile from phase 1**: per chapter 13 §2 phase 1, "`packages/proto/lock.json` with SHA256 per `.proto` file (committed; CI-checked)." Good — but the lockfile only catches changes to the file, not specifically breaking changes. A field rename within a service still changes SHA. Either every internal "fix typo" in proto requires updating the lock (acceptable, makes change explicit), or the lock is meaningless. Pin: any commit changing a `.proto` file MUST also update `lock.json`; CI rejects PRs where one changed without the other.
2. **`buf breaking` against `main` branch from phase 1 onward**, not against the v0.3 tag. Until tag exists, compare against the SHA of the proto files at the merge-base of the PR. After tag, compare against tag.

P0 because chapter 15 §1 and §3 (forbidden patterns) make forever-stability the central design promise; the only mechanical enforcement is `buf breaking`; the spec deliberately disables it during the entire v0.3 build window.

## P1 — Open string sets (`source`, `client_kind`) have no contract test

`CrashEntry.source` and `HelloRequest.client_kind` are open string sets ("string, not enum"). Daemon and client must tolerate unknown values forever. There is no test asserting:
- Client receives `source="future_kind_v04"` and renders gracefully (not crashes)
- Daemon receives `client_kind="rust-cli"` and processes Hello normally

Without such tests, a v0.4 client emitting a new value could break the v0.3 daemon UI.

Add `proto/open-string-tolerance.spec.ts` exercising both directions.

## P1 — `proto_min_version` mechanism is specified but not tested

§3 / chapter 02 §6: client sends `proto_min_version`; daemon rejects incompatible with `FAILED_PRECONDITION` + structured detail. Chapter 12 §3 has `version-mismatch.spec.ts`. Good — but the test asserts only the rejection path. There is no test asserting:
- Client min < daemon current → accept
- Client min == daemon current → accept
- Forward compatibility: future client (newer min) → daemon may downgrade to its own version on accept (or reject explicitly?) — chapter 04 §3 doesn't say what happens.

Pin the truth table; test all rows.

## P1 — `RequestMeta` is required on every RPC but enforcement is unspecified

`RequestMeta` is `forever-stable` and "every RPC carries these." What if a client sends a request without `RequestMeta` (proto3 default: empty message — fields default to "" / 0)? Daemon: validates non-empty `request_id`? Server logs use `request_id`; if empty, traceability breaks. Pin daemon-side validation: empty `request_id` → `INVALID_ARGUMENT` OR daemon synthesizes one. Add test.

## P1 — `ErrorDetail` mechanism: no test that handlers actually attach details

§2: "Forever-stable error detail attached to ConnectError.details." Chapter 05 §4 shows `assertOwnership` attaching `errorDetail("session.not_owned", ...)`. No test in chapter 12 asserts an `ErrorDetail` survives the wire and is parseable on the client. ConnectError serialization can be subtle. Add `proto/error-detail-roundtrip.spec.ts`.

## P2 — Proto codegen lockfile mechanism (chapter 12 §2: `lock.spec.ts`) is good but doesn't cover `buf.gen.yaml` or generated output drift

`lock.spec.ts` SHA-checks `.proto` files. But `buf.gen.yaml` plugin versions also affect generated output; if a contributor bumps `buf.build/bufbuild/es:v1.10.0` to `:v1.11.0`, generated TS could behaviorally drift. Add lock for `buf.gen.yaml` too (just SHA the file).

## Summary

P0: 1 / P1: 4 / P2: 1
Most-severe: **`buf breaking` is intentionally disabled until v0.3 tag — meaning the entire build window has no mechanical guard against the forever-stability promise the spec is built on.**
