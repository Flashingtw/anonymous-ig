import {graphemeLength} from '../../assets/graphemes.js';
export const WIDTH=1080, HEIGHT=1350;
export const SAFE={x:180,y:270,width:720,height:710};
export const defaultLayout=()=>({body:{x:WIDTH/2,y:HEIGHT/2,size:70},number:{x:540,y:385,size:40,label:'109'}});
export const numberLabel=doc=>doc.layout.number.label??String(doc.id);
export function validDocument(text,layout){
  if(typeof text!=='string'||!text.trim()||graphemeLength(text)>1000) return false;
  if(!layout||Object.keys(layout).sort().join()!=='body,number') return false;
  return ['body','number'].every(key=>{
    const box=layout[key];
    return box&&['size,x,y',...(key==='number'?['label,size,x,y']:[])].includes(Object.keys(box).sort().join())&&
      (box.label===undefined||typeof box.label==='string'&&/^[1-9][0-9]{0,5}$/.test(box.label))&&
      [box.x,box.y,box.size].every(Number.isFinite)&&box.size>=24&&box.size<=120&&
      box.x>=0&&box.x<=WIDTH&&box.y>=0&&box.y<=HEIGHT;
  });
}
export function validItems(items){
  return Array.isArray(items)&&items.length>=1&&items.length<=10&&
    items.every(id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id))&&new Set(items).size===items.length;
}
