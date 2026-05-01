# Review of chapter 01: Goals and non-goals

Reviewer: R6 (Naming / consistency / clarity)
Round: 1

## Findings

### P1-1 (must-fix): Chinese text in spec violates English-only convention

**Where**: chapter 01, "Context block" line 5.
**Issue**: The line includes a quoted Chinese sentence:

> "v0.4 实际也是多加了个前端，也应该尽量不要改 feature."

Per project memory rule `feedback_github_english_only`: "PR title/body, commit msg, code comments, review comments 全英文". The spec is part of the repo and goes through PR review; it MUST be English-only. Quoting a user instruction is not an exemption — quote a translated paraphrase instead and note the source.

**Why P1**: explicit project policy violation; non-Chinese-reading future contributors (and machine-translation-driven CI / docs systems) hit a wall here.

**Suggested fix**: Replace the Chinese quote with an English paraphrase:

> "The user's Q1 message reaffirmed this: v0.4 also adds a frontend, and like the daemon split it should avoid changing product features."

### P1-2 (must-fix): "~22 IPC calls" figure stale and contradicts chapter 03

**Where**: chapter 01, G3 line 27: "All ~22 IPC calls in `electron/preload/bridges/*.ts`".
**Issue**: Chapter 03 §1 line 31 explicitly retires this number: "**Totals: 31 unary, 4 fire-and-forget, 11 streams = 46 cross-boundary calls**. (The '~22 IPC bridges' figure in the predecessor design doc was an undercount; v0.4 inventory is canonical going forward.)" Chapter 09 M2 line 23 also uses 46.
**Why P1**: scope/effort estimates anchor on this figure; two numbers (~22 vs ~46) yield two different M2 sizes. Same finding as 00 P1-1; cross-file fixer should normalize all three callsites.
**Suggested fix**: change "~22 IPC calls" to "all 46 cross-boundary IPC calls (per chapter 03 §1 inventory)".

### P2-1 (nice-to-have): RFC 2119 keywords not consistently uppercase

**Where**: §5 line 102-104 establishes the RFC 2119 convention ("MUST"/"SHOULD"/"MAY"). But several normative statements elsewhere use lowercase "must":
- 02 §4 line 109: "`buf lint` — must pass"
- 02 §4 line 110: "`buf breaking` — must pass against the merge target's `main` branch tip"
- 01 §1 G2 line 21: "`buf lint`... and `buf breaking`... MUST pass" (correct)
- 01 line 86 ("must not regress") — lowercase, but ambiguous whether this is normative or descriptive
**Issue**: Mixed case dilutes the RFC 2119 contract that §5 just established.
**Why P2 not P1**: experienced readers infer normative intent from context; this is style.
**Suggested fix**: audit each lowercase "must"/"should"/"may" in chapters 02, 04, 05, 06, 07, 08, 09 and uppercase where the statement is normative. Cross-file finding (touches multiple chapters); manager may bundle into a single fixer or defer to merge-stage cleanup.

### P2-2 (nice-to-have): "Web client" capitalization in G1 only

**Where**: 01 G1 line 17: "Schema lives in `proto/` and is the single source of truth for both the Electron renderer ... and the **Web client** (via `@connectrpc/connect-web`)."
**Issue**: 01 elsewhere (lines 31, 51, 86, 100, etc.) uses lowercase "web client". Same drift as 00 P2-1; one term, one casing.
**Suggested fix**: "Web client" → "web client" in G1 line 17.

## Cross-file findings (if any)

- P1-2 (~22 → 46 normalization) is cross-file with 00 §3, 02 §6, 03 already canonical. Bundle with the 00 fixer.
- P2-1 (RFC 2119 lowercase audit) spans 02/04/05/06/07/08/09 — recommend deferring to merge-stage cleanup unless P0/P1 fixers are already opening those files.
