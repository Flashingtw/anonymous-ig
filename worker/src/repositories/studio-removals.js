import {HttpError} from '../errors.js';
import {prepareAuditLog} from './audit-logs.js';
export const hasRemovals=db=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='studio_removals'").first();
export const isRemoved=(db,id)=>db.prepare('SELECT 1 FROM studio_removals WHERE submission_id=?').bind(id).first();
export async function removeStudioItem(db,id,{source,revision},principal){
 if(!['approved','ready'].includes(source)||!Number.isSafeInteger(revision)||revision<0)throw new HttpError(400,'INVALID_REMOVAL','刪除資料錯誤，請重新整理。');
 let result;
 try{result=await db.batch([
  db.prepare(`INSERT INTO studio_removals(submission_id,source,actor_id)
   SELECT s.id,?,? FROM submissions s LEFT JOIN image_drafts d ON d.id=s.id
   WHERE s.id=? AND s.status='approved' AND COALESCE(d.revision,0)=?
   AND ((?='approved' AND (d.id IS NULL OR d.state='draft')) OR (?='ready' AND d.state='ready'))
   AND NOT EXISTS(SELECT 1 FROM studio_removals WHERE submission_id=s.id)
   RETURNING submission_id`).bind(source,principal.adminId??null,id,revision,source,source),
  prepareAuditLog(db,{adminId:principal.adminId??null,action:'studio_item_removed',submissionId:id,metadata:{source,logicalDeletion:true}},{onlyIfPreviousStatementChanged:true})
 ]);}catch(error){if(error.message.includes('STUDIO_REMOVAL_CONFLICT'))throw new HttpError(409,'STUDIO_ITEM_IN_USE','圖片已加入本次發送或已確認發送，不能刪除。請先取消未發送項目。');throw error;}
 if(!result[0].results.length)throw new HttpError(409,'STUDIO_REMOVAL_CONFLICT','項目已變更或已刪除，請重新整理。');
 return {id,removed:true};
}
