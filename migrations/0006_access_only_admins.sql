-- Local-only candidate. D1 migration file is atomic; do not apply without a rollout gate.
-- Rebuild referencing tables too: preserve IDs/identities/sessions/audit and owner guards.
-- Preserve AUTOINCREMENT high-water marks, including IDs of deleted rows.
CREATE TABLE migration_0006_sequences AS
SELECT name,seq FROM sqlite_sequence WHERE name IN ('admins','audit_logs');
CREATE TABLE admins_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_user_id TEXT UNIQUE
    CHECK (
      github_user_id IS NULL
      OR (
        github_user_id NOT GLOB '*[^0-9]*'
        AND length(github_user_id) BETWEEN 1 AND 32
      )
    ),
  github_username TEXT
    CHECK (github_username IS NULL OR length(github_username) BETWEEN 1 AND 100),
  username TEXT
    CHECK (username IS NULL OR length(username) BETWEEN 3 AND 32),
  username_normalized TEXT
    CHECK (
      username_normalized IS NULL
      OR (
        length(username_normalized) BETWEEN 3 AND 32
        AND username_normalized = lower(username_normalized)
        AND username_normalized = lower(username)
        AND username_normalized NOT GLOB '*[^a-z0-9_.-]*'
      )
    ),
  password_hash TEXT
    CHECK (password_hash IS NULL OR length(password_hash) BETWEEN 64 AND 512),
  password_updated_at TEXT,
  role TEXT NOT NULL DEFAULT 'moderator'
    CHECK (role IN ('owner', 'admin', 'moderator')),
  enabled INTEGER NOT NULL DEFAULT 1
    CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  access_email TEXT CHECK (access_email IS NULL OR length(trim(access_email)) BETWEEN 3 AND 254),
  access_email_normalized TEXT GENERATED ALWAYS AS (lower(trim(access_email))) VIRTUAL,
  CHECK (
    (github_user_id IS NULL AND github_username IS NULL)
    OR (github_user_id IS NOT NULL AND github_username IS NOT NULL)
  ),
  CHECK (
    (
      username IS NULL
      AND username_normalized IS NULL
      AND password_hash IS NULL
      AND password_updated_at IS NULL
    )
    OR (
      username IS NOT NULL
      AND username_normalized IS NOT NULL
      AND password_hash IS NOT NULL
      AND password_updated_at IS NOT NULL
    )
  ),
  CHECK (github_user_id IS NOT NULL OR username_normalized IS NOT NULL OR access_email IS NOT NULL)
) STRICT;

INSERT INTO admins_new (id, github_user_id, github_username, username, username_normalized, password_hash, password_updated_at, role, enabled, created_at, updated_at, access_email)
SELECT id, github_user_id, github_username, username, username_normalized, password_hash, password_updated_at, role, enabled, created_at, updated_at, access_email FROM admins;

CREATE TABLE admin_sessions_new (
  token_hash TEXT NOT NULL PRIMARY KEY
    CHECK (length(token_hash) = 64),
  admin_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (admin_id) REFERENCES admins_new(id) ON DELETE CASCADE
) STRICT;

INSERT INTO admin_sessions_new (token_hash, admin_id, expires_at, created_at)
SELECT token_hash, admin_id, expires_at, created_at
FROM admin_sessions;

CREATE TABLE audit_logs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  submission_id INTEGER,
  metadata TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (admin_id) REFERENCES admins_new(id) ON DELETE RESTRICT,
  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE SET NULL
) STRICT;

INSERT INTO audit_logs_new (
  id,
  admin_id,
  action,
  submission_id,
  metadata,
  created_at
)
SELECT id, admin_id, action, submission_id, metadata, created_at
FROM audit_logs;

DROP TABLE admin_sessions;
DROP TABLE audit_logs;
DROP TABLE admins;

ALTER TABLE admins_new RENAME TO admins;
ALTER TABLE admin_sessions_new RENAME TO admin_sessions;
ALTER TABLE audit_logs_new RENAME TO audit_logs;

CREATE UNIQUE INDEX idx_admins_username_normalized
ON admins(username_normalized)
WHERE username_normalized IS NOT NULL;

CREATE INDEX idx_admin_sessions_admin_id
ON admin_sessions(admin_id);

CREATE INDEX idx_admin_sessions_expires_at
ON admin_sessions(expires_at);

CREATE INDEX idx_audit_logs_admin_created_at
ON audit_logs(admin_id, created_at, id);

CREATE INDEX idx_audit_logs_submission_id
ON audit_logs(submission_id);

CREATE TRIGGER prevent_disable_last_enabled_owner
BEFORE UPDATE OF enabled ON admins
WHEN OLD.role = 'owner'
  AND OLD.enabled = 1
  AND NEW.enabled = 0
  AND (SELECT COUNT(*) FROM admins WHERE role = 'owner' AND enabled = 1) <= 1
BEGIN
  SELECT RAISE(ABORT, 'LAST_ENABLED_OWNER');
END;

CREATE TRIGGER prevent_demote_last_enabled_owner
BEFORE UPDATE OF role ON admins
WHEN OLD.role = 'owner'
  AND OLD.enabled = 1
  AND NEW.role != 'owner'
  AND (SELECT COUNT(*) FROM admins WHERE role = 'owner' AND enabled = 1) <= 1
BEGIN
  SELECT RAISE(ABORT, 'LAST_ENABLED_OWNER');
END;

CREATE TRIGGER prevent_delete_last_enabled_owner
BEFORE DELETE ON admins
WHEN OLD.role = 'owner'
  AND OLD.enabled = 1
  AND (SELECT COUNT(*) FROM admins WHERE role = 'owner' AND enabled = 1) <= 1
BEGIN
  SELECT RAISE(ABORT, 'LAST_ENABLED_OWNER');
END;

CREATE UNIQUE INDEX idx_admins_access_email_normalized
ON admins(access_email_normalized) WHERE access_email_normalized IS NOT NULL;

UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT old.seq FROM migration_0006_sequences AS old WHERE old.name=sqlite_sequence.name),0))
WHERE name IN ('admins','audit_logs');
INSERT INTO sqlite_sequence(name,seq)
SELECT old.name,old.seq FROM migration_0006_sequences AS old
WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name=old.name);
DROP TABLE migration_0006_sequences;
