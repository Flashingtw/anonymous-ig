-- Logical deletion only: retain submissions, image files, history and audit.
CREATE TABLE studio_removals (
 submission_id INTEGER PRIMARY KEY REFERENCES submissions(id),
 source TEXT NOT NULL CHECK(source IN ('approved','ready')),
 actor_id INTEGER REFERENCES admins(id),
 deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE TRIGGER studio_removal_guard BEFORE INSERT ON studio_removals WHEN
 NOT EXISTS(SELECT 1 FROM submissions WHERE id=NEW.submission_id AND status='approved') OR
 EXISTS(SELECT 1 FROM send_records WHERE submission_id=NEW.submission_id) OR
 EXISTS(SELECT 1 FROM send_items i JOIN send_batches b ON b.id=i.batch_id WHERE i.submission_id=NEW.submission_id AND b.state IN ('editing','prepared'))
 BEGIN SELECT RAISE(ABORT,'STUDIO_REMOVAL_CONFLICT'); END;
CREATE TRIGGER studio_removal_immutable_update BEFORE UPDATE ON studio_removals
 BEGIN SELECT RAISE(ABORT,'Removal records are immutable'); END;
CREATE TRIGGER studio_removal_immutable_delete BEFORE DELETE ON studio_removals
 BEGIN SELECT RAISE(ABORT,'Removal records are immutable'); END;
CREATE TRIGGER removed_draft_no_insert BEFORE INSERT ON image_drafts WHEN EXISTS(SELECT 1 FROM studio_removals WHERE submission_id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'STUDIO_REMOVAL_CONFLICT'); END;
CREATE TRIGGER removed_draft_no_update BEFORE UPDATE ON image_drafts WHEN EXISTS(SELECT 1 FROM studio_removals WHERE submission_id=OLD.id)
 BEGIN SELECT RAISE(ABORT,'STUDIO_REMOVAL_CONFLICT'); END;
CREATE TRIGGER removed_item_no_send BEFORE INSERT ON send_items WHEN EXISTS(SELECT 1 FROM studio_removals WHERE submission_id=NEW.submission_id)
 BEGIN SELECT RAISE(ABORT,'STUDIO_REMOVAL_CONFLICT'); END;
CREATE TRIGGER removed_item_no_legacy_send BEFORE INSERT ON dispatch_items WHEN EXISTS(SELECT 1 FROM studio_removals WHERE submission_id=NEW.submission_id)
 BEGIN SELECT RAISE(ABORT,'STUDIO_REMOVAL_CONFLICT'); END;
