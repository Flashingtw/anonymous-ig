-- Additive, append-only geometry overrides for incomplete automatic batches.
-- Original image versions and locked snapshots are never updated or unlocked.
CREATE TABLE send_layout_repairs (
 id TEXT PRIMARY KEY,
 batch_id TEXT NOT NULL,
 position INTEGER NOT NULL,
 generation TEXT NOT NULL,
 revision INTEGER NOT NULL UNIQUE CHECK(revision>1),
 before_layout TEXT NOT NULL CHECK(json_valid(before_layout)),
 layout TEXT NOT NULL CHECK(json_valid(layout)),
 editor_id INTEGER NOT NULL REFERENCES admins(id),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 FOREIGN KEY(batch_id,position) REFERENCES send_items(batch_id,position)
) STRICT;
CREATE INDEX send_layout_repair_item ON send_layout_repairs(batch_id,position,revision DESC);
CREATE VIEW send_repairable_items AS
 SELECT i.batch_id,i.position,b.generation,
 COALESCE((SELECT r.layout FROM send_layout_repairs r WHERE r.batch_id=i.batch_id AND r.position=i.position ORDER BY r.revision DESC LIMIT 1),i.layout) AS layout
 FROM send_items i JOIN send_batches b ON b.id=i.batch_id JOIN instagram_queue q ON q.batch_id=b.id
 WHERE b.state='prepared' AND b.auto_publish=1 AND q.generation=b.generation
 AND i.confirmed=0 AND i.object_key IS NULL AND i.layout IS NOT NULL
 AND q.publish_status='none' AND q.publish_started=0 AND q.uncertain=0
 AND q.instagram_media_id IS NULL AND q.creation_id IS NULL
 AND q.lease_token IS NULL AND q.lease_until IS NULL
 AND NOT EXISTS(SELECT 1 FROM instagram_items WHERE batch_id=b.id)
 AND NOT EXISTS(SELECT 1 FROM instagram_uploads WHERE batch_id=b.id);
CREATE TRIGGER send_layout_repair_guard BEFORE INSERT ON send_layout_repairs
 WHEN NOT EXISTS (
 SELECT 1 FROM send_repairable_items i JOIN admins a ON a.id=NEW.editor_id
 JOIN send_progress p ON p.id=1
 WHERE i.batch_id=NEW.batch_id AND i.position=NEW.position AND i.generation=NEW.generation
 AND i.layout=NEW.before_layout AND p.revision=NEW.revision-1
 AND a.enabled=1 AND a.role IN ('owner','admin','moderator')
 )
 BEGIN SELECT RAISE(ABORT,'SEND_LAYOUT_REPAIR_CONFLICT'); END;
CREATE TRIGGER send_layout_repair_no_update BEFORE UPDATE ON send_layout_repairs
 BEGIN SELECT RAISE(ABORT,'SEND_LAYOUT_HISTORY_LOCKED'); END;
CREATE TRIGGER send_layout_repair_no_delete BEFORE DELETE ON send_layout_repairs
 BEGIN SELECT RAISE(ABORT,'SEND_LAYOUT_HISTORY_LOCKED'); END;
CREATE TRIGGER send_layout_repair_apply AFTER INSERT ON send_layout_repairs
 BEGIN
 UPDATE send_progress SET revision=NEW.revision WHERE id=1;
 INSERT INTO audit_logs(admin_id,action,metadata) VALUES(NEW.editor_id,'send_layout_repaired',json_object('batchId',NEW.batch_id,'position',NEW.position,'revision',NEW.revision));
 END;
