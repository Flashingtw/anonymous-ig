// Only this module knows Meta's endpoints. Tokens never enter URLs or error messages.
export class InstagramError extends Error {
 constructor(message,{ambiguous=false}={}){super(message);this.name='InstagramError';this.ambiguous=ambiguous;}
}
export function instagramConfig(env){
 if(!env.IG_ACCESS_TOKEN||!/^\d+$/.test(env.IG_USER_ID??'')||!/^v\d+\.\d+$/.test(env.IG_API_VERSION??''))throw new InstagramError('Instagram 尚未設定完整。');
 return {origin:`https://graph.instagram.com/${env.IG_API_VERSION}`,user:env.IG_USER_ID,token:env.IG_ACCESS_TOKEN};
}
export function instagramService(env,fetcher=fetch){
 const config=instagramConfig(env);
 async function call(path,params,method='POST',publishing=false){
  let response,data;
  try{
   response=await fetcher(config.origin+path,{method,headers:{Authorization:`Bearer ${config.token}`,...(method==='POST'?{'Content-Type':'application/x-www-form-urlencoded'}:{})},...(method==='POST'?{body:new URLSearchParams(params)}:{}),signal:AbortSignal.timeout(25000)});
   data=await response.json();
  }catch{throw new InstagramError('Meta 連線失敗，請稍後重試。',{ambiguous:publishing});}
  if(!response.ok||data.error){
   const code=Number.isSafeInteger(data.error?.code)?data.error.code:'unknown';
   throw new InstagramError(`Meta HTTP ${response.status} / code ${code}。請檢查授權、圖片格式與帳號發布限制。`,{ambiguous:publishing&&response.status>=500});
  }
  return data;
 }
 return {
  async create({imageUrl,caption,carouselItem=false}){const r=await call(`/${config.user}/media`,{image_url:imageUrl,...(carouselItem?{is_carousel_item:'true'}:{caption})});if(!/^\d+$/.test(r.id??''))throw new InstagramError('Meta 未回傳 container ID。');return r.id;},
  async createCarousel({children,caption}){const r=await call(`/${config.user}/media`,{media_type:'CAROUSEL',children:children.join(','),caption});if(!/^\d+$/.test(r.id??''))throw new InstagramError('Meta 未回傳 carousel ID。');return r.id;},
  async status(id){return (await call(`/${id}?fields=status_code`,null,'GET')).status_code;},
  async publish(id){const r=await call(`/${config.user}/media_publish`,{creation_id:id},'POST',true);if(!/^\d+$/.test(r.id??''))throw new InstagramError('Meta 未回傳 media ID，請核對 Instagram。',{ambiguous:true});return r.id;}
 };
}
// Durable callbacks are awaited before advancing to the next external side effect.
async function ready(service,id){
 const status=await service.status(id);
 if(status==='IN_PROGRESS')throw new InstagramError('Meta 正在處理圖片，稍後重試。');
 if(status!=='FINISHED')throw new InstagramError('Meta container 無法發布，請核對 Instagram。',{ambiguous:status==='PUBLISHED'});
}
export async function publishInstagramPost({images,caption,creationId,onChildCreated,onCreated,onPublishing},service){
 let id=creationId;
 if(!id){
  if(images.length===1){id=await service.create({imageUrl:images[0].imageUrl,caption});}
  else{
   const children=[];
   for(const image of images){
    const child=image.creation_id??await service.create({imageUrl:image.imageUrl,carouselItem:true});
    if(!image.creation_id)await onChildCreated(image.position,child);
    children.push(child);
   }
   for(const child of children)await ready(service,child);
   id=await service.createCarousel({children,caption});
  }
  await onCreated(id);
 }
 await ready(service,id);await onPublishing();return service.publish(id);
}
