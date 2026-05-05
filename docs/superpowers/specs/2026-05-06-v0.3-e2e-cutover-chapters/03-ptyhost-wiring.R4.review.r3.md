# Review of chapter 03: ptyHost wiring (round 3)

Reviewer: R4 (Scalability / performance — narrow re-review of CF-9)
Round: 3

## Scope

Narrow re-review limited to the single P1 finding R4 r2 left blocking
(SSE pty pipe latency / throughput target unaddressed). All other R4
concerns from r1/r2 had already been resolved or accepted; this round
only verifies CF-9 (commit `e29e627f`, +8 lines).

R4 r2 verdict explicitly stated:

> "Either landing the §2.x or the F-7 forward-ref satisfies this finding —
> what's not acceptable is leaving §2 as it stands with no acknowledgement
> of the missing target."

CF-9 took the F-7 forward-ref path. Three things had to be true for the
finding to close:

1. ch03 §2 must contain an explicit acknowledgement segment (not just a
   §7 table row).
2. ch03 §7 deferred-table must contain row F-7 with correct numbering and
   cover latency + throughput + Set B `pty-sse-burst-drain` drain probe.
3. The two locations must cross-link.

## Verification

### (1) §2 forward-ref segment — PRESENT

End of §2 (`### Latency / throughput targets — deferred (v0.4)`,
lines 184–188):

> producer→paint p99 latency target 与 per-sid sustained throughput target
> (Set B drain probe `pty-sse-burst-drain`) 在 v0.3 不写硬指标, 仅保证 §2
> G-1..G-5 的 correctness 契约 + G-5 64 KiB queue cap 的反压信号。defer
> 到 v0.4 reliability spec, 见 §7 F-7。

This is exactly the acknowledgement R4 r2 required: §2 itself now
flags the missing target instead of pretending G-1..G-5 cover it, and
explicitly forwards to §7 F-7. Naming both producer→paint p99 latency
and per-sid sustained throughput, and naming the Set B drain probe by
its harness ID, is more precise than the bare "missing target" the
finding minimally needed.

### (2) §7 F-7 row — PRESENT, numbering correct

Deferred table now has rows F-1..F-7 (line 669):

> | F-7 | SSE pty pipe latency / throughput targets + Set B `pty-sse-burst-drain` drain probe — v0.3 仅保留 G-1..G-5 correctness 契约, 不写 latency/throughput 数字; v0.4 reliability spec 一并定 (与 F-1..F-3 sigkill 系列一起设计) | v0.4 reliability spec PR (TBD) |

Numbering is contiguous (F-1..F-6 already existed; F-7 appends cleanly).
The row's content covers all three sub-items R4 r2 wanted accounted for:
latency target, throughput target, and the `pty-sse-burst-drain` drain
probe. Routing to "v0.4 reliability spec PR (TBD)" is consistent with
F-1..F-3 (the sigkill reliability cluster), which is the right home — F-7
notes this co-design explicitly.

### (3) Cross-link bidirectionality — PRESENT

- §2 → §7: "见 §7 F-7" (explicit).
- §7 F-7 → §2: row text "v0.3 仅保留 G-1..G-5 correctness 契约" names the
  §2 G-1..G-5 cluster by ID, so a reader landing on F-7 first knows
  where the v0.3 contract lives.

The link is bidirectional in substance even if §2's link is the only
literal section reference; that is sufficient for a forward-ref defer.

## P1 status

R4 r2 P1 (SSE pty pipe latency / throughput target) — **CLOSED via defer**.

The defer is well-formed: §2 acknowledges the gap, §7 F-7 carries the
deferred work into v0.4 reliability spec with concrete sub-items
(p99 latency, sustained throughput, drain probe), and the placement
alongside F-1..F-3 means v0.4 will design the SSE reliability targets
together with the sigkill-reattach reliability targets — which is the
correct grouping (both are about long-tail behaviour of the same pipe).

## P2 (cosmetic, non-blocking)

None worth recording. The §2 segment's heading `### Latency / throughput
targets — deferred (v0.4)` does not strictly belong under §2's existing
sub-numbered structure (it's inserted between §2's last G-rule discussion
and §3), but this is the same pattern §2 already uses for its other
inline subsections, so it does not warrant a fix.

## Verdict

**CLEAN**

CF-9 lands the F-7 forward-ref path R4 r2 explicitly accepted. §2
acknowledgement is present, §7 F-7 row is present with correct numbering
and full sub-item coverage, and the two cross-link. R4's narrow blocker
is resolved; no new P0/P1 raised in this narrow round.
