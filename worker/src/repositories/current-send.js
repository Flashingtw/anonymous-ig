import {HttpError} from '../errors.js';
import {prepareAuditLog} from './audit-logs.js';
import {validItems} from '../../../frontend/admin/studio/model.js';
import {graphemeLength} from '../../../frontend/assets/graphemes.js';
import {customCaption,scheduledCaption} from '../../../frontend/admin/studio/caption.js';
const fail=(message,status=409)=>{throw new HttpError(status,'SEND_CONFLICT',message);};
const stmt=(db,sql,...args)=>db.prepare(sql).bind(...args);
const assert=(db,sql,...args)=>stmt(db,`INSERT INTO send_assertion SELECT CASE WHEN (${sql}) THEN 1 ELSE 0 END`,...args);
export async function currentSend(db,batchId){
 const progress=await db.prepare('SELECT last_number,revision FROM send_progress WHERE id=1').first();
 const batches=(await db.prepare("SELECT * FROM send_batches WHERE state IN ('editing','prepared') ORDER BY created_at,id").all()).results;
 for(const batch of batches){batch.items=(await stmt(db,'SELECT * FROM send_items WHERE batch_id=? ORDER BY position',batch.id).all()).results.map(i=>({...i,layout:i.layout?JSON.parse(i.layout):null}));
  if(batch.state==='editing')for(const item of batch.items){const latest=await stmt(db,'SELECT id,text,layout FROM image_versions WHERE draft_id=? ORDER BY draft_revision DESC LIMIT 1',item.submission_id).first();if(latest){item.latest_version_id=latest.id;item.latest_document={text:latest.text,layout:JSON.parse(latest.layout)};}}
 }
 const batch=batchId===null?null:batchId===undefined?(batches.find(b=>b.state==='prepared')??batches[0]??null):(batches.find(b=>b.id===batchId)??null);
 const next_number=Math.max(progress.last_number,...batches.flatMap(b=>b.state==='prepared'?b.items.map(i=>i.number??0):[]))+1;
 // Keep 0008-era local/compatibility fixtures readable. Batch rows retain the
 // original schedule even when queue retry backoff changes its publish_at.
 const scheduled=(await db.prepare("SELECT b.* FROM send_batches b WHERE state IN ('prepared','completed') ORDER BY (SELECT MAX(number) FROM send_items WHERE batch_id=b.id) DESC").all()).results;
 const last_publish_at=scheduled.find(b=>b.auto_publish&&b.publish_at)?.publish_at??null;
 return {...progress,next_number,batch,batches,last_publish_at};
}
async function commit(db,revision,principal,action,statements,metadata={}){
 if(!Number.isSafeInteger(revision)||revision<1)fail('請重新載入本次發送。');
 try{
 await db.batch([
  stmt(db,'UPDATE send_progress SET revision=revision+1 WHERE id=1 AND revision=?',revision),
  assert(db,'changes()=1'),
  ...statements,
  prepareAuditLog(db,{adminId:principal.adminId??null,action,metadata}),
  db.prepare('DELETE FROM send_assertion')
 ]);
 }catch(error){if(/AUTOMATIC_BATCH_LOCKED/.test(error.message))fail('此批次已鎖定自動發布，不能取消或修改。');if(/INSTAGRAM_QUEUE_LOCKED/.test(error.message))fail('圖片已加入 IG 排程，不能手動修改。');if(/CHECK constraint failed|UNIQUE constraint failed|STUDIO_REMOVAL_CONFLICT|SEND_ITEM_RESERVED/.test(error.message))fail('批次已更新、圖片已在其他批次，或另一包已鎖定編號，請重新載入。');throw error;}
 return currentSend(db,metadata.batchId??undefined);
}
export async function changeSend(db,command,body,principal){
 if(body.batchId!==undefined&&body.batchId!==null&&(typeof body.batchId!=='string'||body.batchId.length>100))fail('批次 ID 無效。',400);
 const state=await currentSend(db,body.batchId),b=state.batch,rev=body.revision;
 if(body.batchId===undefined&&state.batches.length>1)fail('請指定要操作的批次。');
 if(body.batchId!=null&&!b)fail('此批次已完成或取消，請重新載入。');
 let targetId=b?.id;
 if(rev!==state.revision)fail('畫面已過期，請重新載入；未覆蓋其他管理員的操作。');
 const statements=[];
 if(command==='save'){
  if(b&&b.state!=='editing')fail('已鎖定，請先取消準備。');
  if(!validItems(body.items)||typeof body.caption!=='string'||graphemeLength(body.caption)>2000)fail('選取 1–10 張不重複圖片，說明最多 2000 字。',400);
  const id=b?.id??crypto.randomUUID();
  targetId=id;
  statements.push(b?stmt(db,'UPDATE send_batches SET caption=?,editor_id=? WHERE id=?',body.caption,principal.adminId??null,id):stmt(db,"INSERT INTO send_batches(id,state,caption,editor_id) VALUES(?,'editing',?,?)",id,body.caption,principal.adminId??null));
  statements.push(stmt(db,'DELETE FROM send_items WHERE batch_id=?',id));
  for(const [position,version]of body.items.entries()){
   statements.push(assert(db,"EXISTS(SELECT 1 FROM image_versions v JOIN image_drafts d ON d.id=v.draft_id WHERE v.id=? AND d.state='ready' AND NOT EXISTS(SELECT 1 FROM send_records r WHERE r.submission_id=v.draft_id))",version));
   statements.push(stmt(db,'INSERT INTO send_items(batch_id,position,submission_id,version_id,text,layout) SELECT ?,?,draft_id,id,text,layout FROM image_versions WHERE id=?',id,position,version));
  }
 }else{
  if(!b)fail('目前沒有本次發送。');
  if(command==='prepare'){
   const automatic=body.publishAt!==undefined;
   if(state.batches.some(other=>other.id!==b.id&&other.state==='prepared'&&(!automatic||!other.auto_publish)))fail('請先完成既有手動批次，再鎖定自動發布批次。');
   if(b.state!=='editing')fail('已準備，請重新載入並重試產圖。');
   const generation=crypto.randomUUID();
   if(automatic){
    const time=typeof body.publishAt==='string'?new Date(body.publishAt):new Date(NaN);
    if(!Number.isFinite(time.getTime()))fail('請選擇有效發布時間。',400);
    const caption=scheduledCaption(customCaption(b.caption),b.items.map((_,i)=>state.next_number+i),time);
    if(graphemeLength(caption)>2000)fail('自訂文字加上模板後，貼文說明最多 2000 字。',400);
    statements.push(stmt(db,'UPDATE send_items SET number=?+position WHERE batch_id=?',state.next_number,b.id));
    statements.push(stmt(db,"UPDATE send_batches SET state='prepared',generation=?,auto_publish=1,publish_at=?,caption=? WHERE id=?",generation,time.toISOString(),caption,b.id));
    statements.push(stmt(db,`INSERT INTO instagram_queue(batch_id,generation,first_number,last_number,item_count,publish_status,publish_at,published_caption,editor_id) VALUES(?,?,?,?,?,'none',?,?,?)`,b.id,generation,state.next_number,state.next_number+b.items.length-1,b.items.length,time.toISOString(),caption,principal.adminId??null));
   }else{
    statements.push(stmt(db,"UPDATE send_batches SET state='prepared',generation=? WHERE id=?",generation,b.id));
    statements.push(stmt(db,'UPDATE send_items SET number=(SELECT last_number+1 FROM send_progress WHERE id=1)+position WHERE batch_id=?',b.id));
   }
  }else if(command==='reset'||command==='cancel'){
   if(b.auto_publish)fail('已鎖定自動發布，不能取消或重排；產圖失敗可重新開啟後繼續。');
   if(command==='reset'&&(b.state!=='prepared'||b.items.some(i=>i.confirmed)))fail('部分已確認後不可重新編排，只能繼續或取消剩餘項目。');
   for(const item of b.items.filter(i=>!i.confirmed&&i.object_key))statements.push(stmt(db,"INSERT OR IGNORE INTO send_uploads VALUES(?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'))",item.object_key));
   statements.push(stmt(db,'UPDATE send_items SET object_key=NULL,number=NULL WHERE batch_id=? AND confirmed=0',b.id));
   statements.push(stmt(db,'UPDATE send_batches SET state=?,generation=NULL WHERE id=?',command==='reset'?'editing':'cancelled',b.id));
  }else if(command==='confirm'){
   if(b.auto_publish)fail('此批次只能由 Instagram 發布成功後確認，不能人工推進編號。');
   const remaining=b.items.filter(i=>!i.confirmed),n=body.count;
   if(b.state!=='prepared'||remaining.some(i=>!i.object_key)||!Number.isInteger(n)||n<1||n>remaining.length)fail('只能確認已完成產圖的前 N 張。',400);
   if(remaining[0].number!==state.last_number+1)fail('編號不連續，請停止並核對。');
   for(const item of remaining.slice(0,n)){
    statements.push(stmt(db,"INSERT INTO send_records(number,submission_id,batch_id,position,confirmer_id,confirmed_at,expires_at) VALUES(?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now','+7 days'))",item.number,item.submission_id,b.id,item.position,principal.adminId??null));
    statements.push(stmt(db,'UPDATE send_items SET confirmed=1 WHERE batch_id=? AND position=?',b.id,item.position));
    statements.push(stmt(db,'INSERT INTO send_cleanup(submission_id,due_at) SELECT submission_id,expires_at FROM send_records WHERE number=?',item.number));
   }
   statements.push(stmt(db,'UPDATE send_progress SET last_number=? WHERE id=1',remaining[n-1].number));
   if(n===remaining.length)statements.push(stmt(db,"UPDATE send_batches SET state='completed' WHERE id=?",b.id));
  }else fail('未知操作。',400);
 }
 return commit(db,rev,principal,'send_'+command,statements,{batchId:targetId??null,count:body.count??null,manualConfirmation:command==='confirm'});
}
export async function increaseLastNumber(db,{revision,lastNumber},principal){
 if(principal.role!=='owner')throw new HttpError(403,'FORBIDDEN','只有 owner 可以調整最後編號。');
 if(!Number.isSafeInteger(lastNumber)||lastNumber<1||lastNumber>1000000000)throw new HttpError(400,'INVALID_NUMBER','請輸入 1–1000000000 的整數。');
 const state=await currentSend(db);
 if(state.batch)fail('請先完成或取消本次發送，再調整編號。');
 if(lastNumber<=state.last_number)fail('只能調高最後編號，不能相同或往下調整。',400);
 return commit(db,revision,principal,'send_number_adjust',[
  assert(db,"NOT EXISTS(SELECT 1 FROM send_batches WHERE state IN ('editing','prepared'))"),
  assert(db,"EXISTS(SELECT 1 FROM admins WHERE id=? AND role='owner' AND enabled=1)",principal.adminId),
  stmt(db,'UPDATE send_progress SET last_number=? WHERE id=1 AND last_number<?',lastNumber,lastNumber),
  assert(db,'changes()=1')
 ],{previousNumber:state.last_number,lastNumber,manualAdjustment:true});
}
export async function attachFinal(db,{revision,generation,position,key},principal){
 const state=await currentSend(db),b=state.batches.find(batch=>batch.generation===generation);
 if(!b||b.state!=='prepared'||b.generation!==generation||!b.items.some(i=>i.position===position&&!i.confirmed&&!i.object_key))fail('準備已取消或圖片已完成，請重新載入。');
 return commit(db,revision,principal,'send_image',[
  stmt(db,'UPDATE send_items SET object_key=? WHERE batch_id=? AND position=? AND object_key IS NULL AND confirmed=0',key,b.id,position),
  assert(db,'changes()=1'),stmt(db,'DELETE FROM send_uploads WHERE object_key=?',key)
 ],{batchId:b.id,position});
}
export async function sentRecords(db,before=Number.MAX_SAFE_INTEGER){return (await stmt(db,'SELECT r.*,a.access_email AS confirmer FROM send_records r LEFT JOIN admins a ON a.id=r.confirmer_id WHERE r.number<? ORDER BY number DESC LIMIT 100',before).all()).results;}
