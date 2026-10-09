import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createTestDatabase} from './helpers/d1.js';
import {currentSend,changeSend,attachFinal} from '../worker/src/repositories/current-send.js';
import {repairLayout} from '../worker/src/repositories/layout-repairs.js';
import {defaultLayout} from '../frontend/admin/studio/model.js';

const principal={adminId:1,role:'moderator'};
function fixture(){
 const f=createTestDatabase({images:true,singleSend:true,studioDelete:true});
 for(const name of ['0010_instagram_publish_queue','0011_multiple_send_batches','0012_automatic_locked_batches','0013_instagram_preparation','0014_instagram_caption_edits'])f.raw.exec(readFileSync(new URL(`../migrations/${name}.sql`,import.meta.url),'utf8'));
 f.raw.exec("INSERT INTO admins(id,access_email,role) VALUES(1,'mod@example.test','moderator'); INSERT INTO submissions(id,content,status) VALUES(1,'original','approved'),(2,'original2','approved')");
 const versions=[];
 for(let id=1;id<=2;id++){const version=crypto.randomUUID();versions.push(version);const layout=defaultLayout();layout.body.size=44;
  f.raw.prepare("INSERT INTO image_drafts(id,text,layout,state) VALUES(?,?,?,'ready')").run(id,'文字\n'.repeat(9)+'文字',JSON.stringify(layout));
  f.raw.prepare('INSERT INTO image_versions(id,draft_id,draft_revision,object_key,text,layout) SELECT ?,id,1,?,text,layout FROM image_drafts WHERE id=?').run(version,'source'+id,id);
 }
 const command=async(command,body)=>changeSend(f.DB,command,{revision:(await currentSend(f.DB)).revision,...body},principal);
 const lock=async()=>{const state=await command('save',{batchId:null,items:versions,caption:'keep caption'});return (await command('prepare',{batchId:state.batch.id,publishAt:'2030-01-01T00:00:00Z'})).batch;};
 const migrate=()=>f.raw.exec(readFileSync(new URL('../migrations/0015_send_layout_repairs.sql',import.meta.url),'utf8'));
 const repair=async(batch,extra={})=>repairLayout(f.DB,{batchId:batch.id,generation:batch.generation,position:0,revision:(await currentSend(f.DB)).revision,layout:{body:{x:540,y:675,size:40},number:{x:540,y:385,size:40}},...extra},principal);
 return {...f,lock,migrate,repair};
}
test('0015 preserves old locked batches; repair overlays geometry without unlocking snapshots or advancing numbers',async t=>{
 const f=fixture();t.after(()=>f.close());const batch=await f.lock();
 const tables=['admins','submissions','image_drafts','image_versions','send_batches','send_items','send_progress','instagram_queue','audit_logs'];
 const before=tables.map(name=>f.raw.prepare(`SELECT * FROM ${name}`).all());f.migrate();assert.deepEqual(tables.map(name=>f.raw.prepare(`SELECT * FROM ${name}`).all()),before);
 const state=await currentSend(f.DB,batch.id);assert.equal(state.batch.items[0].can_repair_layout,true);
 await f.repair(batch);const after=await currentSend(f.DB,batch.id);
 assert.equal(after.batch.items[0].layout.body.size,40);assert.equal(after.batch.items[0].layout.number.label,'109');assert.equal(after.revision,state.revision+1);
 assert.equal(after.next_number,111);assert.equal(after.last_number,108);
 assert.deepEqual(f.raw.prepare('SELECT * FROM send_batches').all(),before[4]);assert.deepEqual(f.raw.prepare('SELECT * FROM send_items').all(),before[5]);assert.deepEqual(f.raw.prepare('SELECT * FROM instagram_queue').all(),before[7]);
 assert.equal(f.raw.prepare("SELECT count(*) n FROM audit_logs WHERE action='send_layout_repaired'").get().n,1);
 assert.throws(()=>f.raw.exec('UPDATE send_items SET layout=\'{}\''),/LOCKED/);
 assert.throws(()=>f.raw.exec('DELETE FROM send_layout_repairs'),/HISTORY_LOCKED/);
 assert.throws(()=>f.raw.exec('UPDATE send_layout_repairs SET layout=\'{}\''),/HISTORY_LOCKED/);
 assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('repair validates geometry, refuses text/number changes, stale revisions and stale generations',async t=>{
 const f=fixture();t.after(()=>f.close());const batch=await f.lock();f.migrate();const revision=(await currentSend(f.DB)).revision;
 for(const layout of [{}, {body:{x:540,y:675,size:0},number:{x:540,y:385,size:40}}, {body:{x:540,y:675,size:40,text:'changed'},number:{x:540,y:385,size:40}}, {body:{x:540,y:675,size:40},number:{x:540,y:385,size:40,label:'999'}}])await assert.rejects(()=>f.repair(batch,{layout}),e=>e.status===400);
 await assert.rejects(()=>f.repair(batch,{generation:crypto.randomUUID()}),e=>e.status===409);
 await f.repair(batch);await assert.rejects(()=>f.repair(batch,{revision}),e=>e.status===409);
 const latest=(await currentSend(f.DB,batch.id)).batch;await f.repair(latest,{layout:{body:{x:540,y:675,size:38},number:{x:540,y:385,size:40}}});assert.equal((await currentSend(f.DB,batch.id)).batch.items[0].layout.body.size,38);
});
test('repair refuses completed PNGs, staged IG images, queued/started work and disabled admins',async t=>{
 for(const block of ['png','staged','upload','queued','started','disabled'])await t.test(block,async()=>{
  const f=fixture();const batch=await f.lock();f.migrate();
  try{
   if(block==='png')await attachFinal(f.DB,{revision:(await currentSend(f.DB)).revision,generation:batch.generation,position:0,key:'final'},principal);
   if(block==='staged')f.raw.prepare('INSERT INTO instagram_items(batch_id,position,submission_id,number,published_image_key,source_png_key,image_token) VALUES(?,?,?,?,?,?,?)').run(batch.id,1,2,110,'jpg','png','opaque');
   if(block==='upload'){f.raw.exec("INSERT INTO send_uploads VALUES('jpg','2099-01-01')");f.raw.prepare('INSERT INTO instagram_uploads VALUES(?,?,?,?,?,?)').run('upload',batch.id,batch.generation,1,'png','jpg');}
   if(block==='queued')f.raw.exec("UPDATE instagram_queue SET publish_status='pending'");
   if(block==='started')f.raw.exec('UPDATE instagram_queue SET publish_started=1');
   if(block==='disabled')f.raw.exec('UPDATE admins SET enabled=0');
   await assert.rejects(()=>f.repair(batch),e=>e.status===409);assert.equal(f.raw.prepare('SELECT count(*) n FROM send_layout_repairs').get().n,0);
   if(block!=='disabled')assert.equal((await currentSend(f.DB,batch.id)).batch.items[0].can_repair_layout,false);
  }finally{f.close();}
 });
});
test('repair atomic CAS and audit failure roll back; owner/admin/moderator may repair',async t=>{
 const f=fixture();t.after(()=>f.close());const batch=await f.lock();f.migrate();const revision=(await currentSend(f.DB)).revision;
 const results=await Promise.allSettled([f.repair(batch,{revision}),f.repair(batch,{revision})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const before=(await currentSend(f.DB)).revision;f.raw.exec("CREATE TRIGGER fail_repair BEFORE INSERT ON audit_logs WHEN NEW.action='send_layout_repaired' BEGIN SELECT RAISE(ABORT,'audit failure'); END");
 await assert.rejects(()=>f.repair(batch));assert.equal((await currentSend(f.DB)).revision,before);assert.equal(f.raw.prepare('SELECT count(*) n FROM send_layout_repairs').get().n,1);f.raw.exec('DROP TRIGGER fail_repair');
 f.raw.exec("INSERT INTO admins(access_email,role) VALUES('owner@example.test','owner')");
 for(const role of ['owner','admin','moderator']){f.raw.prepare('UPDATE admins SET role=? WHERE id=1').run(role);await f.repair(batch);}
});
test('0015 repair view/guards and audit are compatible with actual workerd D1',async t=>{
 const {Miniflare,convertV4MiniflareOptions}=await import('miniflare');
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("isolated")}}',compatibilityDate:'2026-08-31',d1Databases:['DB']}));t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
 for(const name of ['0001_create_submissions','0002_create_admin_auth','0004_add_local_admin_auth','0005_add_access_email','0006_access_only_admins','0007_image_drafts','0008_single_dispatch','0009_studio_removals','0010_instagram_publish_queue','0011_multiple_send_batches','0012_automatic_locked_batches','0013_instagram_preparation','0014_instagram_caption_edits','0015_send_layout_repairs'])await db.exec(readFileSync(new URL(`../migrations/${name}.sql`,import.meta.url),'utf8').replace(/^--.*$/gm,'').replace(/[\r\n]/g,' '));
 const layout=JSON.stringify(defaultLayout()),version=crypto.randomUUID();
 await db.prepare("INSERT INTO admins(id,access_email,role) VALUES(1,'mod@example.test','moderator')").run();await db.prepare("INSERT INTO submissions(id,content,status) VALUES(1,'original','approved')").run();await db.prepare("INSERT INTO image_drafts(id,text,layout,state) VALUES(1,'copy',?,'ready')").bind(layout).run();await db.prepare("INSERT INTO image_versions(id,draft_id,draft_revision,object_key,text,layout) VALUES(?,1,1,'source','copy',?)").bind(version,layout).run();
 let state=await changeSend(db,'save',{revision:1,batchId:null,items:[version],caption:''},principal);state=await changeSend(db,'prepare',{revision:state.revision,batchId:state.batch.id,publishAt:'2030-01-01T00:00:00Z'},principal);
 const body={batchId:state.batch.id,generation:state.batch.generation,revision:state.revision,position:0,layout:{body:{x:540,y:675,size:40},number:{x:540,y:385,size:40}}};
 await repairLayout(db,body,principal);assert.equal((await currentSend(db)).batch.items[0].layout.body.size,40);await assert.rejects(()=>repairLayout(db,body,principal),e=>e.status===409);
 const before=(await currentSend(db)).revision;await db.exec("CREATE TRIGGER fail_repair BEFORE INSERT ON audit_logs WHEN NEW.action='send_layout_repaired' BEGIN SELECT RAISE(ABORT,'audit failure'); END");await assert.rejects(()=>repairLayout(db,{...body,revision:before},principal));assert.equal((await currentSend(db)).revision,before);assert.equal(await db.prepare('SELECT count(*) n FROM send_layout_repairs').first('n'),1);assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
});
