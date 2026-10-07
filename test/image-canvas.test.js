import test from 'node:test';
import assert from 'node:assert/strict';
import {paint,measureDocument} from '../frontend/admin/studio/canvas.js';
import {defaultLayout} from '../frontend/admin/studio/model.js';

// Canvas boundary fixture: models the documented WebKit complex-text bug,
// where fillText(center) paints emoji runs as left-aligned. Not an iOS emulator.
function canvasContext({overhang=0}={}){
 const draws=[];
 const width=text=>[...new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(text)].length*40;
 return {draws,textAlign:'start',clearRect(){},drawImage(){},setLineDash(){},strokeRect(){},
  measureText(text){
   const w=width(text),offset=this.textAlign==='center'?w/2:0;
   return {width:w,actualBoundingBoxLeft:offset+overhang,actualBoundingBoxRight:w-offset+overhang,actualBoundingBoxAscent:30,actualBoundingBoxDescent:10};
  },
  fillText(text,x,y){
   const w=width(text),broken=/\p{Extended_Pictographic}/u.test(text);
   const left=this.textAlign==='center'&&!broken?x-w/2:x;
   draws.push({text,left,right:left+w,center:left+w/2,y,align:this.textAlign});
  }
 };
}

test('emoji text is centered even when native Canvas center alignment is broken',()=>{
 const ctx=canvasContext(),doc={id:1,text:'中文🗣️',layout:defaultLayout()};
 const before=structuredClone(doc);
 const result=paint(ctx,{background:{}},doc,{selected:'body'});
 assert.equal(ctx.draws[0].center,540);
 assert.equal(ctx.draws[0].left,480);
 assert.equal(ctx.draws[0].y,675);
 assert.equal(result.body.x+result.body.width/2,540);
 assert.deepEqual(result.errors,[]);
 assert.deepEqual(doc,before);
});

test('each mixed-script line and the number retain independent centers',()=>{
 const ctx=canvasContext(),layout=defaultLayout();layout.body.x=600;
 const result=paint(ctx,{background:{}},{id:1,text:'中文🗣️\nHi\n👨‍👩‍👧‍👦👍🏽\ne\u0301❤️',layout});
 assert.deepEqual(ctx.draws.map(d=>d.center),[600,600,600,600,540]);
 assert.deepEqual(ctx.draws.map(d=>d.left),[540,560,560,560,460]);
 assert.equal(ctx.draws.at(-1).y,385);
 assert.deepEqual(result.errors,[]);
});

test('automatic wrapping preserves whole emoji and centers short trailing lines',()=>{
 const ctx=canvasContext();
 const result=paint(ctx,{background:{}},{id:1,text:'🗣️'.repeat(17),layout:defaultLayout()});
 assert.deepEqual(result.body.lines,['🗣️'.repeat(16),'🗣️']);
 assert.deepEqual(ctx.draws.slice(0,2).map(d=>d.center),[540,540]);
 assert.deepEqual(ctx.draws.slice(0,2).map(d=>d.left),[220,520]);
 assert.deepEqual(result.errors,[]);
});

test('left-anchored ink overhangs remain included in hit-test and safety bounds',()=>{
 const ctx=canvasContext({overhang:7}),layout=defaultLayout();
 const result=measureDocument(ctx,{id:1,text:'中文🗣️',layout});
 assert.equal(result.body.x,473);
 assert.equal(result.body.width,134);
 layout.body.x=245;
 assert.ok(measureDocument(ctx,{id:1,text:'中文🗣️',layout}).errors.includes('文字超出白紙安全區，請移動或縮小。'));
 layout.body.x=540;layout.body.y=385;
 assert.ok(measureDocument(ctx,{id:1,text:'中文🗣️',layout}).errors.includes('正文與編號重疊，請移開。'));
});

test('blank lines keep vertical spacing and normal text retains its original center',()=>{
 const ctx=canvasContext();
 const result=paint(ctx,{background:{}},{id:1,text:'AB\n\n中文',layout:defaultLayout()});
 assert.deepEqual(ctx.draws.slice(0,3).map(d=>d.y),[584,675,766]);
 assert.deepEqual(ctx.draws.slice(0,3).map(d=>d.center),[540,540,540]);
 assert.deepEqual(result.errors,[]);
});
