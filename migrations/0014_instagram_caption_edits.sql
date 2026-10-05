-- Local-only additive edit history. Existing captions are not rewritten.
-- Inserting one authorized edit atomically replaces both caption snapshots,
-- invalidates unpublished containers, and writes the audit. Never unlock images.
CREATE TABLE instagram_caption_edits (
 id TEXT PRIMARY KEY,
 batch_id TEXT NOT NULL REFERENCES instagram_queue(batch_id),
 revision INTEGER NOT NULL CHECK(revision>1),
 before_caption TEXT NOT NULL,
 caption TEXT NOT NULL,
 editor_id INTEGER NOT NULL REFERENCES admins(id),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(batch_id,revision)
) STRICT;
CREATE TRIGGER instagram_caption_edit_guard BEFORE INSERT ON instagram_caption_edits
 WHEN NOT EXISTS (
 SELECT 1 FROM instagram_queue q JOIN send_batches b ON b.id=q.batch_id
 JOIN admins a ON a.id=NEW.editor_id
 WHERE q.batch_id=NEW.batch_id AND q.revision=NEW.revision-1
 AND q.published_caption=NEW.before_caption AND b.caption=NEW.before_caption
 AND q.publish_status IN ('pending','failed') AND b.state='prepared'
 AND q.publish_started=0 AND q.uncertain=0 AND q.instagram_media_id IS NULL
 AND q.lease_token IS NULL AND q.lease_until IS NULL
 AND a.enabled=1 AND a.role IN ('owner','admin','moderator')
 AND NOT EXISTS(SELECT 1 FROM send_items WHERE batch_id=q.batch_id AND confirmed<>0)
 )
 BEGIN SELECT RAISE(ABORT,'INSTAGRAM_CAPTION_CONFLICT'); END;
CREATE TRIGGER instagram_caption_edit_no_update BEFORE UPDATE ON instagram_caption_edits
 BEGIN SELECT RAISE(ABORT,'INSTAGRAM_CAPTION_HISTORY_LOCKED'); END;
CREATE TRIGGER instagram_caption_edit_no_delete BEFORE DELETE ON instagram_caption_edits
 BEGIN SELECT RAISE(ABORT,'INSTAGRAM_CAPTION_HISTORY_LOCKED'); END;

DROP TRIGGER instagram_locked_snapshot;
CREATE TRIGGER instagram_locked_snapshot BEFORE UPDATE ON instagram_queue
 WHEN OLD.publish_status<>'none' AND (
 NEW.batch_id<>OLD.batch_id OR NEW.generation<>OLD.generation OR NEW.first_number<>OLD.first_number
 OR NEW.last_number<>OLD.last_number OR NEW.item_count<>OLD.item_count
 OR (NEW.published_caption<>OLD.published_caption AND NOT EXISTS (
  SELECT 1 FROM instagram_caption_edits e WHERE e.batch_id=OLD.batch_id
  AND e.revision=OLD.revision+1 AND NEW.revision=e.revision
  AND e.before_caption=OLD.published_caption AND e.caption=NEW.published_caption
  AND OLD.publish_status IN ('pending','failed') AND NEW.publish_status=OLD.publish_status
  AND OLD.publish_started=0 AND OLD.uncertain=0 AND OLD.instagram_media_id IS NULL
  AND OLD.lease_token IS NULL AND NEW.lease_token IS NULL
  AND NEW.creation_id IS NULL AND NEW.preparation_status='none' AND NEW.prepared_at IS NULL
  AND NEW.publish_started=0 AND NEW.uncertain=0 AND NEW.instagram_media_id IS NULL
  AND NEW.publish_at=OLD.publish_at
 )))
 BEGIN SELECT RAISE(ABORT,'INSTAGRAM_SNAPSHOT_LOCKED'); END;

-- A caption-only batch update must match the just-applied queue revision.
CREATE VIEW instagram_caption_edit_applied AS
 SELECT e.batch_id,e.before_caption,e.caption FROM instagram_caption_edits e
 JOIN instagram_queue q ON q.batch_id=e.batch_id AND q.revision=e.revision
 WHERE q.published_caption=e.caption AND q.publish_status IN ('pending','failed')
 AND q.publish_started=0 AND q.uncertain=0 AND q.instagram_media_id IS NULL
 AND q.lease_token IS NULL AND q.creation_id IS NULL AND q.preparation_status='none';
DROP TRIGGER instagram_lock_batch;
CREATE TRIGGER instagram_lock_batch BEFORE UPDATE ON send_batches
 WHEN EXISTS(SELECT 1 FROM instagram_queue q WHERE q.batch_id=OLD.id AND q.publish_status IN ('pending','publishing','failed'))
 AND NOT (
  NEW.id=OLD.id AND NEW.state=OLD.state AND NEW.generation IS OLD.generation
  AND NEW.editor_id IS OLD.editor_id AND NEW.created_at=OLD.created_at
  AND NEW.auto_publish=OLD.auto_publish AND NEW.publish_at IS OLD.publish_at
  AND EXISTS(SELECT 1 FROM instagram_caption_edit_applied e WHERE e.batch_id=OLD.id AND e.before_caption=OLD.caption AND e.caption=NEW.caption)
 )
 BEGIN SELECT RAISE(ABORT,'INSTAGRAM_QUEUE_LOCKED'); END;
DROP TRIGGER automatic_batch_locked;
CREATE TRIGGER automatic_batch_locked BEFORE UPDATE ON send_batches
 WHEN OLD.auto_publish=1 AND (
 NEW.auto_publish<>1 OR NEW.generation IS NOT OLD.generation OR NEW.publish_at IS NOT OLD.publish_at
 OR NEW.state IN ('editing','cancelled')
 OR (NEW.caption<>OLD.caption AND NOT EXISTS(SELECT 1 FROM instagram_caption_edit_applied e WHERE e.batch_id=OLD.id AND e.before_caption=OLD.caption AND e.caption=NEW.caption))
 OR (NEW.state='completed' AND NOT EXISTS(SELECT 1 FROM instagram_queue WHERE batch_id=OLD.id AND publish_status='published'))
 )
 BEGIN SELECT RAISE(ABORT,'AUTOMATIC_BATCH_LOCKED'); END;

CREATE TRIGGER instagram_caption_edit_apply AFTER INSERT ON instagram_caption_edits
 BEGIN
 UPDATE instagram_queue SET published_caption=NEW.caption,revision=NEW.revision,
 creation_id=NULL,preparation_status='none',prepared_at=NULL,image_expires_at=NULL,
 publish_error=CASE WHEN publish_status='pending' THEN NULL ELSE publish_error END
 WHERE batch_id=NEW.batch_id;
 UPDATE instagram_items SET creation_id=NULL WHERE batch_id=NEW.batch_id;
 UPDATE send_batches SET caption=NEW.caption WHERE id=NEW.batch_id;
 UPDATE send_progress SET revision=revision+1 WHERE id=1;
 INSERT INTO audit_logs(admin_id,action,metadata) VALUES(NEW.editor_id,'ig_caption_updated',json_object('batchId',NEW.batch_id,'revision',NEW.revision));
 END;
