-- Opt-in for new locks only. Preserve existing manual batches for controlled transition.
ALTER TABLE send_batches ADD COLUMN auto_publish INTEGER NOT NULL DEFAULT 0 CHECK(auto_publish IN (0,1));
ALTER TABLE send_batches ADD COLUMN publish_at TEXT;
DROP INDEX one_prepared_send;
CREATE UNIQUE INDEX send_reserved_number ON send_items(number) WHERE number IS NOT NULL;
CREATE TRIGGER automatic_batch_locked BEFORE UPDATE ON send_batches
 WHEN OLD.auto_publish=1 AND (NEW.auto_publish<>1 OR NEW.caption<>OLD.caption OR NEW.generation IS NOT OLD.generation OR NEW.publish_at IS NOT OLD.publish_at OR NEW.state IN ('editing','cancelled') OR (NEW.state='completed' AND NOT EXISTS(SELECT 1 FROM instagram_queue WHERE batch_id=OLD.id AND publish_status='published')))
 BEGIN SELECT RAISE(ABORT,'AUTOMATIC_BATCH_LOCKED'); END;
CREATE TRIGGER automatic_batch_no_delete BEFORE DELETE ON send_batches WHEN OLD.auto_publish=1
 BEGIN SELECT RAISE(ABORT,'AUTOMATIC_BATCH_LOCKED'); END;
CREATE TRIGGER automatic_items_locked BEFORE UPDATE ON send_items
 WHEN EXISTS(SELECT 1 FROM send_batches WHERE id=OLD.batch_id AND auto_publish=1 AND state='prepared') AND (
 NEW.batch_id<>OLD.batch_id OR NEW.position<>OLD.position OR NEW.submission_id<>OLD.submission_id OR NEW.version_id<>OLD.version_id OR NEW.text IS NOT OLD.text OR NEW.layout IS NOT OLD.layout OR NEW.number IS NOT OLD.number OR
 (OLD.object_key IS NOT NULL AND NEW.object_key IS NOT OLD.object_key) OR
 (NEW.confirmed<>OLD.confirmed AND NOT EXISTS(SELECT 1 FROM instagram_queue WHERE batch_id=OLD.batch_id AND publish_status='published')))
 BEGIN SELECT RAISE(ABORT,'AUTOMATIC_BATCH_LOCKED'); END;
CREATE TRIGGER automatic_items_no_delete BEFORE DELETE ON send_items
 WHEN EXISTS(SELECT 1 FROM send_batches WHERE id=OLD.batch_id AND auto_publish=1 AND state='prepared')
 BEGIN SELECT RAISE(ABORT,'AUTOMATIC_BATCH_LOCKED'); END;
CREATE TRIGGER automatic_queue_no_cancel BEFORE UPDATE ON instagram_queue
 WHEN NEW.publish_status='none' AND OLD.publish_status<>'none' AND EXISTS(SELECT 1 FROM send_batches WHERE id=OLD.batch_id AND auto_publish=1)
 BEGIN SELECT RAISE(ABORT,'AUTOMATIC_BATCH_LOCKED'); END;
CREATE TRIGGER automatic_queue_no_delete BEFORE DELETE ON instagram_queue
 WHEN EXISTS(SELECT 1 FROM send_batches WHERE id=OLD.batch_id AND auto_publish=1)
 BEGIN SELECT RAISE(ABORT,'AUTOMATIC_BATCH_LOCKED'); END;
