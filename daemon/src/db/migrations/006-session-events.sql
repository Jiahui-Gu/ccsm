-- 006-session-events: ring-buffered delta log for SubscribeSessionEvents.
--
-- Backs session_events.proto + sessions.proto §SubscribeSessionEvents
-- (final-arch §2.7 snapshot+delta+LWW model). The 256-KiB / N-event
-- replay budget (frag-3.5.1 res-P0-1, generalized) is enforced by
-- background prune; this table is the on-disk window the daemon serves
-- to subscribers reconnecting with `from_seq` < latest.
--
-- seq is a daemon-assigned monotonic sequence per session (see
-- sessions.session.latest_seq added by 001-session-extensions). The
-- composite PK (session_id, seq) lets us range-scan a single subscriber
-- without crossing into other sessions' history. AUTOINCREMENT is
-- intentionally NOT used — seqs are caller-supplied so the
-- `latest_seq` writer (one transaction per delta) is the sole source of
-- truth for ordering, matching final-arch §2.7's "daemon authoritative
-- monotonic seq".
--
-- payload is the serialized SessionDeltaEvent (proto JSON or binary —
-- caller's choice; daemon-opaque).
--
-- Additive: brand-new table.

CREATE TABLE IF NOT EXISTS session_events (
  session_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  ts_ms       INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);

-- Prune scan: "delete events older than N ms for sessions outside the
-- 256 KiB window". Indexed on ts_ms for the time-based half of the
-- prune predicate.
CREATE INDEX IF NOT EXISTS idx_session_events_ts
  ON session_events (ts_ms);
