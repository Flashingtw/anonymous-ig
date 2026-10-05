import {apiRequest} from '../../assets/api.js';
import {adminAuth} from '../../assets/admin-auth.js';
import {scheduledCaption} from './caption.js';
import {graphemeLength} from '../../assets/graphemes.js';

export function mountCaptionEditor({onSaved,say}){
 const dialog=document.createElement('dialog');dialog.id='ig-caption-editor';dialog.className='studio-paper';
 dialog.setAttribute('aria-labelledby','ig-caption-title');
 dialog.innerHTML=`<div class="caption-edit-body"><h2 id="ig-caption-title">修改內文</h2>
 <p id="ig-caption-time"></p>
 <p>只更新內文，不改圖片、編號、順序或發送時間。已準備的 Meta 容器會重新建立。</p>
 <details><summary>目前已保存的內文</summary><pre id="ig-caption-original"></pre></details>
 <p id="ig-caption-legacy" hidden>無法辨識舊模板，原文已完整放入自訂文字。請整理後核對預覽，避免重複的日期或編號。</p>
 <label for="ig-caption-custom">自訂文字（放在 🔒 上方）</label>
 <textarea id="ig-caption-custom" rows="4"></textarea>
 <label id="ig-caption-ack-label" hidden><input id="ig-caption-ack" type="checkbox">我已核對舊內文與下方預覽</label>
 <label for="ig-caption-preview">完整內文預覽</label><textarea id="ig-caption-preview" rows="10" readonly></textarea>
 <p id="ig-caption-count" aria-live="polite"></p><p id="ig-caption-error" role="alert"></p></div>
 <div class="studio-actions"><button type="button" id="ig-caption-save">保存內文</button><button type="button" id="ig-caption-reload">重新載入</button><button type="button" id="ig-caption-cancel">取消</button></div>`;
 document.body.append(dialog);
 const el=id=>dialog.querySelector('#ig-caption-'+id),input=el('custom'),save=el('save'),ack=el('ack');
 let model=null,id=null,busy=false,original='';
 const dirty=()=>model&&input.value!==original;
 function sync(){
  const preview=model?scheduledCaption(input.value,model.numbers,model.publishAt):'';
  el('preview').value=preview;const count=graphemeLength(preview);el('count').textContent=`${count} / 2000 字（含模板）`;
  save.disabled=busy||!model||count>2000||(!model.recognized&&!ack.checked);
  input.disabled=busy||!model;ack.disabled=busy;el('reload').disabled=busy;el('cancel').disabled=busy;
 }
 async function load(){
  busy=true;model=null;el('error').textContent='';sync();
  try{
   model=await apiRequest(`/api/admin/instagram/batches/${encodeURIComponent(id)}/caption`,{headers:adminAuth.requestHeaders()});
   original=model.customText;input.value=original;el('original').textContent=model.caption;
   el('time').textContent=`#${model.numbers[0]}–#${model.numbers.at(-1)} · 排程：${new Date(model.publishAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})}（台灣時間）`;
   el('legacy').hidden=model.recognized;el('ack-label').hidden=model.recognized;ack.checked=false;
  }catch(error){el('error').textContent=error.message??'內文讀取失敗，請重試。';}
  finally{busy=false;sync();if(model)input.focus();}
 }
 function close(){if(busy)return;if(dirty()&&!confirm('放棄尚未保存的內文修改？'))return;dialog.close();model=null;}
 dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
 el('cancel').addEventListener('click',close);
 input.addEventListener('input',sync);ack.addEventListener('change',sync);
 el('reload').addEventListener('click',()=>{if(dirty()&&!confirm('重新載入會放棄目前尚未保存的文字，繼續？'))return;void load();});
 window.addEventListener('beforeunload',event=>{if(dialog.open&&dirty()){event.preventDefault();event.returnValue='';}});
 save.addEventListener('click',async()=>{
  if(save.disabled)return;
  busy=true;el('error').textContent='';sync();
  let result;
  try{
   result=await apiRequest(`/api/admin/instagram/batches/${encodeURIComponent(id)}/caption`,{method:'POST',headers:{...adminAuth.requestHeaders({mutation:true}),'Content-Type':'application/json'},body:JSON.stringify({revision:model.revision,customText:input.value})});
  }catch(error){el('error').textContent=error.message??'保存失敗，文字仍保留，請重試。';busy=false;sync();return;}
  busy=false;model=null;dialog.close();
  try{await onSaved();say(result.publishStatus==='failed'?'內文已保存；仍為發布失敗，請另按「重試整包」。':'內文已保存，將依排程以新內文重新準備 Meta 圖片。');}
  catch{say('內文已保存，但狀態讀取失敗，請更新發布狀態。');}
 });
 return async batchId=>{if(dialog.open||busy)return;id=batchId;input.value='';el('original').textContent='';el('time').textContent='';el('legacy').hidden=true;el('ack-label').hidden=true;dialog.showModal();await load();};
}
