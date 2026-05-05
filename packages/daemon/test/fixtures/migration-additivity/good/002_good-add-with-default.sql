-- good fixture: ADD COLUMN with NOT NULL AND DEFAULT.
-- Expected: tools/check-migration-additivity.sh exits zero for this file.
-- DEFAULT clause means existing rows are back-filled at migration time.

ALTER TABLE sessions ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
