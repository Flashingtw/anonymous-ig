import {HttpError} from '../errors.js';
import {prepareAuditLog} from './audit-logs.js';
import {validItems} from '../../../frontend/admin/studio/model.js';
import {graphemeLength} from '../../../frontend/assets/graphemes.js';
const fail=(message,status=409)=>{throw new HttpError(status,'SEND_CONFLICT',message);};
const stmt=(db,sql,...args)=>db.prepare(sql).bind(...args);
const assert=(db,sql,...args)=>stmt(db,`INSERT INTO send_assertion SELECT CASE WHEN (${sql}) THEN 1 ELSE 0 END`,...args);
export async function currentSend(db){
 const progress=await db.prepare('SELECT last_number,revision FROM send_progress WHERE id=1').first();
 const batch=await db.prepare("SELECT * FROM send_batches WHERE state IN ('editing','prepared')").first();
 if(batch){batch.items=(await stmt(db,'SELECT * FROM send_items WHERE batch_id=? ORDER BY position',batch.id).all()).results.map(i=>({...i,layout:i.layout?JSON.parse(i.layout):null}));
  if(batch.state==='editing')for(const item of batch.items){const latest=await stmt(db,'SELECT id,text,layout FROM image_versions WHERE draft_id=? ORDER BY draft_revision DESC LIMIT 1',item.submission_id).first();if(latest){item.latest_version_id=latest.id;item.latest_document={text:latest.text,layout:JSON.parse(latest.layout)};}}
 }
 return {...progress,batch};
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
 }catch(error){if(/CHECK constraint failed|UNIQUE constraint failed/.test(error.message))fail('本次發送已更新或圖片不可用，請重新載入。');throw error;}
 return currentSend(db);
}
export async function changeSend(db,command,body,principal){
 const state=await currentSend(db),b=state.batch,rev=body.revision;
 if(rev!==state.revision)fail('畫面已過期，請重新載入；未覆蓋其他管理員的操作。');
 const statements=[];
 if(command==='save'){
  if(b&&b.state!=='editing')fail('已鎖定，請先取消準備。');
  if(!validItems(body.items)||typeof body.caption!=='string'||graphemeLength(body.caption)>2000)fail('選取 1–10 張不重複圖片，說明最多 2000 字。',400);
  const id=b?.id??crypto.randomUUID();
  statements.push(b?stmt(db,'UPDATE send_batches SET caption=?,editor_id=? WHERE id=?',body.caption,principal.adminId??null,id):stmt(db,"INSERT INTO send_batches(id,state,caption,editor_id) VALUES(?,'editing',?,?)",id,body.caption,principal.adminId??null));
  statements.push(stmt(db,'DELETE FROM send_items WHERE batch_id=?',id));
  for(const [position,version]of body.items.entries()){
   statements.push(assert(db,"EXISTS(SELECT 1 FROM image_versions v JOIN image_drafts d ON d.id=v.draft_id WHERE v.id=? AND d.state='ready' AND NOT EXISTS(SELECT 1 FROM send_records r WHERE r.submission_id=v.draft_id))",version));
   statements.push(stmt(db,'INSERT INTO send_items(batch_id,position,submission_id,version_id,text,layout) SELECT ?,?,draft_id,id,text,layout FROM image_versions WHERE id=?',id,position,version));
  }
 }else{
  if(!b)fail('目前沒有本次發送。');
  if(command==='prepare'){
   if(b.state!=='editing')fail('已準備，請重新載入並重試產圖。');
   statements.push(stmt(db,"UPDATE send_batches SET state='prepared',generation=? WHERE id=?",crypto.randomUUID(),b.id));
   statements.push(stmt(db,'UPDATE send_items SET number=(SELECT last_number+1 FROM send_progress WHERE id=1)+position WHERE batch_id=?',b.id));
  }else if(command==='reset'||command==='cancel'){
   if(command==='reset'&&(b.state!=='prepared'||b.items.some(i=>i.confirmed)))fail('部分已確認後不可重新編排，只能繼續或取消剩餘項目。');
   for(const item of b.items.filter(i=>!i.confirmed&&i.object_key))statements.push(stmt(db,"INSERT OR IGNORE INTO send_uploads VALUES(?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'))",item.object_key));
   statements.push(stmt(db,'UPDATE send_items SET object_key=NULL,number=NULL WHERE batch_id=? AND confirmed=0',b.id));
   statements.push(stmt(db,'UPDATE send_batches SET state=?,generation=NULL WHERE id=?',command==='reset'?'editing':'cancelled',b.id));
  }else if(command==='confirm'){
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
 return commit(db,rev,principal,'send_'+command,statements,{batchId:b?.id??null,count:body.count??null,manualConfirmation:command==='confirm'});
}
export async function attachFinal(db,{revision,generation,position,key},principal){
 const {batch:b}=await currentSend(db);
 if(!b||b.state!=='prepared'||b.generation!==generation||!b.items.some(i=>i.position===position&&!i.confirmed&&!i.object_key))fail('準備已取消或圖片已完成，請重新載入。');
 return commit(db,revision,principal,'send_image',[
  stmt(db,'UPDATE send_items SET object_key=? WHERE batch_id=? AND position=? AND object_key IS NULL AND confirmed=0',key,b.id,position),
  assert(db,'changes()=1'),stmt(db,'DELETE FROM send_uploads WHERE object_key=?',key)
 ],{batchId:b.id,position});
}
export async function sentRecords(db,before=Number.MAX_SAFE_INTEGER){return (await stmt(db,'SELECT r.*,a.access_email AS confirmer FROM send_records r LEFT JOIN admins a ON a.id=r.confirmer_id WHERE r.number<? ORDER BY number DESC LIMIT 100',before).all()).results;}
