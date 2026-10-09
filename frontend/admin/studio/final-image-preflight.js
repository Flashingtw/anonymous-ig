import {exportPng} from './canvas.js';
export async function preflightFinalImages(assets,items,firstNumber){
 // Render every candidate before the irreversible backend lock, including PNG
 // encoding/size checks. A failure cannot reserve a number or queue a post.
 for(const [index,item]of items.entries()){
  const layout=structuredClone(item.layout);layout.number.label=String(firstNumber+index);
  try{await exportPng(assets,{id:item.submission_id,text:item.text,layout});}
  catch(error){throw Error(`投稿 #${item.submission_id} 無法產圖：${error.message} 請先回圖片草稿調整；尚未鎖定編號。`);}
 }
}
