-- good fixture: CREATE TABLE with NOT NULL columns (no DEFAULT).
-- Expected: tools/check-migration-additivity.sh exits zero — new tables
-- have no pre-existing rows to back-fill, so NOT NULL without DEFAULT is
-- safe.

CREATE TABLE feature_flags (
  name       TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);
