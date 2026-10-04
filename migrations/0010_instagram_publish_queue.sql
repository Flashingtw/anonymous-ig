-- One immutable send batch is one Instagram post. Disabled deployments never query this schema.
CREATE TABLE instagram_queue (
 batch_id TEXT PRIMARY KEY REFERENCES send_batches(id), generation TEXT NOT NULL,
 first_number INTEGER NOT NULL, last_number INTEGER NOT NULL,
 item_count INTEGER NOT NULL CHECK(item_count BETWEEN 1 AND 10),
 publish_status TEXT NOT NULL DEFAULT 'none' CHECK(publish_status IN ('none','pending','publishing','published','failed')),
 publish_at TEXT NOT NULL, instagram_media_id TEXT UNIQUE,
 publish_attempts INTEGER NOT NULL DEFAULT 0 CHECK(publish_attempts>=0),
 publish_error TEXT, published_at TEXT, published_caption TEXT NOT NULL, creation_id TEXT,
 publish_started INTEGER NOT NULL DEFAULT 0 CHECK(publish_started IN (0,1)),
 uncertain INTEGER NOT NULL DEFAULT 0 CHECK(uncertain IN (0,1)),
 lease_token TEXT, lease_until TEXT, image_expires_at TEXT,
 editor_id INTEGER REFERENCES admins(id), revision INTEGER NOT NULL DEFAULT 1,
 CHECK(last_number=first_number+item_count-1)
) STRICT;
CREATE TABLE instagram_items (
 batch_id TEXT NOT NULL REFERENCES instagram_queue(batch_id), position INTEGER NOT NULL,
 submission_id INTEGER NOT NULL REFERENCES submissions(id), number INTEGER NOT NULL,
 published_image_key TEXT NOT NULL UNIQUE, source_png_key TEXT NOT NULL,
 image_token TEXT NOT NULL UNIQUE, creation_id TEXT,
 PRIMARY KEY(batch_id,position), UNIQUE(batch_id,submission_id)
) STRICT;
CREATE TABLE instagram_uploads (
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES send_batches(id),
 generation TEXT NOT NULL, position INTEGER NOT NULL, source_png_key TEXT NOT NULL,
 object_key TEXT NOT NULL UNIQUE REFERENCES send_uploads(object_key) ON DELETE CASCADE
) STRICT;
CREATE INDEX instagram_due ON instagram_queue(publish_status,publish_at);
CREATE UNIQUE INDEX instagram_single_publisher ON instagram_queue((1)) WHERE publish_status='publishing';
CREATE TRIGGER instagram_locked_snapshot BEFORE UPDATE ON instagram_queue
 WHEN OLD.publish_status<>'none' AND (NEW.batch_id<>OLD.batch_id OR NEW.generation<>OLD.generation OR NEW.first_number<>OLD.first_number OR NEW.last_number<>OLD.last_number OR NEW.item_count<>OLD.item_count OR NEW.published_caption<>OLD.published_caption)
 BEGIN SELECT RAISE(ABORT,'INSTAGRAM_SNAPSHOT_LOCKED'); END;
CREATE TRIGGER instagram_locked_image BEFORE UPDATE ON instagram_items
 WHEN NEW.batch_id<>OLD.batch_id OR NEW.position<>OLD.position OR NEW.submission_id<>OLD.submission_id OR NEW.number<>OLD.number OR NEW.published_image_key<>OLD.published_image_key OR NEW.source_png_key<>OLD.source_png_key OR NEW.image_token<>OLD.image_token
 BEGIN SELECT RAISE(ABORT,'INSTAGRAM_SNAPSHOT_LOCKED'); END;
CREATE TRIGGER instagram_locked_image_delete BEFORE DELETE ON instagram_items
 WHEN EXISTS(SELECT 1 FROM instagram_queue WHERE batch_id=OLD.batch_id AND publish_status<>'none')
 BEGIN SELECT RAISE(ABORT,'INSTAGRAM_SNAPSHOT_LOCKED'); END;
CREATE TRIGGER instagram_lock_items BEFORE UPDATE ON send_items
 WHEN EXISTS(SELECT 1 FROM instagram_queue q WHERE q.batch_id=OLD.batch_id AND q.publish_status IN ('pending','publishing','failed'))
 BEGIN SELECT RAISE(ABORT,'INSTAGRAM_QUEUE_LOCKED'); END;
CREATE TRIGGER instagram_lock_batch BEFORE UPDATE ON send_batches
 WHEN EXISTS(SELECT 1 FROM instagram_queue q WHERE q.batch_id=OLD.id AND q.publish_status IN ('pending','publishing','failed'))
 BEGIN SELECT RAISE(ABORT,'INSTAGRAM_QUEUE_LOCKED'); END;
