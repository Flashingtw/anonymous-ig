import {HttpError} from '../errors.js';
import {editableCaption,scheduledCaption} from '../../../frontend/admin/studio/caption.js';
import {graphemeLength} from '../../../frontend/assets/graphemes.js';

const conflict=()=>new HttpError(409,'IG_CAPTION_CONFLICT','排程已更新或正在處理／發布，未保存內文。請重新載入後再確認。');
const allowed=row=>row&&row.state==='prepared'&&['pending','failed'].includes(row.publish_status)
 &&!row.publish_started&&!row.uncertain&&!row.instagram_media_id&&!row.lease_token&&!row.lease_until;
async function captionRow(db,id){
 return db.prepare('SELECT q.*,b.state FROM instagram_queue q JOIN send_batches b ON b.id=q.batch_id WHERE q.batch_id=?').bind(id).first();
}
export async function readInstagramCaption(db,id){
 const row=await captionRow(db,id);
 if(!allowed(row))throw conflict();
 return {batchId:id,revision:row.revision,caption:row.published_caption,...editableCaption(row.published_caption),
  publishAt:row.publish_at,numbers:Array.from({length:row.item_count},(_,i)=>row.first_number+i)};
}
export async function updateInstagramCaption(db,id,{revision,customText},principal){
 if(!['owner','admin','moderator'].includes(principal.role)||!principal.adminId)throw new HttpError(403,'FORBIDDEN','沒有修改內文的權限。');
 if(!Number.isSafeInteger(revision)||revision<1||typeof customText!=='string'||customText.length>24000)throw new HttpError(400,'INVALID_CAPTION','請提供有效修訂及自訂文字。');
 const row=await captionRow(db,id);
 if(!allowed(row)||row.revision!==revision)throw conflict();
 const numbers=Array.from({length:row.item_count},(_,i)=>row.first_number+i);
 const caption=scheduledCaption(customText,numbers,row.publish_at);
 if(graphemeLength(caption)>2000)throw new HttpError(400,'CAPTION_TOO_LONG','自訂文字加上模板後，貼文說明最多 2000 字。');
 // One insert is the transaction boundary. Schema guards recheck the revision,
 // enabled admin, publish intent and lease, then update both snapshots + audit.
 // No Meta call is made here; the next eligible Cron prepares fresh containers.
 try{
  await db.prepare('INSERT INTO instagram_caption_edits(id,batch_id,revision,before_caption,caption,editor_id) VALUES(?,?,?,?,?,?)')
   .bind(crypto.randomUUID(),id,revision+1,row.published_caption,caption,principal.adminId).run();
 }catch(error){
  if(/INSTAGRAM_CAPTION_CONFLICT|UNIQUE constraint/.test(error.message))throw conflict();
  throw error;
 }
 return {batchId:id,revision:revision+1,caption,publishStatus:row.publish_status};
}
