import {apiRequest} from '../../assets/api.js';
import {adminAuth} from '../../assets/admin-auth.js';
import {graphemeLength} from '../../assets/graphemes.js';
import {loadStudioAssets,paint,autoLayout,exportPng} from './canvas.js';
import {WIDTH,HEIGHT,validItems,numberLabel} from './model.js';
import {makeZip} from './zip.js';
import {snapPosition} from './alignment.js';
import {defaultCaption,syncDefaultCaption} from './caption.js';
const $=selector=>document.querySelector(selector);
const base='/api/admin/studio';
let tab='draft',listing={drafts:[],approved:[],dispatches:[]},sendState={last_number:108,revision:1,batch:null},records=[],assets,doc,dispatch,selected='body',dirty=false,dispatchDirty=false,busy=false,drag;
const selection=new Set();let guides={};
let assetLoading;
async function getAssets(){if(assets)return assets;if(!assetLoading)assetLoading=loadStudioAssets().then(value=>assets=value).finally(()=>{assetLoading=null;});return assetLoading;}
const canvas=$('#image-canvas'),ctx=canvas.getContext('2d');
const say=text=>{$('#studio-status').textContent=text;};
const button=(text,action)=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.addEventListener('click',()=>run(action));return b;};
const paragraph=text=>{const p=document.createElement('p');p.textContent=text;return p;};
const request=(path,{method='GET',body}={})=>apiRequest(base+path,{method,headers:{...adminAuth.requestHeaders({mutation:method!=='GET'}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
async function run(action){
  if(busy)return;busy=true;say('處理中⋯');
  const controls=[...document.querySelectorAll('button,input,select,textarea')].map(el=>[el,el.disabled]);controls.forEach(([el])=>{el.disabled=true;});
  try{await action();}catch(error){say(error.message??'操作失敗，請重試。');if(error.status===401)say('登入已過期，請返回投稿管理重新登入。你的未保存修改仍保留。');}
  finally{busy=false;controls.forEach(([el,disabled])=>{el.disabled=disabled;});sync();}
}
function mayLeave(){return !(dirty||dispatchDirty)||confirm('有尚未保存的修改，確定離開並捨棄？');}
window.addEventListener('beforeunload',event=>{if(dirty||dispatchDirty){event.preventDefault();event.returnValue='';}});
document.querySelector('.studio-header a').addEventListener('click',event=>{if(!mayLeave())event.preventDefault();});
function closePanels(){doc=null;dispatch=null;dirty=false;dispatchDirty=false;$('#editor').hidden=true;$('#dispatch-editor').hidden=true;sync();}
async function reload(){listing=await request('');sendState=await request('/send');records=await request('/send/records');$('#send-progress').textContent=`最後已確認 #${sendState.last_number} · 下一張 #${sendState.last_number+1} · 保存／下載不占號`;renderGallery();say('已更新。');}
async function imageBlob(id){
  const r=await fetch(base+'/images/'+id,{credentials:'include',headers:adminAuth.requestHeaders()});
  if(!r.ok)throw new Error('無法讀取圖片，請確認登入仍有效後重試。');return r.blob();
}
async function thumbnail(img,id){
  try{const url=URL.createObjectURL(await imageBlob(id));img.onload=img.onerror=()=>URL.revokeObjectURL(url);img.src=url;}catch{img.alt='圖片載入失敗，請重新整理。';}
}
function renderGallery(){
  const gallery=$('#gallery');gallery.replaceChildren();$('#compose').hidden=tab!=='ready';
  document.querySelectorAll('[data-tab]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.tab===tab)));
  if(tab==='current'){
    gallery.append(paragraph(sendState.batch?'目前有一組團隊共用的本次發送。':'目前沒有本次發送，請到待發送選圖。'));
    if(sendState.batch)gallery.append(button('開啟本次發送',()=>{closePanels();dispatch=structuredClone(sendState.batch);showDispatch();}));
    sync();return;
  }
  if(tab==='records'){
    for(const row of records){const card=document.createElement('article');card.className='studio-card';card.append(paragraph(`#${row.number} · 投稿 #${row.submission_id}`),paragraph(`${row.confirmer??'管理員'} · ${row.confirmed_at} · 人工確認（未向 IG 驗證）`));
      if(!row.purged_at&&Date.parse(row.expires_at)>Date.now())card.append(button('下載最終 PNG',async()=>download(await finalBlob(row.number),`daan-${row.number}.png`)));else card.append(paragraph('七天保留期已結束。'));
      gallery.append(card);
    }if(!records.length)gallery.append(paragraph('尚無已確認紀錄。'));
    if(records.length&&records.length%100===0)gallery.append(button('載入更早紀錄',async()=>{const more=await request('/send/records?before='+records.at(-1).number);records.push(...more);renderGallery();if(!more.length)say('沒有更早紀錄。');}));sync();return;
  }
  const rows=tab==='dispatch'?listing.dispatches:listing.drafts.filter(row=>tab==='draft'?row.state==='draft':row.state==='ready');
  for(const row of rows){
    const card=document.createElement('article');card.className='studio-card';
    if(tab==='dispatch'){
      card.append(paragraph(row.caption||'未填寫貼文說明'),paragraph(row.updated_at),button('檢視歷史草稿',()=>openDispatch(row.id)));
    }else{
      card.append(paragraph(`投稿 #${row.id}`));
      if(row.version_id&&tab==='ready'){
        const img=document.createElement('img');img.alt=`投稿 #${row.id} 圖片`;card.append(img);void thumbnail(img,row.version_id);
        const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.checked=selection.has(row.version_id);
        input.addEventListener('change',()=>{
          if(input.checked&&selection.size>=10){input.checked=false;say('每組最多 10 張。');return;}
          if(input.checked)selection.add(row.version_id);else selection.delete(row.version_id);sync();
        });label.append(input,document.createTextNode(' 選取圖片'));card.append(label);
        card.append(paragraph('此縮圖僅為預覽；正式檔請由本次發送產生。'));
      }else card.append(paragraph(row.text));
      card.append(paragraph(`${row.editor} · ${row.updated_at}`),button('編輯圖片',()=>openImage(row.id)));
    }
    gallery.append(card);
  }
  if(tab==='draft')for(const row of listing.approved){
    const card=document.createElement('article');card.className='studio-card';card.append(paragraph(`已核准投稿 #${row.id}`),paragraph(row.content),button('建立圖片草稿',async()=>{await request('/drafts/'+row.id,{method:'POST'});await reload();await openImage(row.id);}));gallery.append(card);
  }
  if(!gallery.children.length)gallery.append(paragraph('此區目前沒有項目。'));
  sync();
}
function sync(){
  $('#gallery').hidden=Boolean(doc||dispatch);$('#reload').hidden=Boolean(doc||dispatch);$('#compose').hidden=tab!=='ready'||Boolean(doc||dispatch);
  $('#compose').textContent=sendState.batch?'已有本次發送，請先完成或取消':`準備發送（${selection.size} / 10）`;$('#compose').disabled=busy||selection.size===0||Boolean(sendState.batch);
  if(doc&&assets){
    const result=paint(ctx,assets,doc,{selected});$('#image-error').textContent=result.errors.join(' ');
    if(drag){
      ctx.save();ctx.strokeStyle='#da5125';ctx.lineWidth=2;ctx.setLineDash([10,6]);
      if(guides.x!==undefined){ctx.beginPath();ctx.moveTo(guides.x,0);ctx.lineTo(guides.x,HEIGHT);ctx.stroke();}
      if(guides.y!==undefined){ctx.beginPath();ctx.moveTo(0,guides.y);ctx.lineTo(WIDTH,guides.y);ctx.stroke();}
      ctx.restore();
    }
    $('#ready-image').disabled=busy||result.errors.length>0;
  }else $('#ready-image').disabled=true;
  $('#image-count').textContent=`${graphemeLength($('#image-text').value)} / 1000`;
  $('#caption-count').textContent=`${graphemeLength($('#caption').value)} / 2000`;
}
function boxControls(){if(!doc)return;const box=doc.layout[selected];$('#font-size').value=box.size;$('#pos-x').value=Math.round(box.x);$('#pos-y').value=Math.round(box.y);}
async function ensureAssets(){
  try{assets=await getAssets();$('#retry-assets').hidden=true;sync();say('字型與底圖已載入。');}
  catch{assets=null;$('#retry-assets').hidden=false;$('#image-error').textContent='字型或底圖載入失敗。請重試，不能使用替代字型匯出。';throw new Error('字型或底圖載入失敗。');}
}
async function openImage(id){
  if(!mayLeave())return;
  const loaded=await request('/drafts/'+id);closePanels();doc=loaded;$('#editor').hidden=false;
  doc.layout.number.label=String(sendState.last_number+1);
  $('#editor-title').textContent=`編輯圖片 #${id}`;$('#image-text').value=doc.text;$('#selected-box').value=selected='body';
  $('#image-number').value=numberLabel(doc);
  if(!assets)await ensureAssets();
  if(doc.revision===1){doc.layout=autoLayout(ctx,doc);dirty=true;}
  boxControls();sync();$('#editor').scrollIntoView({behavior:'smooth'});say('編輯文字副本，不會修改原始投稿。');
}
async function saveImage(){
  doc=await request('/drafts/'+doc.id,{method:'PUT',body:{revision:doc.revision,text:doc.text,layout:doc.layout}});dirty=false;say('圖片草稿已保存。');
}
async function returnToDrafts(message){
  await reload();closePanels();tab='draft';renderGallery();say(message);
  document.querySelector('[data-tab="draft"]').focus();
}
async function readyImage(){
  if(!assets)throw new Error('字型與底圖尚未載入。');
  if(dirty)await saveImage();
  const png=await exportPng(assets,doc);
  const r=await fetch(base+`/drafts/${doc.id}/ready`,{method:'POST',credentials:'include',headers:{...adminAuth.requestHeaders({mutation:true}),'Content-Type':'image/png','If-Match':String(doc.revision)},body:png});
  const payload=await r.json();if(!r.ok)throw new Error(payload.error?.message??'圖片保存失敗，請重試。');
  doc=payload.data.draft;dirty=false;await returnToDrafts('已加入待發送；尚未發布到 IG。');
}
$('#image-text').addEventListener('input',()=>{if(doc){doc.text=$('#image-text').value;dirty=true;sync();}});
$('#selected-box').addEventListener('change',()=>{selected=$('#selected-box').value;boxControls();sync();});
for(const [id,key]of [['font-size','size'],['pos-x','x'],['pos-y','y']])$('#'+id).addEventListener('input',()=>{if(doc){doc.layout[selected][key]=Number($('#'+id).value);dirty=true;sync();}});
$('#auto-layout').addEventListener('click',()=>{if(doc&&assets&&!busy){doc.layout=autoLayout(ctx,doc);dirty=true;boxControls();sync();}});
$('#center-text').addEventListener('click',()=>{
  if(!doc||busy)return;
  doc.layout[selected].x=WIDTH/2;dirty=true;boxControls();sync();
  say('已將選取文字框水平置中，請保存草稿。');
});
$('#center-vertical').addEventListener('click',()=>{
  if(!doc||busy)return;
  doc.layout[selected].y=HEIGHT/2;dirty=true;boxControls();sync();
  say('已將選取文字框垂直置中，請保存草稿。');
});
$('#save-image').addEventListener('click',()=>run(async()=>{await saveImage();await returnToDrafts('圖片草稿已保存。');}));$('#ready-image').addEventListener('click',()=>run(readyImage));
$('#retry-assets').addEventListener('click',()=>run(ensureAssets));
const coordinates=event=>{const r=canvas.getBoundingClientRect();return {x:(event.clientX-r.left)*WIDTH/r.width,y:(event.clientY-r.top)*HEIGHT/r.height};};
canvas.addEventListener('pointerdown',event=>{
  if(!doc||!assets||busy)return;
  const p=coordinates(event),boxes=paint(ctx,assets,doc,{selected});
  const hit=['number','body'].find(key=>{const b=boxes[key];return p.x>=b.x-12&&p.x<=b.x+b.width+12&&p.y>=b.y-12&&p.y<=b.y+b.height+12;});
  if(!hit)return;selected=hit;$('#selected-box').value=hit;drag={pointer:event.pointerId,x:p.x,y:p.y,box:{...doc.layout[hit]}};canvas.setPointerCapture(event.pointerId);canvas.focus();boxControls();sync();
});
canvas.addEventListener('pointermove',event=>{
  if(!drag||busy)return;const p=coordinates(event);
  const position={x:Math.round(Math.max(0,Math.min(WIDTH,drag.box.x+p.x-drag.x))),y:Math.round(Math.max(0,Math.min(HEIGHT,drag.box.y+p.y-drag.y)))};
  const snapped=snapPosition(position,doc.layout[selected==='body'?'number':'body'],8*WIDTH/canvas.getBoundingClientRect().width,{disabled:event.altKey});
  Object.assign(doc.layout[selected],snapped.position);guides=snapped.guides;dirty=true;boxControls();sync();
});
function endDrag(){drag=null;guides={};sync();}
canvas.addEventListener('pointerup',endDrag);canvas.addEventListener('pointercancel',endDrag);
canvas.addEventListener('keydown',event=>{
  if(!doc||busy)return;const moves={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};if(!moves[event.key])return;
  event.preventDefault();const [x,y]=moves[event.key],step=event.shiftKey?10:1;doc.layout[selected].x=Math.max(0,Math.min(WIDTH,doc.layout[selected].x+x*step));doc.layout[selected].y=Math.max(0,Math.min(HEIGHT,doc.layout[selected].y+y*step));dirty=true;boxControls();sync();
});
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
async function finalBlob(number,generation){const r=await fetch(base+'/send/images/'+number+(generation?'?generation='+encodeURIComponent(generation):''),{credentials:'include',headers:adminAuth.requestHeaders()});if(!r.ok)throw new Error('最終圖片尚未完成、已取消或保留期已過。');return r.blob();}
async function numberedPreview(img,item,number){
 try{await getAssets();const layout=structuredClone(item.layout);layout.number.label=String(number);const blob=await exportPng(assets,{id:item.submission_id,text:item.text,layout});const url=URL.createObjectURL(blob);if(!img.isConnected){URL.revokeObjectURL(url);return;}img.onload=img.onerror=()=>URL.revokeObjectURL(url);img.src=url;}catch{img.alt='編號預覽無法產生，請檢查字型或排版後重試。';}
}
async function openDispatch(id){if(!mayLeave())return;const data=await request('/dispatches/'+id);closePanels();dispatch={...data,historical:true};showDispatch();}
function showDispatch(){
  if(!dispatch.historical&&dispatch.state==='editing')dispatch.caption=syncDefaultCaption(dispatch.caption,dispatch.items.map((item,index)=>sendState.last_number+index+1));
  $('#dispatch-editor').hidden=false;$('#caption').value=dispatch.caption;const list=$('#dispatch-items');list.replaceChildren();
  const historical=dispatch.historical,locked=dispatch.state==='prepared',remaining=dispatch.items.filter(i=>!i.confirmed),complete=locked&&remaining.every(i=>i.object_key);
  $('#dispatch-title').textContent=historical?'歷史草稿（唯讀）':'本次發送';
  $('#send-stage').textContent=historical?'不占號；只能複製到空白的本次發送。':locked?'順序與號碼已鎖定。下載不等於發送；請手動上傳後確認。':'預覽連號，尚未占號；準備後不可直接編輯。';
  $('#caption').readOnly=Boolean(locked||historical);
  $('#save-dispatch').hidden=locked;$('#save-dispatch').textContent=historical?'複製到本次發送':'保存本次發送';
  $('#download-dispatch').hidden=Boolean(historical);$('#download-dispatch').textContent=complete?'下載整組 ZIP':'產生最終圖片並下載';
  $('#reset-send').hidden=!locked||dispatch.items.some(i=>i.confirmed);$('#cancel-send').hidden=historical||!dispatch.id;
  $('#confirm-controls').hidden=!complete;$('#confirm-count').max=remaining.length;
  dispatch.items.forEach((item,index)=>{
    const li=document.createElement('li'),img=document.createElement('img'),id=item.submission_id??item.draft_id,number=item.number??sendState.last_number+index+1;img.alt=`第 ${index+1} 張，投稿 #${id}，編號 ${number}`;
    if(complete&&item.object_key)void finalBlob(number,dispatch.generation).then(blob=>{const url=URL.createObjectURL(blob);img.onload=img.onerror=()=>URL.revokeObjectURL(url);img.src=url;}).catch(()=>{img.alt='圖片無法讀取。';});
    else if(!historical&&item.layout)void numberedPreview(img,item,number);
    else if(item.version_id)void thumbnail(img,item.version_id);
    li.append(img,paragraph(`${index+1}. 投稿 #${id} · ${historical?'歷史預覽':`#${number}${locked?'（鎖定）':'（預覽）'}`}${item.confirmed?' · 已確認':''}`));
    if(complete&&!item.confirmed)li.append(button('下載此張 PNG',async()=>download(await finalBlob(number,dispatch.generation),`daan-${number}.png`)));
    if(locked||historical){list.append(li);return;}
    for(const [label,delta]of [['往前',-1],['往後',1]]){
      const b=button(label,()=>{const next=index+delta;[dispatch.items[index],dispatch.items[next]]=[dispatch.items[next],dispatch.items[index]];dispatchDirty=true;showDispatch();say('順序已調整，請保存。');});b.disabled=index+delta<0||index+delta>=dispatch.items.length;li.append(b);
    }
    li.append(button('移除此張',()=>{dispatch.items.splice(index,1);dispatchDirty=true;showDispatch();say('已移除，請保存。');}));
    if(item.latest_version_id&&item.latest_version_id!==item.version_id)li.append(button('換成最新圖片',()=>{if(dispatch.items.some(i=>i.version_id===item.latest_version_id))throw new Error('此圖片已在組內。');item.version_id=item.latest_version_id;if(item.latest_document){item.text=item.latest_document.text;item.layout=structuredClone(item.latest_document.layout);}dispatchDirty=true;showDispatch();say('已換成最新版本，請保存。');}));
    list.append(li);
  });sync();
}
async function saveDispatch(){
  const items=dispatch.items.map(i=>i.version_id);
  if(!validItems(items)||graphemeLength(dispatch.caption)>2000)throw new Error('請選取 1–10 張不重複圖片，說明最多 2000 字。');
  if(dispatch.historical&&sendState.batch)throw new Error('已有本次發送，不能匯入第二組。');
  sendState=await request('/send/save',{method:'POST',body:{revision:sendState.revision,caption:dispatch.caption,items}});dispatch=structuredClone(sendState.batch);dispatchDirty=false;showDispatch();say('本次發送已保存，未發布到 IG。');
}
$('#compose').addEventListener('click',()=>run(()=>{
  if(!mayLeave())return;if(sendState.batch)throw new Error('請先完成或取消本次發送。');closePanels();
  dispatch={state:'editing',caption:defaultCaption([...selection].map((id,index)=>sendState.last_number+index+1)),items:[...selection].map(id=>{const row=listing.drafts.find(d=>d.version_id===id);return {version_id:id,submission_id:row?.id,text:row?.text,layout:row?.layout};})};dispatchDirty=true;showDispatch();$('#dispatch-editor').scrollIntoView({behavior:'smooth'});say('請確認順序並填寫貼文說明。');
}));
$('#caption').addEventListener('input',()=>{if(dispatch){dispatch.caption=$('#caption').value;dispatchDirty=true;sync();}});
$('#save-dispatch').addEventListener('click',()=>run(async()=>{
  await saveDispatch();closePanels();selection.clear();tab='ready';await reload();
  say('本次發送已保存，未發布到 IG。');
}));
$('#download-dispatch').addEventListener('click',()=>run(async()=>{
  if(dispatchDirty||!dispatch.id)await saveDispatch();
  if(dispatch.state==='editing')sendState=await request('/send/prepare',{method:'POST',body:{revision:sendState.revision}});
  dispatch=structuredClone(sendState.batch);showDispatch();
  if(!assets)await ensureAssets();
  for(const item of dispatch.items.filter(i=>!i.confirmed&&!i.object_key)){
    const layout=structuredClone(item.layout);layout.number.label=String(item.number);
    const png=await exportPng(assets,{id:item.submission_id,text:item.text,layout});
    const response=await fetch(base+'/send/image',{method:'POST',credentials:'include',headers:{...adminAuth.requestHeaders({mutation:true}),'Content-Type':'image/png','If-Match':String(sendState.revision),'X-Send-Generation':sendState.batch.generation,'X-Send-Position':String(item.position)},body:png});
    const payload=await response.json();if(!response.ok)throw new Error(payload.error?.message??'產圖保存失敗；可重新載入後重試，不會占號。');sendState=payload.data;
  }
  dispatch=structuredClone(sendState.batch);showDispatch();
  const files=[];
  for(const item of dispatch.items.filter(i=>!i.confirmed))files.push([`${String(item.position+1).padStart(2,'0')}-daan-${item.number}.png`,new Uint8Array(await (await finalBlob(item.number,dispatch.generation)).arrayBuffer())]);
  files.push(['caption.txt',dispatch.caption]);download(makeZip(files),`daan-dispatch-${dispatch.id}.zip`);say('已下載；未發送到 IG。');
}));
for(const command of ['reset','cancel'])$('#'+command+'-send').addEventListener('click',()=>run(async()=>{
  if(!confirm('若 IG 結果不確定，請先人工核對。繼續會使未發送項目的舊下載檔失效，必須重新產生並下載。確定？'))return;
  sendState=await request('/send/'+command,{method:'POST',body:{revision:sendState.revision}});closePanels();selection.clear();tab=command==='reset'?'current':'ready';await reload();say('已取消；已確認編號沒有回退。');
}));
$('#confirm-send').addEventListener('click',()=>run(async()=>{
  const remaining=dispatch.items.filter(i=>!i.confirmed),count=Number($('#confirm-count').value);
  if(!Number.isInteger(count)||count<1||count>remaining.length)throw new Error('請輸入有效的前 N 張數量。');
  if(!confirm(`確認已手動發送 #${remaining[0].number}–#${remaining[count-1].number}，共 ${count} 張？\n確認者：${$('#studio-identity').textContent}\n若 IG 結果不確定請取消並人工核對；確認後編號不可回退。`))return;
  sendState=await request('/send/confirm',{method:'POST',body:{revision:sendState.revision,count}});closePanels();selection.clear();tab='current';await reload();if(sendState.batch){dispatch=structuredClone(sendState.batch);showDispatch();}say(`已記錄人工確認，最後編號 #${sendState.last_number}。`);
}));
for(const id of ['close-editor','close-dispatch'])$('#'+id).addEventListener('click',()=>{if(!busy&&mayLeave())closePanels();});
$('#reload').addEventListener('click',()=>run(async()=>{if(!mayLeave())return;closePanels();await reload();}));
document.querySelectorAll('[data-tab]').forEach(el=>el.addEventListener('click',()=>run(()=>{if(!mayLeave())return;closePanels();tab=el.dataset.tab;renderGallery();say('');})));
await run(async()=>{
  const session=await apiRequest('/api/auth/me',{headers:adminAuth.requestHeaders()});adminAuth.setSession(session);
  const user=adminAuth.identity();$('#studio-identity').textContent=`${user?.accessEmail??user?.username??'管理員'} · ${user?.role??''}`;
  await reload();
});
