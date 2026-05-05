-- good fixture: ADD COLUMN that is nullable (no NOT NULL).
-- Expected: tools/check-migration-additivity.sh exits zero — nullable
-- columns are always safe to add (existing rows get NULL).

ALTER TABLE sessions ADD COLUMN annotation TEXT;
