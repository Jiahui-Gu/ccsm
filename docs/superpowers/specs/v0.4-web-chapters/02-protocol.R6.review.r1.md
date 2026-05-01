# Review of chapter 02: Protocol (Connect + Protobuf + buf)

Reviewer: R6 (Naming / consistency / clarity)
Round: 1

## Findings

### P1-1 (must-fix): "All ~22 bridge RPCs" stale; chapter 03 made 46 the canonical figure

**Where**: 02 §6 line 139: "**Data socket** (...): **Connect over HTTP/2** in v0.4 (was hand-rolled envelope in v0.3). **All ~22 bridge RPCs** + future RPCs."
**Issue**: Same stale-count problem as 00 §3 and 01 G3. Chapter 03 §1 explicitly retires "~22" as an undercount; canonical is 46. Two figures in the spec for the same concept.
**Why P1**: implementer reading 02 alone will under-scope the data-socket route registration in M1 ("only 22 routes"). Cross-file fix needed.
**Suggested fix**: "All ~46 bridge RPCs" — and reference chapter 03 §1.

### P1-2 (must-fix): "T14" / "T15" labels ungrounded — no glossary, no anchor in this spec

**Where**:
- 02 §6 line 133: "the **control socket** (a.k.a. supervisor transport, `daemon/src/sockets/control-socket.ts` **after T14**, separate from `data-socket.ts`)"
- 11 §2 line 35: "`daemon/src/sockets/data-socket.ts` | Data-socket transport **(T15)** | M1-M2: ..."

**Issue**: "T14" and "T15" appear to be v0.3 task IDs (or v0.3 plan-task IDs) that this spec assumes the reader knows. No glossary, no link, no expansion. A reader of v0.4 spec without v0.3 plan context cannot resolve "after T14" — does it mean "after task T14 lands", "after revision T14 of some doc", "after milestone T14"? Worse: the file `daemon/src/sockets/control-socket.ts` may or may not exist on `working` HEAD depending on whether T14 has landed.

**Why P1**: a fact about a file path that depends on an opaque external label is not actionable — the implementer can't grep for "T14" and resolve it. Similar issue: 11 §2 line 35 just appends "(T15)" with no explanation.

**Suggested fix**: drop "after T14" entirely (the file path is enough; if it doesn't exist on HEAD when implementer arrives, they can grep). For 11 §2 row, drop "(T15)". If the v0.3 task ID is genuinely useful provenance, change to: "control socket transport (created in v0.3 plan task T14; see `docs/superpowers/specs/v0.3-daemon-split.md` §X)".

### P2-1 (nice-to-have): Untagged code fence for `proto/` directory tree

**Where**: 02 §3 line 51-67 — the `proto/` directory tree opens with ```` ``` ```` (no language tag). All other tree/code blocks in the doc tag with `ts`, `proto`, `yaml`, `proto`. SKILL.md style guidance is "language tags consistent (```ts not ```typescript)".
**Issue**: bare ``` makes syntax highlighting silent (renders as plaintext). Inconsistent with sibling blocks in the same chapter (02 §4 lines 80, 95 are tagged `yaml`).
**Suggested fix**: change line 51 opening fence to ```` ```text ```` or just leave plain — but **make it consistent** with chapter 04 §1 (which also has an untagged tree at line 20). Decision: tag tree blocks with `text`. Cross-file finding — also affects chapter 04 §1, chapter 05 §1, etc.

### P2-2 (nice-to-have): "PROTO" / "Protobuf v3" / "Protobuf" — pick one for first-use definition

**Where**: 02 §1-§2 use "Connect-RPC", "Protobuf v3", "Protobuf". The acronyms RPC, JWT (chapter 05), CSP (chapter 10), CORS (chapter 03), JWKS (chapter 05) are used without first-use expansion in any chapter. RFC 2119 is mentioned (01 §5) but never expanded.
**Issue**: The spec assumes deep prior context. An engineer joining v0.4 mid-stream sees "Connect-RPC" and may not know what RPC stands for in this context (gRPC? Custom?). For this team it's fine; for an outside reviewer it's a hurdle.
**Why P2**: doesn't block implementation; affects onboarding cost.
**Suggested fix**: at first use in chapter 00 (overview) or chapter 02, expand each acronym once: "Connect (RPC framework from Buf)", "Protobuf v3 (Protocol Buffers, Google's binary serialization)", "JWT (JSON Web Token)", "JWKS (JSON Web Key Set)", "CSP (Content Security Policy)", "CORS (Cross-Origin Resource Sharing)". This is a single-chapter (00 or 02) fix once the convention is established.

## Cross-file findings (if any)

- P1-1 (~22 → ~46 normalization) bundles with 00 P1-1 and 01 P1-2. ONE fixer for all three callsites.
- P2-1 (untagged code fences) spans 02 (line 51), 04 (line 20, 50), 05 (lines 28, 36, 71, 78, 99, 121). See chapter 05 review for full list. ONE fixer.
- P2-2 (acronym definitions) is a single insertion in 00 or 02 — best done by 00 fixer.
