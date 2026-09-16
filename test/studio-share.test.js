import test from 'node:test';
import assert from 'node:assert/strict';
import {createImageShare} from '../frontend/admin/studio/share.js';
const png=number=>new Blob([new Uint8Array([137,80,78,71,number])],{type:'image/png'});
test('share uses ordered final PNG files only, preserving bytes and names',async()=>{
 const share=createImageShare();await share.prepare([{number:111},{number:109}],i=>png(i.number));
 assert.deepEqual(share.files().map(f=>f.name),['daan-111.png','daan-109.png']);
 for(const [index,n]of [111,109].entries())assert.deepEqual(await share.files()[index].arrayBuffer(),await png(n).arrayBuffer());
 let invoked=false;
 const nav={canShare:({files})=>files.length===2,share:payload=>{invoked=true;assert.deepEqual(Object.keys(payload),['files']);return Promise.resolve();}};
 const operation=share.share(nav);assert.equal(invoked,true);await operation;
 share.clear();assert.deepEqual(share.files(),[]);assert.equal(share.supported(nav),false);
});
test('unsupported sharing and rejected file groups allow download fallback',async()=>{
 const share=createImageShare();await share.prepare([{number:109},{number:110}],i=>png(i.number));
 for(const nav of [{},{share(){}},{share(){},canShare(){return false;}},{share(){},canShare(){throw Error();}}])assert.equal(share.supported(nav),false);
 await assert.rejects(()=>share.share({}));assert.equal(share.files().length,2);
 await share.prepare([{number:109}],i=>png(i.number));assert.equal(share.supported({share(){},canShare:({files})=>files.length===1}),true);
});
test('cancellation and failure keep files retryable without reporting success',async()=>{
 const share=createImageShare();await share.prepare([{number:109}],i=>png(i.number));
 for(const name of ['AbortError','NotAllowedError'])await assert.rejects(()=>share.share({canShare:()=>true,share(){throw new DOMException('test',name);}}),e=>e.name===name);
 assert.equal(share.files().length,1);await share.share({canShare:()=>true,share:()=>Promise.resolve()});
});
test('failed downloads never expose partial files; navigation invalidates pending preparation',async()=>{
 const share=createImageShare();await assert.rejects(()=>share.prepare([{number:109},{number:110}],i=>{if(i.number===110)throw Error('network');return png(i.number);}));assert.deepEqual(share.files(),[]);
 await assert.rejects(()=>share.prepare([{number:109}],()=>new Blob(['login'],{type:'text/html'})));assert.deepEqual(share.files(),[]);
 let finish;const pending=share.prepare([{number:109}],()=>new Promise(r=>{finish=r;}));share.clear();finish(png(109));assert.equal(await pending,false);assert.deepEqual(share.files(),[]);
 for(const items of [[],Array.from({length:11},()=>({number:109}))])await assert.rejects(()=>share.prepare(items,i=>png(i.number)));
});
