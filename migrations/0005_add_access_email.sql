-- Additive only: keep every existing identity, role, session and audit row.
ALTER TABLE admins ADD COLUMN access_email TEXT
  CHECK (access_email IS NULL OR (length(trim(access_email)) BETWEEN 3 AND 254));
ALTER TABLE admins ADD COLUMN access_email_normalized TEXT
  GENERATED ALWAYS AS (lower(trim(access_email))) VIRTUAL;
CREATE UNIQUE INDEX idx_admins_access_email_normalized
  ON admins(access_email_normalized) WHERE access_email_normalized IS NOT NULL;
-- Existing 0004 identity constraints are unchanged. Email-only new admins are
-- deliberately not enabled by this migration; bind an existing GitHub admin.
