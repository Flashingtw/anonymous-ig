-- Multiple saved batches; only one can reserve final numbers at a time.
DROP INDEX one_active_send;
CREATE UNIQUE INDEX one_prepared_send ON send_batches((1)) WHERE state='prepared';
CREATE TRIGGER send_item_reserved BEFORE INSERT ON send_items
 WHEN EXISTS(SELECT 1 FROM send_items i JOIN send_batches b ON b.id=i.batch_id
 WHERE i.submission_id=NEW.submission_id AND i.batch_id<>NEW.batch_id AND b.state IN ('editing','prepared'))
 BEGIN SELECT RAISE(ABORT,'SEND_ITEM_RESERVED'); END;
