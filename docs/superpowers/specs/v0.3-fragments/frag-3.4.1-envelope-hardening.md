# Fragment: §3.4.1 Envelope hardening (frame cap + chunk + binary)

**Owner**: worker dispatched per Task #932
**Target spec section**: insert after §3.4 in main spec
**P0 items addressed**: #6 (envelope cap), #7 (head-of-line), #8 (binary frame)

## What to write here
Replace this section with the actual `### 3.4.1 Envelope hardening` markdown
that will be pasted into the main spec. Cover:
1. **16 MiB hard cap per envelope** — reject longer; close socket; rationale
   (DoS protection, mirrored at §3.1.1 socket level for defense in depth).
2. **Head-of-line mitigation** — chunk PTY output frames to ≤16 KiB before
   serialization; rationale: single Connect socket multiplexes all sessions,
   one large frame would block all peers; cite the perf review report.
3. **Binary frame format** — drop base64 (1.33× inflate) for PTY output;
   use Connect's binary message support; keep JSON envelope for control
   messages. Specify the wire format (length-prefixed binary payload +
   small JSON header, or chosen Connect mechanism).

Cite specific findings from `~/spike-reports/v03-review-perf.md` and
`~/spike-reports/v03-review-security.md` where each requirement comes from.

## Plan delta
List concrete edits to `docs/superpowers/plans/2026-04-30-v0.3-daemon-split.md`:
- e.g. "Task 5 (RPC adapter) gains: envelope cap (+2h), chunk logic (+3h),
  binary frame format (+4h). New estimate: NN h."
- New tests required (perf regression test for chunk size? unit for cap?).
- Any new task to create.
