// No public deletion endpoint. The scheduler is separately gated from the UI.
// R2 deletion is idempotent; a failed run retains the durable job for retry.
export async function cleanupSentImages(env){
 if(env.SEND_CLEANUP_ENABLED!=='true'||env.SINGLE_SEND_ENABLED!=='true'||!env.STUDIO_IMAGES)return;
 const db=env.DB;
 const orphans=await db.prepare("SELECT object_key FROM send_uploads WHERE julianday(due_at)<=julianday('now') LIMIT 20").all();
 for(const {object_key:key}of orphans.results){
  const live=await db.prepare('SELECT 1 FROM send_items WHERE object_key=? UNION SELECT 1 FROM image_versions WHERE object_key=?').bind(key,key).first();
  if(live)continue;
  try{await env.STUDIO_IMAGES.delete(key);await db.prepare('DELETE FROM send_uploads WHERE object_key=?').bind(key).run();}catch{/* retry next schedule */}
 }
 const jobs=await db.prepare("SELECT submission_id FROM send_cleanup WHERE done=0 AND julianday(due_at)<=julianday('now') LIMIT 10").all();
 for(const {submission_id:id}of jobs.results){
  const live=await db.prepare("SELECT 1 FROM send_items i JOIN send_batches b ON b.id=i.batch_id WHERE i.submission_id=? AND i.confirmed=0 AND b.state IN ('editing','prepared')").bind(id).first();
  if(live)continue;
  await db.prepare('UPDATE send_cleanup SET attempts=attempts+1 WHERE submission_id=?').bind(id).run();
  try{
   const keys=await db.prepare('SELECT object_key FROM image_versions WHERE draft_id=? UNION SELECT object_key FROM send_items WHERE submission_id=? AND object_key IS NOT NULL').bind(id,id).all();
   for(const row of keys.results)await env.STUDIO_IMAGES.delete(row.object_key);
   await db.batch([
    db.prepare('UPDATE dispatch_items SET version_id=NULL WHERE submission_id=?').bind(id),
    db.prepare('DELETE FROM image_versions WHERE draft_id=?').bind(id),
    db.prepare('DELETE FROM image_drafts WHERE id=?').bind(id),
    db.prepare('UPDATE send_items SET text=NULL,layout=NULL,object_key=NULL WHERE submission_id=?').bind(id),
    db.prepare("UPDATE send_records SET purged_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE submission_id=?").bind(id),
    db.prepare('UPDATE send_cleanup SET done=1 WHERE submission_id=?').bind(id)
   ]);
  }catch{/* Keep the job and ledger; no counter changes, including uncertain R2 results. */}
 }
}
