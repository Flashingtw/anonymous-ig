import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createTestDatabase} from './helpers/d1.js';
import {currentSend,changeSend,attachFinal} from '../worker/src/repositories/current-send.js';
import {stageInstagramImage,scheduleInstagram,editInstagram,processInstagramQueue} from '../worker/src/repositories/instagram-queue.js';
import {defaultLayout} from '../frontend/admin/studio/model.js';
import {defaultCaption} from '../frontend/admin/studio/caption.js';
import {InstagramError} from '../worker/src/services/instagram.js';
const principal={adminId:1,role:'moderator'},time='2030-01-01T00:00:00.000Z';
function fixture(){
 const f=createTestDatabase({images:true,singleSend:true,studioDelete:true});
 for(const migration of ['0010_instagram_publish_queue','0011_multiple_send_batches','0012_automatic_locked_batches','0013_instagram_preparation','0014_instagram_caption_edits'])f.raw.exec(readFileSync(new URL(`../migrations/${migration}.sql`,import.meta.url),'utf8'));
 f.raw.exec("INSERT INTO admins(id,access_email,role) VALUES(1,'mod@example.test','moderator')");
 const versions=[];
 for(let id=1;id<=4;id++){const version=crypto.randomUUID();versions.push(version);f.raw.prepare("INSERT INTO submissions(id,content,status) VALUES(?,'original','approved')").run(id);f.raw.prepare("INSERT INTO image_drafts(id,text,layout,state) VALUES(?,'copy',?,'ready')").run(id,JSON.stringify(defaultLayout()));f.raw.prepare("INSERT INTO image_versions(id,draft_id,draft_revision,object_key,text,layout) VALUES(?,?,1,?,'copy',?)").run(version,id,'source'+id,JSON.stringify(defaultLayout()));}
 const command=async(command,body)=>changeSend(f.DB,command,{revision:(await currentSend(f.DB)).revision,...body},principal);
 const save=async(items)=> (await command('save',{batchId:null,caption:defaultCaption([109]),items})).batch.id;
 const lock=async id=>(await command('prepare',{batchId:id,publishAt:time})).batch;
 const upload=async id=>{let state=await currentSend(f.DB,id);for(const item of state.batch.items){state=await attachFinal(f.DB,{revision:state.revision,generation:state.batch.generation,position:item.position,key:crypto.randomUUID()},principal);}const uploads=[];for(const item of state.batch.items){const key=crypto.randomUUID();await f.DB.prepare('INSERT INTO send_uploads VALUES(?,?)').bind(key,'2099-01-01').run();uploads.push(await stageInstagramImage(f.DB,{id,generation:state.batch.generation,position:item.position,key}));}await scheduleInstagram(f.DB,{id,revision:state.revision,generation:state.batch.generation,publishAt:'2099-01-01',uploads},principal);};
 let published=0;const service={create:async()=>crypto.randomUUID(),createCarousel:async()=>crypto.randomUUID(),status:async()=> 'FINISHED',publish:async()=>String(++published)};
 const env={DB:f.DB,IG_PUBLISH_ENABLED:'true',IG_MEDIA_ORIGIN:'https://example.test'};
 return {...f,versions,command,save,lock,upload,env,service,published:()=>published};
}
test('multiple irreversible locks reserve contiguous numbers and freeze automatic caption/schedule',async t=>{
 const f=fixture();t.after(()=>f.close());const a=await f.save(f.versions.slice(0,2)),b=await f.save(f.versions.slice(2));
 assert.deepEqual((await f.lock(a)).items.map(i=>i.number),[109,110]);
 const batch=await f.lock(b);assert.deepEqual(batch.items.map(i=>i.number),[111,112]);assert.match(batch.caption,/#111\n#112/);
 assert.equal((await currentSend(f.DB)).last_number,108);assert.equal((await currentSend(f.DB)).next_number,113);
 for(const command of ['reset','cancel','confirm','save'])await assert.rejects(()=>f.command(command,{batchId:a,count:1,items:[f.versions[0]],caption:'bad'}));
 for(const sql of ["UPDATE send_batches SET state='cancelled' WHERE auto_publish=1","UPDATE send_batches SET caption='changed' WHERE auto_publish=1","UPDATE send_items SET number=999 WHERE number=109","DELETE FROM send_items WHERE number=109","UPDATE send_items SET confirmed=1 WHERE number=109"])assert.throws(()=>f.raw.exec(sql),/LOCKED/);
 await f.upload(a);await f.upload(b);
 assert.equal(f.raw.prepare('SELECT publish_at FROM instagram_queue WHERE batch_id=?').get(a).publish_at,time);
 const row=f.raw.prepare('SELECT * FROM instagram_queue WHERE batch_id=?').get(a);
 await assert.rejects(()=>editInstagram(f.DB,a,'cancel-publish',row.revision,principal));
 assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('automatic lock generates caption date from scheduled Taiwan day, retaining custom text above lock',async t=>{
 const f=fixture();t.after(()=>f.close());
 const old=defaultCaption([999],new Date('2026-10-05T00:00:00Z'));
 const state=await f.command('save',{batchId:null,caption:'本週公告\n第二行\n\n'+old,items:[f.versions[0]]});
 const batch=(await f.command('prepare',{batchId:state.batch.id,publishAt:'2026-10-05T16:30:00Z'})).batch;
 assert.equal(batch.caption,'本週公告\n第二行\n\n'+defaultCaption([109],new Date('2026-10-05T16:30:00Z')));
 assert.equal(f.raw.prepare('SELECT published_caption FROM instagram_queue').get().published_caption,batch.caption);
});

test('template length is checked before reserving numbers; locked captions remain immutable',async t=>{
 const f=fixture();t.after(()=>f.close());const state=await f.command('save',{batchId:null,caption:'文'.repeat(1999),items:[f.versions[0]]});
 await assert.rejects(()=>f.command('prepare',{batchId:state.batch.id,publishAt:time}),e=>e.status===400);
 assert.equal((await currentSend(f.DB)).next_number,109);assert.equal(f.raw.prepare('SELECT count(*) n FROM instagram_queue').get().n,0);
 await f.command('save',{batchId:state.batch.id,caption:'舊的自訂文字',items:[f.versions[0]]});await f.lock(state.batch.id);
 const snapshot=f.raw.prepare('SELECT published_caption FROM instagram_queue').get().published_caption;
 assert.match(snapshot,/^舊的自訂文字\n\n🔒/);
 await assert.rejects(()=>f.command('prepare',{batchId:state.batch.id,publishAt:'2040-01-01T00:00:00Z'}));
 assert.equal(f.raw.prepare('SELECT published_caption FROM instagram_queue').get().published_caption,snapshot);
});
test('incomplete head blocks later queued batches; success advances one whole batch per run',async t=>{
 const f=fixture();t.after(()=>f.close());const a=await f.save(f.versions.slice(0,2)),b=await f.save(f.versions.slice(2));await f.lock(a);await f.lock(b);await f.upload(b);
 const run=()=>processInstagramQueue(f.env,{now:new Date(time),service:f.service});
 assert.equal((await run()).status,'prepared');assert.equal(f.published(),0);
 assert.equal((await run()).status,'idle');assert.equal((await currentSend(f.DB)).last_number,108);
 await f.upload(a);assert.equal((await run()).status,'published');assert.equal((await currentSend(f.DB)).last_number,110);
 assert.equal((await run()).status,'published');assert.equal((await currentSend(f.DB)).last_number,112);assert.equal(f.published(),2);
 assert.equal(f.raw.prepare('SELECT count(*) n FROM send_records').get().n,4);assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('head backoff cannot be starved by an earlier-due later batch; no skipping failed head',async t=>{
 const f=fixture();t.after(()=>f.close());const a=await f.save([f.versions[0]]),b=await f.save([f.versions[1]]);await f.lock(a);await f.lock(b);await f.upload(a);await f.upload(b);
 await processInstagramQueue(f.env,{now:new Date(time),service:{...f.service,create:async()=>{throw new InstagramError('temporary');}}});
 assert.equal((await processInstagramQueue(f.env,{now:new Date(time),service:f.service})).status,'prepared');assert.equal(f.published(),0);
 assert.equal((await processInstagramQueue(f.env,{now:new Date(time),service:f.service})).status,'idle');
 assert.equal((await processInstagramQueue(f.env,{now:new Date(Date.parse(time)+5*60000),service:f.service})).status,'published');
 assert.equal((await currentSend(f.DB)).last_number,109);assert.equal(f.published(),1);
});
test('lock CAS and audit rollback preserve reservation and queue atomicity',async t=>{
 const f=fixture();t.after(()=>f.close());const a=await f.save([f.versions[0]]),b=await f.save([f.versions[1]]);const revision=(await currentSend(f.DB)).revision;
 const results=await Promise.allSettled([a,b].map(batchId=>changeSend(f.DB,'prepare',{batchId,revision,publishAt:time},principal)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await currentSend(f.DB)).next_number,110);
 f.raw.exec("CREATE TRIGGER fail_auto BEFORE INSERT ON audit_logs WHEN NEW.action='send_prepare' BEGIN SELECT RAISE(ABORT,'audit failure'); END;");
 const remaining=(await currentSend(f.DB)).batches.find(b=>b.state==='editing');await assert.rejects(()=>f.lock(remaining.id),/audit failure/);
 assert.equal((await currentSend(f.DB)).next_number,110);assert.equal(f.raw.prepare('SELECT count(*) n FROM instagram_queue').get().n,1);
});

test('shared last schedule follows latest successful lock, not largest date or retry backoff',async t=>{
 const f=fixture();t.after(()=>f.close());assert.equal((await currentSend(f.DB)).last_publish_at,null);
 const a=await f.save([f.versions[0]]);await f.command('prepare',{batchId:a,publishAt:'2030-01-02T12:00:00Z'});
 assert.equal((await currentSend(f.DB)).last_publish_at,'2030-01-02T12:00:00.000Z');
 const b=await f.save([f.versions[1]]);
 assert.equal((await currentSend(f.DB)).last_publish_at,'2030-01-02T12:00:00.000Z');
 f.raw.exec("CREATE TRIGGER fail_time BEFORE INSERT ON audit_logs WHEN NEW.action='send_prepare' BEGIN SELECT RAISE(ABORT,'time failure'); END;");
 await assert.rejects(()=>f.command('prepare',{batchId:b,publishAt:time}));
 assert.equal((await currentSend(f.DB)).last_publish_at,'2030-01-02T12:00:00.000Z');
 f.raw.exec('DROP TRIGGER fail_time');await f.command('prepare',{batchId:b,publishAt:time});
 f.raw.exec("UPDATE instagram_queue SET publish_at='2040-01-01T00:00:00Z'");
 assert.equal((await currentSend(f.DB)).last_publish_at,time);
});
