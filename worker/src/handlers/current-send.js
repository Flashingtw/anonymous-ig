import {HttpError} from '../errors.js';
import {jsonResponse,methodNotAllowed} from '../http.js';
import {parseJsonObject} from '../validation.js';
import {currentSend,changeSend,attachFinal,sentRecords} from '../repositories/current-send.js';
import {readImage} from './image-studio.js';
export async function currentSendHandler(request,env,principal,path){
 const root='/api/admin/studio/send',db=env.DB;
 if(env.SINGLE_SEND_ENABLED!=='true')throw new HttpError(503,'SINGLE_SEND_DISABLED','本次發送尚未啟用。');
 if(path===root&&request.method==='GET')return jsonResponse({ok:true,data:await currentSend(db)});
 if(path===root+'/records'&&request.method==='GET'){
  const before=Number(new URL(request.url).searchParams.get('before')??Number.MAX_SAFE_INTEGER);
  if(!Number.isSafeInteger(before)||before<1)throw new HttpError(400,'INVALID_CURSOR','紀錄頁碼錯誤。');
  return jsonResponse({ok:true,data:await sentRecords(db,before)});
 }
 const image=path.match(/\/send\/images\/(\d+)$/);
 if(image){
  if(request.method!=='GET')return methodNotAllowed(['GET']);
  const number=Number(image[1]),generation=new URL(request.url).searchParams.get('generation');
  const item=await db.prepare(`SELECT i.object_key FROM send_items i JOIN send_batches b ON b.id=i.batch_id
   WHERE i.number=? AND i.object_key IS NOT NULL AND (? IS NULL OR b.generation=?) AND (
    (i.confirmed=1 AND EXISTS(SELECT 1 FROM send_records r WHERE r.number=i.number AND r.purged_at IS NULL AND julianday(r.expires_at)>julianday('now')))
    OR (i.confirmed=0 AND b.state='prepared' AND b.generation=? AND NOT EXISTS(SELECT 1 FROM send_items pending WHERE pending.batch_id=b.id AND pending.confirmed=0 AND pending.object_key IS NULL)))`).bind(number,generation,generation,generation).first();
  if(!item)throw new HttpError(404,'FINAL_IMAGE_UNAVAILABLE','最終圖片尚未完成、已取消或保留期已過。');
  const object=await env.STUDIO_IMAGES?.get(item.object_key);
  if(!object)throw new HttpError(404,'FINAL_IMAGE_UNAVAILABLE','圖片無法讀取。');
  return new Response(object.body,{headers:{'Content-Type':'image/png','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':`attachment; filename="daan-${number}.png"`}});
 }
 if(path===root+'/image'&&request.method==='POST'){
  if(!env.STUDIO_IMAGES)throw new HttpError(503,'IMAGE_STORAGE_UNAVAILABLE','圖片儲存尚未設定。');
  const revision=Number(request.headers.get('If-Match')),generation=request.headers.get('X-Send-Generation'),position=Number(request.headers.get('X-Send-Position'));
  const state=await currentSend(db);
  if(state.revision!==revision||state.batch?.state!=='prepared'||state.batch.generation!==generation||!state.batch.items.some(i=>i.position===position&&!i.confirmed&&!i.object_key))throw new HttpError(409,'SEND_CONFLICT','準備已更新，請重新載入。');
  const bytes=await readImage(request),key=`final/${generation}/${crypto.randomUUID()}.png`;
  // Record before external I/O so a failed/uncertain upload is eventually reclaimed.
  await db.prepare("INSERT INTO send_uploads VALUES(?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'))").bind(key).run();
  await env.STUDIO_IMAGES.put(key,bytes,{httpMetadata:{contentType:'image/png'}});
  return jsonResponse({ok:true,data:await attachFinal(db,{revision,generation,position,key},principal)});
 }
 const command=path.slice(root.length+1);
 if(['save','prepare','reset','cancel','confirm'].includes(command)&&request.method==='POST'){
  const body=await parseJsonObject(request,{allowedKeys:['revision','items','caption','count'],maxBytes:16384});
  return jsonResponse({ok:true,data:await changeSend(db,command,body,principal)});
 }
 return methodNotAllowed(['GET','POST']);
}
