import {WIDTH,HEIGHT,SAFE,defaultLayout,validDocument,numberLabel} from './model.js';
export async function loadStudioAssets(){
  const faces=[new FontFace('StudioBody','url(/admin/studio/assets/CanvaBeautifulTC-Regular.woff2)'),new FontFace('StudioNumber','url(/admin/studio/assets/Anton-Regular.ttf)')];
  await Promise.all(faces.map(async face=>{await face.load();document.fonts.add(face);}));
  const background=new Image();background.src='/admin/studio/assets/DAAN-anonymous.png';await background.decode();
  if(background.naturalWidth!==WIDTH||background.naturalHeight!==HEIGHT)throw new Error('底圖尺寸必須為 1080×1350。');
  return {background};
}
const segments=text=>[...new Intl.Segmenter('zh-Hant',{granularity:'grapheme'}).segment(text)].map(s=>s.segment);
export function wrapText(text,measure,maxWidth=650){
  const lines=[];
  for(const paragraph of text.split('\n')){
    let line='';for(const unit of segments(paragraph)){if(line&&measure(line+unit)>maxWidth){lines.push(line);line='';}line+=unit;}lines.push(line);
  }
  return lines;
}
function textBox(ctx,text,box,family,wrap){
  ctx.font=`${box.size}px ${family}`;
  ctx.textAlign='center';ctx.textBaseline='middle';
  const lines=wrap?wrapText(text,t=>ctx.measureText(t).width):[text];
  const lineHeight=box.size*1.3;
  const width=Math.max(1,...lines.map(t=>ctx.measureText(t).width));
  const height=lines.length*lineHeight;
  const drawY=box.y-height/2;
  let left=box.x-width/2,right=box.x+width/2,top=drawY,bottom=drawY+height;
  lines.forEach((line,index)=>{
    const m=ctx.measureText(line),baseline=drawY+lineHeight*(index+.5);
    left=Math.min(left,box.x-(m.actualBoundingBoxLeft??0));right=Math.max(right,box.x+(m.actualBoundingBoxRight??0));
    top=Math.min(top,baseline-(m.actualBoundingBoxAscent??0));bottom=Math.max(bottom,baseline+(m.actualBoundingBoxDescent??0));
  });
  return {x:left,y:top,width:right-left,height:bottom-top,drawY,lines,lineHeight,family,size:box.size,cx:box.x,cy:box.y};
}
const inside=r=>r.x>=SAFE.x&&r.y>=SAFE.y&&r.x+r.width<=SAFE.x+SAFE.width&&r.y+r.height<=SAFE.y+SAFE.height;
const overlaps=(a,b)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
export function measureDocument(ctx,doc){
  const body=textBox(ctx,doc.text,doc.layout.body,'StudioBody',true);
  const number=textBox(ctx,`#${numberLabel(doc).padStart(3,'0')}`,doc.layout.number,'StudioNumber',false);
  const errors=[];
  if(!validDocument(doc.text,doc.layout))errors.push('正文須為 1–1000 字，字級為 24–120。');
  if(doc.layout.number.label!==undefined&&!/^[1-9][0-9]{0,5}$/.test(doc.layout.number.label))errors.push('圖片編號須為 1–999999 的整數。');
  if(!inside(body)||!inside(number))errors.push('文字超出白紙安全區，請移動或縮小。');
  if(overlaps(body,number))errors.push('正文與編號重疊，請移開。');
  return {body,number,errors};
}
export function autoLayout(ctx,doc){
  const layout=defaultLayout();
  if(doc.layout.number.label===undefined)delete layout.number.label;
  else layout.number.label=doc.layout.number.label;
  for(let size=70;size>=24;size-=2){layout.body.size=size;if(!measureDocument(ctx,{...doc,layout}).errors.length)break;}
  return layout;
}
export function paint(ctx,assets,doc,{selected=null}={}){
  ctx.clearRect(0,0,WIDTH,HEIGHT);ctx.drawImage(assets.background,0,0,WIDTH,HEIGHT);
  const result=measureDocument(ctx,doc);
  for(const key of ['body','number']){
    const box=result[key];ctx.fillStyle='#111';ctx.font=`${box.size}px ${box.family}`;ctx.textAlign='center';ctx.textBaseline='middle';
    box.lines.forEach((line,index)=>ctx.fillText(line,box.cx,box.drawY+box.lineHeight*(index+.5)));
    if(selected===key){ctx.strokeStyle='#c95421';ctx.lineWidth=3;ctx.setLineDash([8,5]);ctx.strokeRect(box.x-6,box.y-6,box.width+12,box.height+12);ctx.setLineDash([]);}
  }
  return result;
}
export async function exportPng(assets,doc){
  const canvas=document.createElement('canvas');canvas.width=WIDTH;canvas.height=HEIGHT;
  const result=paint(canvas.getContext('2d'),assets,doc);
  if(result.errors.length)throw new Error(result.errors.join(' '));
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  if(!blob||blob.size>8*1024*1024)throw new Error('圖片輸出失敗或超過 8 MiB。');return blob;
}
