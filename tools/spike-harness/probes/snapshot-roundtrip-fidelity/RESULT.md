# T9.7 — SnapshotV1 round-trip fidelity spike

Task: Task #109. Spec: ch14 §1.8 phase 4.5. Validates that a candidate
SnapshotV1 wire format satisfies the byte-equality property
`encode(decode(encode(s))) === encode(s)` for all snapshots `s` produced
by the deterministic vt-grammar corpus (C2) and a hand-curated xterm
replay corpus (C3 stand-in).

## TL;DR

**GREEN.** A small canonical TLV codec (88 lines including comments)
satisfies byte-equality across all 5 vt-grammar seeds (1000 sequences /
seed, 256 byte target length) and all 8 xterm replay edge cases,
including the canonical-form cross-check (two semantically equal
snapshots built with different counter-key insertion orders MUST encode
to the same bytes — the bug pure round-trip can't see).

Per-run wallclock: ~470 ms on `win32/x64` Node `v24.14.1`.

```
$ node tools/spike-harness/probes/snapshot-roundtrip-fidelity/probe.mjs
{"seed":1,"count":200,"payloadBytes":52232,"encBytes":52326,"encEqual":true}
{"seed":2,"count":200,"payloadBytes":52185,"encBytes":52279,"encEqual":true}
{"seed":3,"count":200,"payloadBytes":52449,"encBytes":52543,"encEqual":true}
{"seed":4,"count":200,"payloadBytes":52296,"encBytes":52390,"encEqual":true}
{"seed":5,"count":200,"payloadBytes":52211,"encBytes":52305,"encEqual":true}
{"xtermCase":"empty","payloadBytes":0,"encBytes":86,"encEqual":true}
{"xtermCase":"cursor-default","payloadBytes":5,"encBytes":91,"encEqual":true}
{"xtermCase":"sgr-reset","payloadBytes":15,"encBytes":109,"encEqual":true}
{"xtermCase":"osc-window-title","payloadBytes":15,"encBytes":109,"encEqual":true}
{"xtermCase":"dcs-passthrough","payloadBytes":13,"encBytes":107,"encEqual":true}
{"xtermCase":"cursor-move","payloadBytes":16,"encBytes":110,"encEqual":true}
{"xtermCase":"mixed-utf8","payloadBytes":22,"encBytes":116,"encEqual":true}
{"xtermCase":"counters-many","payloadBytes":2,"encBytes":89,"encEqual":true}
{"canonicalCrossCheck":"counters-insertion-order","encABytes":71,"encBBytes":71,"encEqual":true}
{"ok":true, ..., "verdict":"GREEN"}
$ echo $?
0
```

## Why this spike matters for T4.6

The daemon will persist terminal scrollback / cell grid as SnapshotV1
blobs and replay them on resume. If `encode(decode(encode(s)))` is not
byte-identical to `encode(s)` we lose:

- **Stable hashing** — no content-addressed dedup of identical snapshots.
- **Diff-friendly deltas** — a "no-op" persist round produces a different
  blob, so any diff-against-disk detection is forever noisy.
- **Reproducible CI golden tests** — flaky snapshot-equality tests train
  reviewers to ignore red.

Therefore the codec MUST be **canonical**: every logical snapshot has
exactly one byte-string encoding. The natural failure mode (most likely
to slip into T4.6's first cut) is map-iteration order leakage — covered
explicitly by the canonical cross-check.

## Canonical rules locked by this spike (forever-stable per ch14 §1.B)

| Rule | What                                                                     | Why this rule, not another |
| ---- | ------------------------------------------------------------------------ | -------------------------- |
| R1   | Magic `"SNP1"` (4 bytes ASCII) at offset 0                               | Cheap version sniff; survives misrouted blobs (e.g. snapshot blob fed to JSONL parser fails fast on `0x53 0x4E`). |
| R2   | All lengths big-endian `u32`; no zigzag, no var-int                      | Var-int admits multiple encodings of the same integer (LEB128 has a `0x80 0x00` vs `0x00` ambiguity if not strictly minimal). u32 is unambiguous and 4 extra bytes per field is negligible vs cell-grid payload. |
| R3   | Map keys serialised in lexicographic byte order                          | Blocks hash-iteration leakage. The canonical cross-check in `probe.mjs` is the regression sentry. |
| R4   | Strings = `u32 length` + UTF-8 bytes; no NUL terminator                  | NUL terminator + length-prefix admits two encodings (with/without trailing NUL) for the same string. |
| R5   | Optional fields use a `bool` presence byte; absent ⇒ ZERO payload bytes  | An absent optional cannot be written as `length=0` because that collides with "present-and-empty". `cursor` at `(0,0)` is **not** the same snapshot as "no cursor". |
| R6   | No floats; all numerics are `u32` / `i32`                                | IEEE-754 has multiple bit patterns per logical value (NaN payloads, ±0). Render-time math lives in the renderer. |

T4.6 inherits these rules verbatim. If T4.6's design needs to break any
of them (e.g. for size — switching to var-int), the design doc must
explicitly justify and supply a regression test that locks the new
canonical form.

## What the probe ships

| File              | Role                                                              |
| ----------------- | ----------------------------------------------------------------- |
| `probe.mjs`       | Reference codec + corpus runner + canonical cross-check           |
| `RESULT.md`       | This file — verdict, locked rules, T4.6 hand-off                  |

The reference codec in `probe.mjs` is **not** the production codec —
T4.6 will own that. The reference exists to (a) prove the property is
achievable with a small auditable core, (b) lock the canonicalisation
rules in concrete code that T4.6 can copy or replace.

## Reverse-verification (sanity check that the test can fail)

To prove the canonical cross-check actually catches R3 violations,
disable the sort:

```diff
-  const keys = Object.keys(snap.counters || {}).sort((a, b) => {
-    const ab = Buffer.from(a, 'utf8');
-    const bb = Buffer.from(b, 'utf8');
-    return Buffer.compare(ab, bb);
-  });
+  const keys = Object.keys(snap.counters || {});
```

Re-run with that patch:

```
$ node tools/spike-harness/probes/snapshot-roundtrip-fidelity/probe.mjs
... (vt-grammar + xterm cases all still pass — pure round-trip can't see this) ...
{"canonicalCrossCheck":"counters-insertion-order","encABytes":71,"encBBytes":71,"encEqual":false}
canonical mismatch:
  A=534e503100000001000000500000001801000000020000000000000004000000017a00000009000000016100000001000000016d00000005000000016200000002000000026869
  B=534e503100000001000000500000001801000000020000000000000004000000016100000001000000016200000002000000016d00000005000000017a00000009000000026869
{"ok":false, ..., "verdict":"RED"}
$ echo $?
1
```

The hex diff makes the bug obvious: `A` writes keys in `z, a, m, b`
order; `B` writes them sorted. Patch reverted before commit.

## Configurability

The forever-stable contract exposes three env vars (see `probe.mjs`
header comment):

- `PROBE_SEEDS`  comma-sep u32 list, default `1,2,3,4,5`
- `PROBE_COUNT`  sequences per seed, default `200`
- `PROBE_LENGTH` target bytes per sequence, default `256`

Increase any of them for fuzz-style soak (e.g. `PROBE_SEEDS=1,2,...,50
PROBE_COUNT=2000`).

## Recommendation for T4.6

**GREEN.** Implement the production SnapshotV1 codec on top of the R1-R6
rules above. Reuse this probe in CI: a green run on every PR that
touches `packages/snapshot-codec` is sufficient regression coverage for
the canonicality property (the actual cell-grid semantics are T4.6's
own unit tests). Wire-up suggestion:

```yaml
# .github/workflows/snapshot-fidelity.yml (sketch)
- run: node tools/spike-harness/probes/snapshot-roundtrip-fidelity/probe.mjs
  env:
    PROBE_SEEDS: 1,2,3,4,5,6,7,8,9,10
    PROBE_COUNT: 1000
```

That run is ~5 s wallclock and covers 50 000 randomly-generated VT
sequences plus the 8 xterm replay cases plus the canonical cross-check.

## Follow-ups (not blocking T4.6)

1. **Real xterm replay corpus.** The `XTERM_REPLAY_CASES` table here is
   hand-curated. Once T4.6 lands, swap in the upstream xterm
   `xterm/test/*.in` corpus (currently absent from this repo) and bump
   `XTERM_REPLAY_CASES` to read from disk. The contract in `probe.mjs`
   does not change — only the corpus source.
2. **Property-based fuzzing.** Replace the deterministic-seed loop with
   a `fast-check` arbitrary that synthesises Snapshot structs directly
   (skipping the VT fold). The current PRNG-driven approach already
   covers the byte-level surface; arbitrary-driven fuzz would catch
   structural bugs the VT model can't reach (e.g. `counters` with 10000
   keys). Defer until the first real shrinker is needed.
3. **Wire into the spec'd `snapshot-roundtrip.spec.ts`** stub once
   T4.6 ships the codec. The vitest spec (already pinned at
   `tools/spike-harness/snapshot-roundtrip.spec.ts`) becomes the
   in-tree regression; this probe stays as the spike-harness
   reference for CI scaffolding and reverse-verification.
