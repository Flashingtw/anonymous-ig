import {HttpError} from '../errors.js';
import {jsonResponse,methodNotAllowed} from '../http.js';
import {verifyAdminCsrf} from '../auth.js';
import {parseJsonObject,parsePositiveInteger} from '../validation.js';
import {validDocument,validItems} from '../../../frontend/admin/studio/model.js';
import {graphemeLength} from '../../../frontend/assets/graphemes.js';
import {crc32} from '../../../frontend/admin/studio/zip.js';
import {createImageDraft,getImageDraft,saveImageDraft,listStudio,publishImageVersion,getDispatch,saveDispatch} from '../repositories/image-drafts.js';
export const studioEnabled=env=>env.IMAGE_STUDIO_ENABLED==='true';
const fail=(code,message,status=400)=>{throw new HttpError(status,code,message);};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function validatePng(bytes){
  if(bytes.length<57||bytes.length>8*1024*1024||[137,80,78,71,13,10,26,10].some((v,i)=>bytes[i]!==v))fail('INVALID_PNG','需要完整的 PNG 圖片，最大 8 MiB。');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let offset=8,idat=false,end=false,header=false;
  while(offset+12<=bytes.length){
    const length=view.getUint32(offset),finish=offset+12+length;
    if(finish>bytes.length)fail('INVALID_PNG','PNG 不完整。');
    const type=String.fromCharCode(...bytes.subarray(offset+4,offset+8));
    if(crc32(bytes.subarray(offset+4,finish-4))!==view.getUint32(finish-4))fail('INVALID_PNG','PNG 檢查碼錯誤。');
    if(!header&&type!=='IHDR')fail('INVALID_PNG','PNG 缺少標頭。');
    if(type==='IHDR'){
      if(header||length!==13||view.getUint32(offset+8)!==1080||view.getUint32(offset+12)!==1350||bytes[offset+16]!==8||![2,6].includes(bytes[offset+17])||bytes[offset+18]!==0||bytes[offset+19]!==0||bytes[offset+20]!==0)fail('INVALID_PNG','圖片必須是 1080×1350 的 8-bit RGB/RGBA PNG。');
      header=true;
    }
    if(type==='acTL')fail('INVALID_PNG','不接受動畫 PNG。');
    if(type==='IDAT'&&length>0)idat=true;
    if(type==='IEND'){if(length||finish!==bytes.length)fail('INVALID_PNG','PNG 結尾錯誤。');end=true;}
    offset=finish;
  }
  if(!header||!idat||!end||offset!==bytes.length)fail('INVALID_PNG','PNG 不完整。');
}
async function readImage(request){
  if(request.headers.get('content-type')!=='image/png')fail('INVALID_PNG','只接受 image/png。');
  const reader=request.body?.getReader();if(!reader)fail('INVALID_PNG','缺少圖片。');
  const chunks=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8*1024*1024){await reader.cancel();fail('IMAGE_TOO_LARGE','圖片最大 8 MiB。',413);}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}validatePng(bytes);return bytes;
}
export async function imageStudioHandler(request,env,principal,path){
  if(!studioEnabled(env))fail('IMAGE_STUDIO_DISABLED','製圖功能尚未啟用。',503);
  const db=env.DB,url=new URL(request.url);
  if(request.method!=='GET')await verifyAdminCsrf(request,principal,env);
  if(path==='/api/admin/studio'){
    if(request.method!=='GET')return methodNotAllowed(['GET']);
    return jsonResponse({ok:true,data:await listStudio(db)});
  }
  let match=path.match(/^\/api\/admin\/studio\/images\/([^/]+)$/);
  if(match){
    if(request.method!=='GET')return methodNotAllowed(['GET']);
    if(!uuid(match[1]))fail('INVALID_ID','圖片編號錯誤。');
    const version=await db.prepare('SELECT object_key,draft_id FROM image_versions WHERE id=?').bind(match[1]).first();
    if(!version)fail('IMAGE_NOT_FOUND','圖片不存在。',404);
    if(!env.STUDIO_IMAGES)fail('IMAGE_STORAGE_UNAVAILABLE','圖片儲存尚未設定。',503);
    const object=await env.STUDIO_IMAGES.get(version.object_key);if(!object)fail('IMAGE_NOT_FOUND','圖片無法讀取。',404);
    return new Response(object.body,{headers:{'Content-Type':'image/png','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',...(url.searchParams.has('download')?{'Content-Disposition':`attachment; filename="submission-${version.draft_id}.png"`}:{})}});
  }
  match=path.match(/^\/api\/admin\/studio\/drafts\/(\d+)(\/ready)?$/);
  if(match){
    const id=parsePositiveInteger(match[1]);
    if(match[2]){
      if(request.method!=='POST')return methodNotAllowed(['POST']);
      const revision=parsePositiveInteger(request.headers.get('If-Match')??'');
      const draft=await getImageDraft(db,id);
      if(draft.revision!==revision)fail('IMAGE_REVISION_CONFLICT','草稿已更新，請重新載入。',409);
      if(!validDocument(draft.text,draft.layout))fail('INVALID_IMAGE_DOCUMENT','請先修正並保存草稿。');
      if(!env.STUDIO_IMAGES)fail('IMAGE_STORAGE_UNAVAILABLE','圖片儲存尚未設定。',503);
      const bytes=await readImage(request),key=`studio/${id}/${crypto.randomUUID()}.png`;
      await env.STUDIO_IMAGES.put(key,bytes,{httpMetadata:{contentType:'image/png'}});
      // An uncertain D1 response must not delete a potentially committed object.
      // Unreferenced uploads are harmless private orphans, retained for reconciliation.
      return jsonResponse({ok:true,data:await publishImageVersion(db,id,revision,key,principal)});
    }
    if(request.method==='GET')return jsonResponse({ok:true,data:await getImageDraft(db,id)});
    if(request.method==='POST')return jsonResponse({ok:true,data:await createImageDraft(db,id,principal)});
    if(request.method==='PUT'){
      const body=await parseJsonObject(request,{allowedKeys:['revision','text','layout'],maxBytes:32768});
      if(!Number.isSafeInteger(body.revision)||body.revision<1||!validDocument(body.text,body.layout))fail('INVALID_IMAGE_DOCUMENT','正文限 1–1000 字，請確認字級與位置。');
      return jsonResponse({ok:true,data:await saveImageDraft(db,id,body,principal)});
    }
    return methodNotAllowed(['GET','POST','PUT']);
  }
  match=path.match(/^\/api\/admin\/studio\/dispatches(?:\/([^/]+))?$/);
  if(match){
    if(request.method==='GET'&&uuid(match[1]))return jsonResponse({ok:true,data:await getDispatch(db,match[1])});
    if((request.method==='POST'&&!match[1])||(request.method==='PUT'&&uuid(match[1]))){
      const body=await parseJsonObject(request,{allowedKeys:['revision','caption','items'],maxBytes:16384});
      if(typeof body.caption!=='string'||graphemeLength(body.caption)>2000||!validItems(body.items)||!Number.isSafeInteger(body.revision)||body.revision<0||(!match[1]?body.revision!==0:body.revision<1))fail('INVALID_DISPATCH','請選 1–10 張不重複圖片，說明最多 2000 字。');
      for(const id of body.items)if(!await db.prepare('SELECT id FROM image_versions WHERE id=?').bind(id).first())fail('IMAGE_NOT_FOUND','選取的圖片版本不存在。');
      return jsonResponse({ok:true,data:await saveDispatch(db,match[1]??crypto.randomUUID(),body,principal)});
    }
    return methodNotAllowed(match[1]?['GET','PUT']:['POST']);
  }
  fail('NOT_FOUND','找不到製圖 API。',404);
}
