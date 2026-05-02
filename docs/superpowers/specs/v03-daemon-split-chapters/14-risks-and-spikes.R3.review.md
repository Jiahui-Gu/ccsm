# R3 review — 14-risks-and-spikes

## P1-R3-14-01 — Disk-full residual risk is undertreated

§2 row "Disk full → SQLite write fails → session state corruption" mitigation: "write coalescer wraps in try/catch; failure → crash_log entry (best-effort) + session state degraded; reads continue from last good row."

This is a SPEC paragraph in the wrong place — disk-full handling is a normative behavior the daemon must implement, not a residual risk. Move to chapter 07 §5 (write coalescer) and chapter 06 §4 (snapshot cadence) as actual normative spec. Cross-reference R3-07-03 and R3-06-02.

## P1-R3-14-02 — Spike outcomes for unresolved logging/metrics absence

The MUST-SPIKE register does not include spikes for the logging/metrics gaps surfaced in R3-09-01 / R3-09-02. If those land as fixes, add corresponding spike entries (or, if the chosen library is already known, mark resolved with the choice — e.g., "use `pino` for structured logs; spike: pino-rotation works under sea").

## NO FINDING — existing spike register

Spike entries are well-formed: hypothesis, validation, kill-criterion, fallback. R3 angles do not invalidate any.
