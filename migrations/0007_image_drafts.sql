CREATE TABLE image_drafts (
  id INTEGER PRIMARY KEY REFERENCES submissions(id),
  text TEXT NOT NULL,
  layout TEXT NOT NULL CHECK(json_valid(layout)),
  template TEXT NOT NULL DEFAULT 'daan-paper-v1' CHECK(template = 'daan-paper-v1'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','ready')),
  operation TEXT,
  editor_id INTEGER REFERENCES admins(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE TABLE image_versions (
  id TEXT PRIMARY KEY,
  draft_id INTEGER NOT NULL REFERENCES image_drafts(id),
  draft_revision INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL,
  layout TEXT NOT NULL CHECK(json_valid(layout)),
  editor_id INTEGER REFERENCES admins(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(draft_id,draft_revision)
) STRICT;
CREATE TRIGGER image_versions_immutable_update BEFORE UPDATE ON image_versions BEGIN
  SELECT RAISE(ABORT, 'Image versions are immutable');
END;
CREATE TRIGGER image_versions_immutable_delete BEFORE DELETE ON image_versions BEGIN
  SELECT RAISE(ABORT, 'Image versions are immutable');
END;
CREATE TABLE dispatch_drafts (
  id TEXT PRIMARY KEY,
  caption TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  operation TEXT NOT NULL,
  editor_id INTEGER REFERENCES admins(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE TABLE dispatch_items (
  dispatch_id TEXT NOT NULL REFERENCES dispatch_drafts(id),
  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 9),
  version_id TEXT NOT NULL REFERENCES image_versions(id),
  PRIMARY KEY(dispatch_id,position),
  UNIQUE(dispatch_id,version_id)
) STRICT;
CREATE INDEX image_drafts_state ON image_drafts(state,updated_at);
CREATE INDEX image_versions_draft ON image_versions(draft_id,draft_revision DESC);
