// Keep files in memory only. A generation prevents an abandoned request from
// repopulating the panel after navigation or another preparation.
export function createImageShare(){
 let files=[],generation=0;
 return {
  clear(){generation++;files=[];},
  files(){return [...files];},
  async prepare(items,load){
   this.clear();const expected=generation,next=[];
   if(!items.length||items.length>10)throw new Error('請選擇 1–10 張最終圖片。');
   for(const item of items){
    const blob=await load(item);
    if(blob.type!=='image/png')throw new Error('圖片格式不正確，請重新準備。');
    next.push(new File([blob],`daan-${item.number}.png`,{type:'image/png'}));
   }
   if(expected!==generation)return false;
   files=next;return true;
  },
  supported(nav= navigator){try{return files.length>0&&typeof nav.share==='function'&&typeof nav.canShare==='function'&&nav.canShare({files:[...files]});}catch{return false;}},
  // Deliberately no await before invoking share: call from a fresh click.
  share(nav=navigator){
   if(!this.supported(nav))return Promise.reject(new Error('此瀏覽器不支援這組圖片分享，請逐張分享或下載。'));
   try{return Promise.resolve(nav.share({files:[...files]}));}catch(error){return Promise.reject(error);}
  }
 };
}
