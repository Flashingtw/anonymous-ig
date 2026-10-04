import {HttpError} from '../errors.js';
import {prepareAuditLog} from './audit-logs.js';
import {instagramService,publishInstagramPost,InstagramError} from '../services/instagram.js';
const q=(db,sql,...args)=>db.prepare(sql).bind(...args);
const check=db=>q(db,'INSERT INTO send_assertion SELECT CASE WHEN changes()=1 THEN 1 ELSE 0 END');
const fail=()=>{throw new HttpError(409,'IG_QUEUE_CONFLICT','整包狀態已變更、圖片不完整或部分已發送，請重新載入。');};
const audit=(db,action,id,adminId=null)=>prepareAuditLog(db,{adminId,action,metadata:{batchId:id}});
export const igEnabled=env=>env.IG_PUBLISH_ENABLED==='true';
export async function listInstagram(db){
 return (await db.prepare(`SELECT b.id batch_id,b.auto_publish,coalesce(q.publish_status,'none') publish_status,q.publish_at,q.published_at,q.instagram_media_id,q.publish_attempts,q.publish_error,q.revision,q.uncertain,
 coalesce(q.item_count,(SELECT count(*) FROM send_items WHERE batch_id=b.id)) item_count,
 coalesce(q.first_number,(SELECT min(number) FROM send_items WHERE batch_id=b.id)) first_number,
 coalesce(q.last_number,(SELECT max(number) FROM send_items WHERE batch_id=b.id)) last_number
 FROM send_batches b LEFT JOIN instagram_queue q ON q.batch_id=b.id
 WHERE b.state='prepared' OR q.publish_status IN ('pending','publishing','failed','published') ORDER BY b.created_at DESC LIMIT 100`).all()).results;
}
export async function stageInstagramImage(db,{id,generation,position,key}){
 const uploadId=crypto.randomUUID();
 const r=await q(db,`INSERT INTO instagram_uploads(id,batch_id,generation,position,source_png_key,object_key)
 SELECT ?,b.id,b.generation,i.position,i.object_key,? FROM send_batches b JOIN send_items i ON i.batch_id=b.id
 WHERE b.id=? AND b.state='prepared' AND b.generation=? AND i.position=? AND i.confirmed=0 AND i.object_key IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM instagram_queue WHERE batch_id=b.id AND publish_status<>'none')`,uploadId,key,id,generation,position).run();
 if(r.meta.changes!==1)fail();return uploadId;
}
export async function scheduleInstagram(db,{id,revision,generation,publishAt,uploads},principal){
 const batch=await q(db,'SELECT * FROM send_batches WHERE id=?',id).first();
 if(batch?.auto_publish)publishAt=batch.publish_at;
 if(typeof publishAt!=='string'||!Number.isSafeInteger(revision)||revision<1||!Array.isArray(uploads)||uploads.length<1||uploads.length>10||new Set(uploads).size!==uploads.length||uploads.some(x=>typeof x!=='string'))throw new HttpError(400,'INVALID_SCHEDULE','需要完整的 1–10 張圖片與有效修訂。');
 const time=new Date(publishAt);if(!Number.isFinite(time.getTime()))throw new HttpError(400,'INVALID_TIME','請選擇有效時間。');
 const marks=uploads.map(()=>'?').join(',');
 try{await db.batch([
  q(db,'UPDATE send_progress SET revision=revision+1 WHERE id=1 AND revision=?',revision),check(db),
  q(db,"DELETE FROM instagram_items WHERE batch_id=? AND EXISTS(SELECT 1 FROM instagram_queue WHERE batch_id=? AND publish_status='none')",id,id),
  q(db,`INSERT INTO instagram_queue(batch_id,generation,first_number,last_number,item_count,publish_status,publish_at,published_caption,editor_id)
   SELECT b.id,b.generation,min(i.number),max(i.number),count(*),'pending',?,b.caption,? FROM send_batches b JOIN send_items i ON i.batch_id=b.id JOIN submissions s ON s.id=i.submission_id
   WHERE b.id=? AND b.state='prepared' AND b.generation=? GROUP BY b.id
   HAVING count(*)=? AND sum(i.confirmed)=0 AND count(i.object_key)=count(*) AND sum(s.status='approved')=count(*)
   AND min(i.number)>=(SELECT last_number+1 FROM send_progress WHERE id=1) AND max(i.number)=min(i.number)+count(*)-1
   AND (SELECT count(*) FROM instagram_uploads u JOIN send_items x ON x.batch_id=u.batch_id AND x.position=u.position AND x.object_key=u.source_png_key WHERE u.batch_id=b.id AND u.generation=b.generation AND u.id IN (${marks}))=count(*)
   AND (SELECT count(DISTINCT position) FROM instagram_uploads WHERE id IN (${marks}))=count(*)
   ON CONFLICT(batch_id) DO UPDATE SET generation=excluded.generation,first_number=excluded.first_number,last_number=excluded.last_number,item_count=excluded.item_count,publish_status='pending',publish_at=excluded.publish_at,published_caption=excluded.published_caption,editor_id=excluded.editor_id,revision=instagram_queue.revision+1,publish_attempts=0,publish_error=NULL,creation_id=NULL,publish_started=0,uncertain=0,image_expires_at=NULL
   WHERE instagram_queue.publish_status='none'`,time.toISOString(),principal.adminId??null,id,generation,uploads.length,...uploads,...uploads),check(db),
  ...uploads.map(upload=>q(db,`INSERT INTO instagram_items(batch_id,position,submission_id,number,published_image_key,source_png_key,image_token)
   SELECT u.batch_id,u.position,i.submission_id,i.number,u.object_key,u.source_png_key,? FROM instagram_uploads u JOIN send_items i ON i.batch_id=u.batch_id AND i.position=u.position WHERE u.id=?`,crypto.randomUUID(),upload)),
  q(db,`DELETE FROM send_uploads WHERE object_key IN (SELECT object_key FROM instagram_uploads WHERE id IN (${marks}))`,...uploads),
  audit(db,'ig_scheduled',id,principal.adminId??null),db.prepare('DELETE FROM send_assertion')
 ]);}catch(error){if(/constraint|INSTAGRAM_/.test(error.message))fail();throw error;}
}
export async function editInstagram(db,id,command,revision,principal,now=new Date()){
 const batch=await q(db,'SELECT * FROM send_batches WHERE id=?',id).first();
 if(batch?.auto_publish&&command!=='retry-publish')throw new HttpError(409,'AUTOMATIC_BATCH_LOCKED','已鎖定自動發布，不能取消或變更排程。');
 const row=await q(db,'SELECT * FROM instagram_queue WHERE batch_id=?',id).first();
 if(!row||row.revision!==revision||row.uncertain||row.publish_started||!['pending','failed'].includes(row.publish_status))fail();
 if(command==='retry-publish'&&row.publish_status!=='failed')fail();
 await db.batch([
  q(db,`UPDATE instagram_queue SET publish_status=?,publish_at=?,publish_error=NULL,publish_attempts=0,revision=revision+1 WHERE batch_id=? AND revision=? AND publish_status IN ('pending','failed') AND publish_started=0 AND uncertain=0`,command==='cancel-publish'?'none':'pending',now.toISOString(),id,revision),check(db),
  ...(command==='retry-publish'?[q(db,'UPDATE instagram_queue SET creation_id=NULL WHERE batch_id=?',id),q(db,'UPDATE instagram_items SET creation_id=NULL WHERE batch_id=?',id)]:[]),
  ...(command==='cancel-publish'?[q(db,"INSERT OR IGNORE INTO send_uploads SELECT published_image_key,strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day') FROM instagram_items WHERE batch_id=?",id)]:[]),
  audit(db,command==='cancel-publish'?'ig_cancelled':'ig_retry',id,principal.adminId??null),db.prepare('DELETE FROM send_assertion')
 ]);
}
async function finish(db,row,now){
 const items=(await q(db,'SELECT * FROM instagram_items WHERE batch_id=? ORDER BY position',row.batch_id).all()).results;
 if(items.length!==row.item_count)fail();
 await db.batch([
  q(db,"UPDATE instagram_queue SET publish_status='published',published_at=?,lease_token=NULL,lease_until=NULL,publish_error=NULL,revision=revision+1 WHERE batch_id=? AND lease_token=? AND publish_status='publishing' AND instagram_media_id IS NOT NULL",now,row.batch_id,row.lease_token),check(db),
  q(db,'UPDATE send_progress SET last_number=?,revision=revision+1 WHERE id=1 AND last_number=?',row.last_number,row.first_number-1),check(db),
  ...items.flatMap(item=>[
   q(db,'UPDATE send_items SET confirmed=1 WHERE batch_id=? AND position=? AND number=? AND confirmed=0',row.batch_id,item.position,item.number),check(db),
   q(db,"INSERT INTO send_records(number,submission_id,batch_id,position,confirmer_id,confirmed_at,expires_at) VALUES(?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ',?,'+7 days'))",item.number,item.submission_id,row.batch_id,item.position,row.editor_id,now,now),
   q(db,'INSERT INTO send_cleanup(submission_id,due_at) SELECT submission_id,expires_at FROM send_records WHERE submission_id=?',item.submission_id),
   q(db,"INSERT OR IGNORE INTO send_uploads VALUES(?,strftime('%Y-%m-%dT%H:%M:%fZ',?,'+7 days'))",item.published_image_key,now)
  ]),
  q(db,"UPDATE send_batches SET state='completed' WHERE id=?",row.batch_id),check(db),
  audit(db,'ig_published',row.batch_id,row.editor_id),db.prepare('DELETE FROM send_assertion')
 ]);
}
export async function processInstagramQueue(env,{now=new Date(),service,onlyId}={}){
 if(!igEnabled(env))return {status:'disabled'};
 const db=env.DB,iso=now.toISOString(),lease=crypto.randomUUID(),until=new Date(now.getTime()+10*60000).toISOString();
 let row=await q(db,`UPDATE instagram_queue SET lease_token=?,lease_until=?,revision=revision+1 WHERE batch_id=(SELECT batch_id FROM instagram_queue WHERE publish_status='publishing' AND lease_until<=? LIMIT 1) RETURNING *`,lease,until,iso).first();
 if(!row)row=await q(db,`UPDATE instagram_queue SET publish_status='publishing',lease_token=?,lease_until=?,revision=revision+1 WHERE batch_id=(SELECT batch_id FROM instagram_queue WHERE publish_status='pending' AND publish_at<=? AND first_number=(SELECT last_number+1 FROM send_progress WHERE id=1) ORDER BY publish_at,batch_id LIMIT 1)
  AND (? IS NULL OR batch_id=?) AND first_number=(SELECT last_number+1 FROM send_progress WHERE id=1) AND NOT EXISTS(SELECT 1 FROM instagram_queue WHERE publish_status='publishing') RETURNING *`,lease,until,iso,onlyId??null,onlyId??null).first();
 if(!row)return {status:'idle'};
 const save=async(sql,...args)=>{const r=await q(db,sql,...args,row.batch_id,lease).run();if(r.meta.changes!==1)throw Error('Lease lost');};
 if(row.instagram_media_id){await finish(db,row,iso);return {status:'published'};}
 try{
  if(row.publish_started)throw new InstagramError('發布結果不明，請核對 Instagram；已停止自動重送。',{ambiguous:true});
  const origin=new URL(env.IG_MEDIA_ORIGIN);if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)throw new InstagramError('IG_MEDIA_ORIGIN 必須是公開 HTTPS origin。');
  await save('UPDATE instagram_queue SET image_expires_at=? WHERE batch_id=? AND lease_token=?',new Date(now.getTime()+24*3600000).toISOString());
  const images=(await q(db,'SELECT * FROM instagram_items WHERE batch_id=? ORDER BY position',row.batch_id).all()).results.map(i=>({...i,imageUrl:`${origin.origin}/api/instagram-media/${i.image_token}.jpg`}));
  if(images.length!==row.item_count)throw new InstagramError('整包圖片不完整。');
  const mediaId=await publishInstagramPost({images,caption:row.published_caption,creationId:row.creation_id,
   onChildCreated:async(position,id)=>{const r=await q(db,'UPDATE instagram_items SET creation_id=? WHERE position=? AND batch_id=? AND EXISTS(SELECT 1 FROM instagram_queue WHERE batch_id=? AND lease_token=?)',id,position,row.batch_id,row.batch_id,lease).run();if(r.meta.changes!==1)throw Error('Lease lost');},
   onCreated:async id=>{await save('UPDATE instagram_queue SET creation_id=? WHERE batch_id=? AND lease_token=?',id);},
   onPublishing:async()=>{await save('UPDATE instagram_queue SET publish_started=1 WHERE batch_id=? AND lease_token=?');row.publish_started=1;}
  },service??instagramService(env));
  await save('UPDATE instagram_queue SET instagram_media_id=? WHERE batch_id=? AND lease_token=?',mediaId);
  row.instagram_media_id=mediaId;await finish(db,row,iso);return {status:'published'};
 }catch(error){
  if(row.instagram_media_id)throw Error('IG receipt saved; ledger recovery pending');
  const uncertain=Boolean(error.ambiguous||(row.publish_started&&!(error instanceof InstagramError))),attempt=row.publish_attempts+1;
  const message=uncertain?'發布結果不明，請人工核對 Instagram；禁止直接重試。':error instanceof InstagramError?error.message:'發文服務暫時無法使用。';
  await db.batch([
   q(db,`UPDATE instagram_queue SET publish_status=?,publish_attempts=?,publish_error=?,publish_at=?,uncertain=?,publish_started=?,lease_token=NULL,lease_until=NULL,revision=revision+1 WHERE batch_id=? AND lease_token=?`,uncertain||attempt>=3?'failed':'pending',attempt,message,new Date(now.getTime()+(attempt===1?5:15)*60000).toISOString(),Number(uncertain),Number(uncertain),row.batch_id,lease),check(db),
   audit(db,'ig_failed',row.batch_id),db.prepare('DELETE FROM send_assertion')
  ]);return {status:uncertain||attempt>=3?'failed':'pending'};
 }
}
