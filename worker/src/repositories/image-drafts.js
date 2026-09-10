import {prepareAuditLog} from './audit-logs.js';
import {defaultLayout} from '../../../frontend/admin/studio/model.js';
import {HttpError} from '../errors.js';
const layout=()=>JSON.stringify(defaultLayout());
const conflict=()=>new HttpError(409,'IMAGE_REVISION_CONFLICT','草稿已由其他人修改，請重新載入；你的修改尚未覆蓋。');
const audit=(db,principal,action,id,metadata={})=>prepareAuditLog(db,{adminId:principal.adminId??null,action,submissionId:id,metadata:{source:'image-studio',...metadata}},{onlyIfPreviousStatementChanged:true});
export async function approveWithImageDraft(db,id,principal){
  const result=await db.batch([
    db.prepare("UPDATE submissions SET status='approved',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='pending' RETURNING id,content,status,created_at,updated_at").bind(id),
    audit(db,principal,'approve_submission',id),
    db.prepare("INSERT INTO image_drafts(id,text,layout,editor_id) SELECT id,content,?,? FROM submissions WHERE id=? AND status='approved' AND changes()=1").bind(layout(),principal.adminId??null,id)
  ]);
  const row=result[0].results[0];
  if(!row)throw new HttpError(409,'SUBMISSION_ALREADY_REVIEWED','投稿不存在或已審核。');
  return {id:row.id,content:row.content,status:row.status,createdAt:row.created_at,updatedAt:row.updated_at};
}
export async function createImageDraft(db,id,principal){
  await db.batch([
    db.prepare("INSERT INTO image_drafts(id,text,layout,editor_id) SELECT id,content,?,? FROM submissions WHERE id=? AND status='approved' ON CONFLICT(id) DO NOTHING").bind(layout(),principal.adminId??null,id),
    audit(db,principal,'image_draft_created',id)
  ]);
  return getImageDraft(db,id);
}
export async function getImageDraft(db,id){
  const row=await db.prepare('SELECT * FROM image_drafts WHERE id=?').bind(id).first();
  if(!row)throw new HttpError(404,'IMAGE_DRAFT_NOT_FOUND','找不到圖片草稿；請先核准投稿。');
  return {...row,layout:JSON.parse(row.layout)};
}
export async function saveImageDraft(db,id,{revision,text,layout},principal){
  const result=await db.batch([
    db.prepare("UPDATE image_drafts SET text=?,layout=?,revision=revision+1,state='draft',editor_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND revision=? RETURNING id").bind(text,JSON.stringify(layout),principal.adminId??null,id,revision),
    audit(db,principal,'image_draft_saved',id)
  ]);
  if(!result[0].results.length)throw conflict();
  return getImageDraft(db,id);
}
export async function publishImageVersion(db,id,revision,key,principal){
  const version=crypto.randomUUID();
  const result=await db.batch([
    db.prepare("UPDATE image_drafts SET revision=revision+1,state='ready',operation=?,editor_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND revision=? RETURNING id").bind(version,principal.adminId??null,id,revision),
    db.prepare('INSERT INTO image_versions(id,draft_id,draft_revision,object_key,text,layout,editor_id) SELECT ?,id,revision,?,text,layout,editor_id FROM image_drafts WHERE id=? AND operation=?').bind(version,key,id,version),
    audit(db,principal,'image_ready',id)
  ]);
  if(!result[0].results.length)throw conflict();
  return {draft:await getImageDraft(db,id),versionId:version};
}
export async function listStudio(db,singleSend=false){
  const drafts=await db.prepare(`SELECT d.*,COALESCE(a.access_email,a.github_username,a.username,'本機管理員') AS editor,
    (SELECT id FROM image_versions v WHERE v.draft_id=d.id ORDER BY v.draft_revision DESC LIMIT 1) AS version_id
    FROM image_drafts d LEFT JOIN admins a ON a.id=d.editor_id ORDER BY d.updated_at DESC,d.id DESC`).all();
  const approved=await db.prepare("SELECT id,content FROM submissions WHERE status='approved' AND id NOT IN (SELECT id FROM image_drafts) ORDER BY id DESC").all();
  const dispatches=await db.prepare('SELECT id,caption,revision,updated_at FROM dispatch_drafts ORDER BY updated_at DESC').all();
  const sent=singleSend?new Set((await db.prepare('SELECT submission_id FROM send_records').all()).results.map(r=>r.submission_id)):new Set();
  return {drafts:drafts.results.filter(r=>!sent.has(r.id)).map(row=>({...row,layout:JSON.parse(row.layout)})),approved:approved.results.filter(r=>!sent.has(r.id)),dispatches:dispatches.results};
}
export async function getDispatch(db,id,singleSend=false){
  const draft=await db.prepare('SELECT * FROM dispatch_drafts WHERE id=?').bind(id).first();
  if(!draft)throw new HttpError(404,'DISPATCH_NOT_FOUND','找不到發送草稿。');
  if(singleSend){const items=await db.prepare('SELECT version_id,submission_id AS draft_id FROM dispatch_items WHERE dispatch_id=? ORDER BY position').bind(id).all();return {...draft,items:items.results};}
  const items=await db.prepare(`SELECT i.version_id,v.draft_id,v.created_at,
    (SELECT id FROM image_versions newest WHERE newest.draft_id=v.draft_id ORDER BY draft_revision DESC LIMIT 1) AS latest_version_id
    FROM dispatch_items i JOIN image_versions v ON v.id=i.version_id WHERE i.dispatch_id=? ORDER BY i.position`).bind(id).all();
  return {...draft,items:items.results};
}
export async function saveDispatch(db,id,{revision,caption,items},principal){
  const operation=crypto.randomUUID();
  const first=revision===0
    ?db.prepare('INSERT INTO dispatch_drafts(id,caption,operation,editor_id) VALUES(?,?,?,?) RETURNING id').bind(id,caption,operation,principal.adminId??null)
    :db.prepare("UPDATE dispatch_drafts SET caption=?,revision=revision+1,operation=?,editor_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND revision=? RETURNING id").bind(caption,operation,principal.adminId??null,id,revision);
  const result=await db.batch([first,
    db.prepare('DELETE FROM dispatch_items WHERE dispatch_id=? AND EXISTS(SELECT 1 FROM dispatch_drafts WHERE id=? AND operation=?)').bind(id,id,operation),
    ...items.map((version,index)=>db.prepare('INSERT INTO dispatch_items(dispatch_id,position,version_id) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM dispatch_drafts WHERE id=? AND operation=?)').bind(id,index,version,id,operation)),
    audit(db,principal,'dispatch_saved',null,{dispatchId:id})
  ]);
  if(!result[0].results.length)throw conflict();
  return getDispatch(db,id);
}
