# R5 review — 04-proto-and-rpc-surface.md

## P0

### P0-04-1. `Hello` RPC field count mismatches between proto and chapter 02 §6
Chapter 02 §6 says "Electron MUST send a client version in `Hello`; daemon rejects incompatible versions with `FAILED_PRECONDITION` and a structured detail listing min compatible client". The `HelloRequest` has `client_version` (field 3) AND `proto_min_version` (field 4); `HelloResponse` returns `proto_version` (field 3). Chapter 12 §3 integration test `version-mismatch.spec.ts` says "Hello with `proto_min_version` higher than daemon's" — the daemon's check is `daemon.proto_version >= client.proto_min_version`. **But** chapter 02 §6 phrases the check as "daemon rejects incompatible versions" and "min compatible client" — which suggests the daemon enforces a **minimum client version**, not the inverse. Either:
- (a) the daemon enforces only `proto_min_version` from the client (= client demands daemon >= X), and chapter 02 wording is loose; or
- (b) the daemon also has a `min_compatible_client` it pushes back, but `HelloResponse` has no such field.

If (b), proto is missing `HelloResponse.min_compatible_client_version`. P0 because version negotiation semantics drive the entire compat story across releases.

### P0-04-2. `client_kind` forever-stable but listed values include `"electron" | "web" | "ios"`
§3 says `client_kind` is a string (not enum) so v0.5+ can add new clients without proto bump. Good. **But** the field is declared "forever-stable" in §3 and §7. v0.4 adds `"web"` and `"ios"` values — that is a value-set extension, not a proto schema change. The contract should be explicit: "**string values are open**; daemon and client both tolerate unknown" (matches §5 wording for `CrashEntry.source`). Currently §3 only says "v0.3 only `electron`" but does not document the value-set additivity rule. Make it parallel to §5 / §7 wording. P0 because forever-stability + closed-set would force a proto bump in v0.4 (= violates brief §6).

## P1

### P1-04-1. `Settings` has fields `claude_binary_path`, `default_geometry`, `crash_retention` — Settings update semantics not pinned
`UpdateSettingsRequest` takes a `Settings` message. Is this a full overwrite or partial update? Proto3 has no field presence for scalars — sending `default_geometry: { cols: 0, rows: 0 }` cannot be distinguished from "unset". Pin: either use `optional` for each field (proto3 supports, generates field-presence) or document the merge semantics. Currently a downstream worker writing the handler will guess.

### P1-04-2. `Session.exit_code int32 = 7; // valid only when state == EXITED`
Conditional-validity field. Proto3 default is 0. If a session exited cleanly with code 0, vs. session is still RUNNING, both serialize identically. Either: use `optional int32 exit_code` (proto3 optional), or document "consumers MUST gate on `state` before reading `exit_code`". Currently the comment says the latter, but it's still a foot-gun for downstream RPC users.

### P1-04-3. `RequestMeta.client_version` and `HelloRequest.client_version`
Two `client_version` fields, two messages, one purpose? Or are they different (per-call vs once-per-Hello)? Chapter 04 doesn't explain why both exist. Pin or remove duplication.

### P1-04-4. `proto_version int32 = 3` — is this a wire-version major or a proto-package minor?
§3 says "current v1 minor; client compares against its min". So this is a within-`v1` minor. Then v0.4 adds RPCs and bumps `proto_version`. v0.4 cannot have a v2-named package without breaking forever-stability. Document the relationship between the integer minor and the package suffix `v1`: minor=N means "all RPCs added on or before minor=N exist". Without this rule the field is just folklore.

### P1-04-5. `WatchSessions` stream — per-principal filter location
Chapter 05 §5 says `WatchSessions` "filter the in-memory event bus by `principalKey(ctx.principal)`; never emit other-owner events on this stream". §3 of chapter 04 only says `rpc WatchSessions(WatchSessionsRequest) returns (stream SessionEvent);` with no mention. Add a comment block above the RPC pointing at chapter 05 §5; otherwise a downstream worker implementing the handler can miss the filter (which is a security boundary).

### P1-04-6. `Supervisor` proto file listed but "NOT shipped to clients; daemon-internal mirror"
§1 lists `supervisor.proto` then says "not shipped to clients". If it's daemon-internal mirror of HTTP supervisor, why is it a `.proto` at all? Either: it generates internal types for type-safety (then state so) or it's vestigial (then drop). P1 — file existence without rationale invites accidental publication.

### P1-04-7. CI lint job description "buf breaking --against '.git#branch=v0.3'"
The branch name is `v0.3` here but chapter 13 §4 says trunk-based with the working branch named `spec/2026-05-03-v03-daemon-split` for spec and "for impl, the v0.3 release branch named separately by stage 6". So the branch for `buf breaking` will not be `v0.3`. Use a tag, e.g. `--against '.git#tag=v0.3.0'`. Currently command will fail.

## Scalability hotspots

### S1-04-1. `WatchSessions` and `WatchCrashLog` both server-stream
No backpressure / max-stream-per-client cap mentioned. A misbehaving Electron tab opening 100 `Attach` streams plus 100 `WatchSessions` is uncapped. Pin per-client stream count cap (e.g. 64).

## Markdown hygiene
- All proto blocks are language-tagged `proto`. Good.
- §7 table uses bold inconsistently: some rows have backticks-then-bold, some bold-then-backticks. Cosmetic.
- §1 file tree uses raw text — fine.
