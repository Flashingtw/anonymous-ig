import {WIDTH,HEIGHT} from './model.js';
import {paint,autoLayout,exportPng} from './canvas.js';

// A separate, geometry-only editor. It cannot change locked text or identities.
export function openLayoutRepair({item,assets,save}){
 const doc={id:item.submission_id,text:item.text,layout:structuredClone(item.layout)};
 doc.layout.number.label=String(item.number);
 const dialog=document.createElement('dialog');dialog.className='layout-repair studio-paper';
 const title=document.createElement('h2');title.textContent=`修復排版 · #${item.number}`;
 const intro=document.createElement('p');intro.textContent='只調整位置與字級；文字、編號、順序及排程保持不變。';
 const grid=document.createElement('div');grid.className='editor-grid';
 const canvas=document.createElement('canvas');canvas.width=WIDTH;canvas.height=HEIGHT;canvas.setAttribute('aria-label','修復排版預覽');
 const wrap=document.createElement('div');wrap.className='canvas-wrap';wrap.append(canvas);
 const controls=document.createElement('div');controls.className='editor-controls';
 const status=document.createElement('p');status.setAttribute('role','status');status.className='repair-status';
 const fields=[];let saving=false,changed=false;
 for(const [key,name]of [['body','正文'],['number','編號']]){
  const heading=document.createElement('h3');heading.textContent=name;controls.append(heading);
  for(const [prop,label,min,max]of [['size','字級',24,120],['x','水平位置',0,WIDTH],['y','垂直位置',0,HEIGHT]]){
   const field=document.createElement('label'),input=document.createElement('input');input.type='number';input.min=min;input.max=max;input.step=1;input.value=doc.layout[key][prop];input.setAttribute('aria-label',`${name}${label}`);
   input.addEventListener('input',()=>{doc.layout[key][prop]=input.valueAsNumber;changed=true;render();});field.append(document.createTextNode(label),input);controls.append(field);fields.push({key,prop,input});
  }
 }
 const actions=document.createElement('div');actions.className='studio-actions';
 const auto=document.createElement('button');auto.type='button';auto.textContent='自動排版';auto.addEventListener('click',()=>{doc.layout=autoLayout(canvas.getContext('2d'),doc);changed=true;fields.forEach(f=>f.input.value=doc.layout[f.key][f.prop]);render();});
 const submit=document.createElement('button');submit.type='button';submit.textContent='保存修復';
 const cancel=document.createElement('button');cancel.type='button';cancel.textContent='關閉';
 const close=()=>{if(!saving&&(!changed||confirm('捨棄尚未保存的排版修復？')))dialog.close();};
 cancel.addEventListener('click',close);dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
 dialog.addEventListener('close',()=>dialog.remove());
 const beforeUnload=event=>{if(changed){event.preventDefault();event.returnValue='';}};
 window.addEventListener('beforeunload',beforeUnload);dialog.addEventListener('close',()=>window.removeEventListener('beforeunload',beforeUnload));
 submit.addEventListener('click',async()=>{
  if(saving)return;saving=true;fields.forEach(f=>f.input.disabled=true);auto.disabled=cancel.disabled=submit.disabled=true;status.textContent='保存中⋯';
  try{
   // Verify the same font/layout/export path before persisting any repair.
   await exportPng(assets,doc);
   const geometry=Object.fromEntries(['body','number'].map(key=>[key,{x:doc.layout[key].x,y:doc.layout[key].y,size:doc.layout[key].size}]));
   await save(geometry);changed=false;dialog.close();
  }catch(error){status.textContent=error.message??'保存失敗，請重試。';}
  finally{saving=false;fields.forEach(f=>f.input.disabled=false);auto.disabled=cancel.disabled=false;submit.disabled=paint(canvas.getContext('2d'),assets,doc).errors.length>0;}
 });
 actions.append(auto,submit,cancel);controls.append(status);grid.append(wrap,controls);dialog.append(title,intro,actions,grid);document.body.append(dialog);
 function render(){const result=paint(canvas.getContext('2d'),assets,doc);status.textContent=result.errors.join(' ');submit.disabled=result.errors.length>0||saving;}
 dialog.showModal();render();auto.focus();return dialog;
}
