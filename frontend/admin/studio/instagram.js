import {apiRequest} from '../../assets/api.js';
import {adminAuth} from '../../assets/admin-auth.js';
import {mountCaptionEditor} from './instagram-caption-editor.js';
const labels={none:'未排程',pending:'等待發布',publishing:'發布中',published:'已發布',failed:'發布失敗'};
function queueLabel(row){
 if(row.auto_publish&&row.publish_status==='none')return '待完成產圖／上傳';
 if(['pending','publishing'].includes(row.publish_status)&&!row.publish_started){
  if(row.preparation_status==='ready')return '已準備，等待發布';
  if(row.preparation_status==='processing')return 'Meta 圖片處理中';
 }
 return labels[row.publish_status];
}
export let instagramEnabled=false;
const statuses=new Map();
export const instagramStatus=id=>statuses.get(id);
export async function completeInstagramBatch(id,say){
 const listing=await apiRequest('/api/admin/instagram',{headers:adminAuth.requestHeaders()});
 if(!listing.enabled)throw Error('Instagram 暫停中，批次與編號仍保留。');
 const row=listing.items.find(r=>r.batch_id===id);
 if(row&&row.publish_status!=='none')return;
 const state=await apiRequest('/api/admin/studio/send?batchId='+encodeURIComponent(id),{headers:adminAuth.requestHeaders()});
 const batch=state.batch;
 if(!batch?.auto_publish||batch.items.some(i=>!i.object_key||i.confirmed))throw Error('請先完成這包所有最終圖片。');
 const uploads=[];
 for(const item of [...batch.items].sort((a,b)=>a.position-b.position)){
  say(`準備 IG 圖片 ${uploads.length+1}/${batch.items.length}…`);
  const blob=await jpegFromFinal(item,batch.generation);
  const result=await apiRequest(`/api/admin/instagram/batches/${id}/image`,{method:'POST',headers:{...adminAuth.requestHeaders({mutation:true}),'Content-Type':'image/jpeg','X-Send-Generation':batch.generation,'X-Image-Position':String(item.position)},body:blob});uploads.push(result.uploadId);
 }
 await apiRequest(`/api/admin/instagram/batches/${id}/schedule`,{method:'POST',headers:{...adminAuth.requestHeaders({mutation:true}),'Content-Type':'application/json'},body:JSON.stringify({revision:state.revision,generation:batch.generation,publishAt:batch.publish_at,uploads})});
}
async function jpegFromFinal(item,generation){
 const response=await fetch(`/api/admin/studio/send/images/${item.number}?generation=${encodeURIComponent(generation)}`,{credentials:'include',headers:adminAuth.requestHeaders()});
 if(!response.ok)throw Error('請先產生全部最終圖片，再加入排程。');
 const bitmap=await createImageBitmap(await response.blob());
 try{const canvas=document.createElement('canvas');canvas.width=1080;canvas.height=1350;canvas.getContext('2d').drawImage(bitmap,0,0);return await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(Error('JPEG 轉換失敗。')),'image/jpeg',0.95));}finally{bitmap.close();}
}
export function mountInstagram({run,say,onChange,onResume}){
 const panel=document.querySelector('#instagram-panel'),list=document.querySelector('#instagram-list');
 const editCaption=panel?mountCaptionEditor({onSaved:refresh,say}):null;
 async function refresh(){
  const data=await apiRequest('/api/admin/instagram',{headers:adminAuth.requestHeaders()});instagramEnabled=data.enabled;statuses.clear();for(const row of data.items)statuses.set(row.batch_id,row.publish_status);
  const hint=document.querySelector('#send-method-hint');if(hint&&data.enabled)hint.textContent='設定時間後鎖定並產圖，自動加入 IG 佇列。發布狀態請到 IG 排程查看；鎖定後不能取消或重排。';
  if(!panel)return;
  list.replaceChildren();if(!data.enabled){list.textContent='Instagram 發布目前暫停。此頁不會啟用發布或排程。';return;}
  if(!data.items.length){list.textContent='請先在本次發送選圖並產生圖片，再將整包加入排程。';}
  for(const row of data.items){
   const card=document.createElement('article');card.className='studio-card';
   const title=document.createElement('h3');title.textContent=`本次發送 #${row.first_number}–#${row.last_number} · ${row.item_count} 張 · ${queueLabel(row)}`;
   const info=document.createElement('p');info.textContent=`預定：${row.publish_at?new Date(row.publish_at).toLocaleString():'—'} · 發布：${row.published_at?new Date(row.published_at).toLocaleString():'—'} · 失敗次數：${row.publish_attempts??0} · IG ID：${row.instagram_media_id??'—'}`;
   card.append(title,info);if(row.publish_error){const error=document.createElement('p');error.textContent=row.publish_error;card.append(error);}
   if(row.can_edit_caption){const edit=document.createElement('button');edit.type='button';edit.textContent='修改內文';edit.addEventListener('click',()=>void editCaption(row.batch_id));card.append(edit);}
   if(row.next_attempt_at&&row.publish_status==='pending'){const retry=document.createElement('p');retry.textContent=`下次重試：${new Date(row.next_attempt_at).toLocaleString()}`;card.append(retry);}
   const time=document.createElement('input');time.type='datetime-local';time.setAttribute('aria-label',`整包 ${row.first_number}–${row.last_number} 發布時間`);const date=new Date(Date.now()+5*60000);time.value=new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);
   if(row.publish_status==='none'&&!row.auto_publish)card.append(time);
   const add=(text,command)=>{const button=document.createElement('button');button.textContent=text;button.type='button';button.addEventListener('click',()=>run(async()=>{
    if(command==='publish-now'&&!confirm(`立即將這包 ${row.item_count} 張圖片發布成一篇 Instagram 貼文？`))return;
    let options={method:'POST',headers:{...adminAuth.requestHeaders({mutation:true}),'Content-Type':'application/json'},body:JSON.stringify({revision:row.revision})};
    if(row.publish_status==='none'){
     const state=await apiRequest('/api/admin/studio/send?batchId='+encodeURIComponent(row.batch_id),{headers:adminAuth.requestHeaders()});
     if(state.batch?.id!==row.batch_id||state.batch.state!=='prepared'||state.batch.items.some(i=>i.confirmed||!i.object_key))throw Error('請先產生整包最終圖片；部分已手動發送的批次不能整包排程。');
     const publishAt=command==='publish-now'?new Date():new Date(time.value);if(!Number.isFinite(publishAt.getTime()))throw Error('請填寫發布時間。');
     const uploads=[];
     for(const item of [...state.batch.items].sort((a,b)=>a.position-b.position)){
      say(`準備整包圖片 ${uploads.length+1}/${state.batch.items.length}…`);const blob=await jpegFromFinal(item,state.batch.generation);
      const result=await apiRequest(`/api/admin/instagram/batches/${row.batch_id}/image`,{method:'POST',headers:{...adminAuth.requestHeaders({mutation:true}),'Content-Type':'image/jpeg','X-Send-Generation':state.batch.generation,'X-Image-Position':String(item.position)},body:blob});uploads.push(result.uploadId);
     }
     options.body=JSON.stringify({revision:state.revision,generation:state.batch.generation,publishAt:publishAt.toISOString(),uploads});
    }
    await apiRequest(`/api/admin/instagram/batches/${row.batch_id}/${command}`,options);await refresh();await onChange();say('整包 IG 排程狀態已更新。');
   }));card.append(button);};
   if(row.auto_publish){
    if(row.publish_status==='none'){const resume=document.createElement('button');resume.textContent='繼續產圖與上傳';resume.type='button';resume.addEventListener('click',()=>run(()=>onResume(row.batch_id)));card.append(resume);}
    if(row.publish_status==='failed'&&!row.uncertain)add('重試整包','retry-publish');
   }else{
    if(row.publish_status==='none'){add('整包排程','schedule');add('立即發布整包','publish-now');}
    if(row.publish_status==='pending'){add('立即發布整包','publish-now');add('取消整包排程','cancel-publish');}
    if(row.publish_status==='failed'&&!row.uncertain){add('重試整包','retry-publish');add('取消整包排程','cancel-publish');}
   }
   list.append(card);
  }
 }
 document.querySelector('#instagram-refresh')?.addEventListener('click',()=>run(refresh));
 return refresh;
}
