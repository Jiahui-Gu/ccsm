-- bad fixture: ADD COLUMN with NOT NULL but NO DEFAULT.
-- Expected: tools/check-migration-additivity.sh exits non-zero.
-- This shape would fail at sqlite migration time on any DB with existing
-- rows in `sessions`, because there is no value to back-fill.

ALTER TABLE sessions ADD COLUMN priority INTEGER NOT NULL;
