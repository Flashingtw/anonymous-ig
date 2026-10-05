-- Preparation is not publication. Keep existing queue snapshots and number locks.
ALTER TABLE instagram_queue ADD COLUMN preparation_status TEXT NOT NULL DEFAULT 'none'
 CHECK(preparation_status IN ('none','processing','ready'));
ALTER TABLE instagram_queue ADD COLUMN prepared_at TEXT;
-- Retry eligibility must not move the requested publication time.
ALTER TABLE instagram_queue ADD COLUMN next_attempt_at TEXT;
