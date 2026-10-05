import {HttpError} from '../errors.js';
import {jsonResponse,methodNotAllowed} from '../http.js';
import {verifyAdminCsrf} from '../auth.js';
import {parseJsonObject} from '../validation.js';
import {igEnabled,listInstagram,stageInstagramImage,scheduleInstagram,editInstagram,processInstagramQueue} from '../repositories/instagram-queue.js';
import {readInstagramCaption,updateInstagramCaption} from '../repositories/instagram-captions.js';
export async function instagramMedia(request,env,token){
 if(request.method!=='GET')return methodNotAllowed(['GET']);
 if(!igEnabled(env)||!/^[a-f0-9-]{36}$/.test(token))throw new HttpError(404,'NOT_FOUND','找不到圖片。');
 const row=await env.DB.prepare("SELECT published_image_key FROM instagram_items i JOIN instagram_queue q ON q.batch_id=i.batch_id WHERE image_token=? AND publish_status IN ('pending','publishing','published') AND julianday(image_expires_at)>julianday('now')").bind(token).first();
 const object=row&&await env.STUDIO_IMAGES?.get(row.published_image_key);
 if(!object)throw new HttpError(404,'NOT_FOUND','找不到圖片。');
 return new Response(object.body,{headers:{'Content-Type':'image/jpeg','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});
}
export function validateJpeg(bytes){
 if(bytes.length<20||bytes.length>8*1024*1024||bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)throw new HttpError(400,'INVALID_JPEG','需要 1080×1350 JPEG，最大 8 MiB。');
 let p=2,dimensions=false;
 while(p+4<bytes.length){if(bytes[p++]!==255)break;const marker=bytes[p++];if(marker===218)break;const n=bytes[p]*256+bytes[p+1];if(n<2||p+n>bytes.length)break;
  if([192,194].includes(marker)){if(n<8||bytes[p+2]!==8||bytes[p+3]*256+bytes[p+4]!==1350||bytes[p+5]*256+bytes[p+6]!==1080)throw new HttpError(400,'INVALID_JPEG','JPEG 尺寸必須為 1080×1350。');dimensions=true;}p+=n;
 }
 if(!dimensions)throw new HttpError(400,'INVALID_JPEG','JPEG 標頭不完整。');
}
async function readJpeg(request){
 if(request.headers.get('Content-Type')!=='image/jpeg')throw new HttpError(400,'INVALID_JPEG','只接受 JPEG。');
 const reader=request.body?.getReader();if(!reader)throw new HttpError(400,'INVALID_JPEG','缺少圖片。');
 let size=0;const chunks=[];
 for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>8*1024*1024){await reader.cancel();throw new HttpError(413,'IMAGE_TOO_LARGE','圖片最大 8 MiB。');}chunks.push(value);}
 const data=new Uint8Array(size);let offset=0;for(const c of chunks){data.set(c,offset);offset+=c.length;}validateJpeg(data);return data;
}
export async function instagramHandler(request,env,principal,path,dependencies={}){
 if(!igEnabled(env))return jsonResponse({ok:true,data:{enabled:false,items:[]}}, {status:request.method==='GET'?200:503});
 if(path==='/api/admin/instagram'&&request.method==='GET')return jsonResponse({ok:true,data:{enabled:true,items:await listInstagram(env.DB)}});
 const captionPath=path.match(/^\/api\/admin\/instagram\/batches\/([a-zA-Z0-9-]+)\/caption$/);
 if(captionPath){
  if(request.method==='GET')return jsonResponse({ok:true,data:await readInstagramCaption(env.DB,captionPath[1])});
  if(request.method!=='POST')return methodNotAllowed(['GET','POST']);
  await verifyAdminCsrf(request,principal,env);
  const body=await parseJsonObject(request,{allowedKeys:['revision','customText'],maxBytes:65536});
  return jsonResponse({ok:true,data:await updateInstagramCaption(env.DB,captionPath[1],body,principal)});
 }
 if(request.method!=='POST')return methodNotAllowed(['POST']);
 await verifyAdminCsrf(request,principal,env);
 const match=path.match(/^\/api\/admin\/instagram\/batches\/([a-zA-Z0-9-]+)\/(image|schedule|publish-now|retry-publish|cancel-publish)$/);if(!match)throw new HttpError(404,'NOT_FOUND','找不到 API。');
 const id=match[1],command=match[2];
 if(command==='image'){
  if(!env.STUDIO_IMAGES)throw new HttpError(503,'IG_STORAGE_MISSING','圖片儲存尚未設定。');
  const data=await readJpeg(request),key=`instagram/${crypto.randomUUID()}.jpg`;
  await env.DB.prepare("INSERT INTO send_uploads VALUES(?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'))").bind(key).run();
  await env.STUDIO_IMAGES.put(key,data,{httpMetadata:{contentType:'image/jpeg'}});
  const uploadId=await stageInstagramImage(env.DB,{id,key,generation:request.headers.get('X-Send-Generation'),position:Number(request.headers.get('X-Image-Position'))});
  return jsonResponse({ok:true,data:{uploadId}});
 }else{
  const body=await parseJsonObject(request,{allowedKeys:['revision','generation','publishAt','uploads'],maxBytes:4096});
  if(command==='schedule'||(command==='publish-now'&&body.uploads))await scheduleInstagram(env.DB,{...body,id,publishAt:command==='publish-now'?new Date().toISOString():body.publishAt},principal);
  else await editInstagram(env.DB,id,command,body.revision,principal);
 }
 if(command==='publish-now')await processInstagramQueue(env,{onlyId:id,...dependencies.instagram});
 return jsonResponse({ok:true,data:{enabled:true,items:await listInstagram(env.DB)}});
}
