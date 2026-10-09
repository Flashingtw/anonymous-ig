import {HttpError} from '../errors.js';
import {validDocument} from '../../../frontend/admin/studio/model.js';
const conflict=()=>{throw new HttpError(409,'SEND_LAYOUT_REPAIR_CONFLICT','圖片已完成或批次已更新／加入 IG 排程，請重新載入。');};
async function available(db){return Boolean(await db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='send_layout_repairs'").first());}
export async function applyLayoutRepairs(db,batches){
 // Old local fixtures/deployments remain readable before the additive migration.
 if(!await available(db))return;
 const rows=(await db.prepare(`SELECT i.batch_id,i.position,
 (SELECT r.layout FROM send_layout_repairs r WHERE r.batch_id=i.batch_id AND r.position=i.position ORDER BY r.revision DESC LIMIT 1) AS layout,
 EXISTS(SELECT 1 FROM send_repairable_items v WHERE v.batch_id=i.batch_id AND v.position=i.position) AS repairable
 FROM send_items i JOIN send_batches b ON b.id=i.batch_id WHERE b.state='prepared'`).all()).results;
 const lookup=new Map(rows.map(r=>[`${r.batch_id}:${r.position}`,r]));
 for(const batch of batches)for(const item of batch.items){const row=lookup.get(`${batch.id}:${item.position}`);item.can_repair_layout=Boolean(row?.repairable);if(row?.layout&&item.layout)item.layout=JSON.parse(row.layout);}
}
export async function repairLayout(db,body,principal){
 const {batchId,generation,position,revision,layout}=body;
 if(typeof batchId!=='string'||batchId.length>100||typeof generation!=='string'||generation.length>100||!Number.isInteger(position)||position<0||position>9||!Number.isSafeInteger(revision)||revision<1)throw new HttpError(400,'INVALID_REPAIR','修復資料無效。');
 if(!['owner','admin','moderator'].includes(principal.role))throw new HttpError(403,'FORBIDDEN','沒有修復權限。');
 // Geometry only: no text, number label, order, version or schedule accepted.
 if(!layout||Object.keys(layout).sort().join()!=='body,number'||!['body','number'].every(k=>layout[k]&&Object.keys(layout[k]).sort().join()==='size,x,y'))throw new HttpError(400,'INVALID_REPAIR','只能修改位置與字級。');
 if(!await available(db))throw new HttpError(503,'REPAIR_UNAVAILABLE','排版修復尚未啟用。');
 const item=await db.prepare(`SELECT i.layout,s.text FROM send_repairable_items i JOIN send_items s ON s.batch_id=i.batch_id AND s.position=i.position WHERE i.batch_id=? AND i.position=? AND i.generation=?`).bind(batchId,position,generation).first();
 if(!item)conflict();
 const candidate=structuredClone(layout),original=JSON.parse(item.layout);
 if(original.number.label!==undefined)candidate.number.label=original.number.label;
 if(!validDocument(item.text,candidate))throw new HttpError(400,'INVALID_REPAIR','字級或位置超出允許範圍。');
 try{await db.prepare('INSERT INTO send_layout_repairs(id,batch_id,position,generation,revision,before_layout,layout,editor_id) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),batchId,position,generation,revision+1,item.layout,JSON.stringify(candidate),principal.adminId??null).run();}
 catch(error){if(/SEND_LAYOUT_REPAIR_CONFLICT|UNIQUE constraint|NOT NULL constraint/.test(error.message))conflict();throw error;}
}
