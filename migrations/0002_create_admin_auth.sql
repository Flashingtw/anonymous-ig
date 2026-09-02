CREATE TABLE admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_user_id TEXT NOT NULL UNIQUE
    CHECK (
      github_user_id NOT GLOB '*[^0-9]*'
      AND length(github_user_id) BETWEEN 1 AND 32
    ),
  github_username TEXT NOT NULL
    CHECK (length(github_username) BETWEEN 1 AND 100),
  role TEXT NOT NULL DEFAULT 'moderator'
    CHECK (role IN ('owner', 'admin', 'moderator')),
  enabled INTEGER NOT NULL DEFAULT 1
    CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE admin_sessions (
  token_hash TEXT NOT NULL PRIMARY KEY
    CHECK (length(token_hash) = 64),
  admin_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_admin_sessions_admin_id
ON admin_sessions(admin_id);

CREATE INDEX idx_admin_sessions_expires_at
ON admin_sessions(expires_at);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  submission_id INTEGER,
  metadata TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE RESTRICT,
  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_audit_logs_admin_created_at
ON audit_logs(admin_id, created_at, id);

CREATE INDEX idx_audit_logs_submission_id
ON audit_logs(submission_id);

PRAGMA optimize;
