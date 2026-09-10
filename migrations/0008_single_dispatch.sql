-- Local only. Production rollout must verify the last real number before activation.
CREATE TABLE send_progress (id INTEGER PRIMARY KEY CHECK(id=1), last_number INTEGER NOT NULL CHECK(last_number>=108), revision INTEGER NOT NULL CHECK(revision>0)) STRICT;
INSERT INTO send_progress VALUES(1,108,1);
CREATE TABLE send_batches (
 id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('editing','prepared','completed','cancelled')),
 caption TEXT NOT NULL, generation TEXT, editor_id INTEGER REFERENCES admins(id),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE UNIQUE INDEX one_active_send ON send_batches((1)) WHERE state IN ('editing','prepared');
CREATE TABLE send_items (
 batch_id TEXT NOT NULL REFERENCES send_batches(id), position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 9),
 submission_id INTEGER NOT NULL REFERENCES submissions(id), version_id TEXT NOT NULL,
 text TEXT, layout TEXT CHECK(layout IS NULL OR json_valid(layout)), number INTEGER,
 object_key TEXT UNIQUE, confirmed INTEGER NOT NULL DEFAULT 0 CHECK(confirmed IN (0,1)),
 PRIMARY KEY(batch_id,position), UNIQUE(batch_id,submission_id)
) STRICT;
CREATE TABLE send_records (
 number INTEGER PRIMARY KEY, submission_id INTEGER NOT NULL UNIQUE REFERENCES submissions(id),
 batch_id TEXT NOT NULL REFERENCES send_batches(id), position INTEGER NOT NULL,
 confirmer_id INTEGER REFERENCES admins(id), confirmed_at TEXT NOT NULL,
 expires_at TEXT NOT NULL, purged_at TEXT, UNIQUE(batch_id,position)
) STRICT;
CREATE TABLE send_cleanup (
 submission_id INTEGER PRIMARY KEY REFERENCES submissions(id), due_at TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1))
) STRICT;
-- Unattached/cancelled upload attempts expire independently of sent images.
CREATE TABLE send_uploads (object_key TEXT PRIMARY KEY, due_at TEXT NOT NULL) STRICT;
CREATE TABLE send_assertion (ok INTEGER NOT NULL CHECK(ok=1)) STRICT;
-- Preserve historical ordering and submission identity even after PNG retirement.
ALTER TABLE dispatch_items RENAME TO dispatch_items_0007;
CREATE TABLE dispatch_items (
 dispatch_id TEXT NOT NULL REFERENCES dispatch_drafts(id), position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 9),
 version_id TEXT REFERENCES image_versions(id), submission_id INTEGER NOT NULL REFERENCES submissions(id),
 PRIMARY KEY(dispatch_id,position), UNIQUE(dispatch_id,version_id)
) STRICT;
INSERT INTO dispatch_items SELECT i.dispatch_id,i.position,i.version_id,v.draft_id FROM dispatch_items_0007 i JOIN image_versions v ON v.id=i.version_id;
DROP TABLE dispatch_items_0007;
DROP TRIGGER image_versions_immutable_delete;
CREATE TRIGGER image_versions_immutable_delete BEFORE DELETE ON image_versions
 WHEN NOT EXISTS(SELECT 1 FROM send_cleanup c JOIN send_records r USING(submission_id)
 WHERE c.submission_id=OLD.draft_id AND c.done=0 AND julianday(c.due_at)<=julianday('now')
 AND NOT EXISTS(SELECT 1 FROM send_items i JOIN send_batches b ON b.id=i.batch_id WHERE i.submission_id=OLD.draft_id AND i.confirmed=0 AND b.state IN ('editing','prepared')))
 BEGIN SELECT RAISE(ABORT,'Image versions are immutable outside eligible cleanup'); END;
CREATE TRIGGER sent_draft_no_insert BEFORE INSERT ON image_drafts WHEN EXISTS(SELECT 1 FROM send_records WHERE submission_id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'Already confirmed'); END;
CREATE TRIGGER locked_draft_no_update BEFORE UPDATE ON image_drafts WHEN
 EXISTS(SELECT 1 FROM send_records WHERE submission_id=OLD.id) OR
 EXISTS(SELECT 1 FROM send_items i JOIN send_batches b ON b.id=i.batch_id WHERE i.submission_id=OLD.id AND b.state='prepared')
 BEGIN SELECT RAISE(ABORT,'Image is locked or confirmed'); END;
