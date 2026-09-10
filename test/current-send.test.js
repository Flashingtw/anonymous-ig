import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createTestDatabase} from './helpers/d1.js';
import {currentSend,changeSend,attachFinal} from '../worker/src/repositories/current-send.js';
import {cleanupSentImages} from '../worker/src/repositories/send-cleanup.js';
import {defaultLayout} from '../frontend/admin/studio/model.js';
const principal={adminId:1};
function fixture(){
 const d=createTestDatabase({images:true,singleSend:true});
 d.raw.exec("INSERT INTO admins(id,access_email,role) VALUES(1,'owner@example.test','owner'); INSERT INTO submissions(id,content,status) VALUES(1,'original one','approved'),(2,'original two','approved'),(3,'original three','approved');");
 const ids=[];for(let id=1;id<=3;id++){const version=crypto.randomUUID();ids.push(version);d.raw.prepare('INSERT INTO image_drafts(id,text,layout,state) VALUES(?,?,?,?)').run(id,'copy '+id,JSON.stringify(defaultLayout()),'ready');d.raw.prepare('INSERT INTO image_versions(id,draft_id,draft_revision,object_key,text,layout) VALUES(?,?,1,?,?,?)').run(version,id,'source/'+id,'copy '+id,JSON.stringify(defaultLayout()));}
 const objects=new Map(ids.map((_,i)=>['source/'+(i+1),true]));
 const env={DB:d.DB,SINGLE_SEND_ENABLED:'true',SEND_CLEANUP_ENABLED:'true',STUDIO_IMAGES:{async delete(key){objects.delete(key);}}};
 const command=async(action,body={})=>changeSend(d.DB,action,{revision:(await currentSend(d.DB)).revision,...body},principal);
 const upload=async()=>{let s=await currentSend(d.DB);for(const i of s.batch.items.filter(i=>!i.confirmed&&!i.object_key)){const key='final/'+crypto.randomUUID();objects.set(key,true);s=await attachFinal(d.DB,{revision:s.revision,generation:s.batch.generation,position:i.position,key},principal);}return s;};
 return {...d,ids,objects,env,command,upload};
}
test('number allocation, ordering, partial prefix, cancel remainder and next group',async t=>{
 const f=fixture();t.after(()=>f.close());
 let s=await f.command('save',{caption:'test',items:[f.ids[1],f.ids[0],f.ids[2]]});assert.equal(s.last_number,108);assert.equal(s.batch.items[0].number,null);
 s=await f.command('prepare');assert.deepEqual(s.batch.items.map(i=>i.number),[109,110,111]);assert.equal(s.batch.items[0].submission_id,2);
 await assert.rejects(()=>f.command('confirm',{count:1}));s=await f.upload();assert.equal(s.last_number,108);
 const stale=s.revision;s=await f.command('confirm',{count:2});assert.equal(s.last_number,110);assert.equal(s.batch.items[2].number,111);
 await assert.rejects(()=>changeSend(f.DB,'confirm',{revision:stale,count:2},principal));
 await assert.rejects(()=>f.command('reset'));await f.command('cancel');
 s=await f.command('save',{caption:'next',items:[f.ids[2]]});s=await f.command('prepare');assert.equal(s.batch.items[0].number,111);
 await f.upload();s=await f.command('confirm',{count:1});assert.equal(s.last_number,111);assert.equal(s.batch,null);
 assert.equal(f.raw.prepare('SELECT count(*) n FROM send_records').get().n,3);
 assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('single group CAS, unique submissions, rejected sent reuse, lock and retry',async t=>{
 const f=fixture();t.after(()=>f.close());const body={revision:1,caption:'',items:[f.ids[0]]};
 const result=await Promise.allSettled([changeSend(f.DB,'save',body,principal),changeSend(f.DB,'save',body,principal)]);assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
 await f.command('prepare');assert.throws(()=>f.raw.exec("UPDATE image_drafts SET text='changed' WHERE id=1"));
 await assert.rejects(()=>f.command('save',{caption:'',items:[f.ids[1]]}));
 const before=await currentSend(f.DB);await f.upload();const after=await currentSend(f.DB);assert.equal(after.batch.generation,before.batch.generation);
 await f.command('confirm',{count:1});await assert.rejects(()=>f.command('save',{caption:'',items:[f.ids[0]]}));
 assert.equal((await currentSend(f.DB)).last_number,109);assert.equal((await currentSend(f.DB)).batch,null);
});
test('audit failure rolls back confirmation, counter and cleanup jobs',async t=>{
 const f=fixture();t.after(()=>f.close());await f.command('save',{caption:'',items:f.ids});await f.command('prepare');await f.upload();
 f.raw.exec("CREATE TRIGGER fail_send_audit BEFORE INSERT ON audit_logs WHEN NEW.action='send_confirm' BEGIN SELECT RAISE(ABORT,'audit failure'); END;");
 await assert.rejects(()=>f.command('confirm',{count:2}),/audit failure/);
 assert.equal((await currentSend(f.DB)).last_number,108);assert.equal(f.raw.prepare('SELECT count(*) n FROM send_records').get().n,0);assert.equal(f.raw.prepare('SELECT count(*) n FROM send_cleanup').get().n,0);
});
test('reset invalidates finals without taking numbers; upload conflict keeps group intact',async t=>{
 const f=fixture();t.after(()=>f.close());await f.command('save',{caption:'',items:f.ids});await f.command('prepare');const s=await f.upload();await f.command('reset');
 await assert.rejects(()=>attachFinal(f.DB,{revision:s.revision,generation:s.batch.generation,position:0,key:'bad'},principal));
 const now=await currentSend(f.DB);assert.equal(now.last_number,108);assert.equal(now.batch.state,'editing');assert.ok(now.batch.items.every(i=>i.object_key===null&&i.number===null));assert.equal(f.raw.prepare('SELECT count(*) n FROM send_uploads').get().n,3);
});
test('7-day cleanup retries R2 errors, preserves history/originals/audit and live images',async t=>{
 const f=fixture();t.after(()=>f.close());
 f.raw.prepare('INSERT INTO dispatch_drafts(id,operation) VALUES(?,?)').run('legacy','legacy');f.raw.prepare('INSERT INTO dispatch_items VALUES(?,0,?,1)').run('legacy',f.ids[0]);
 await f.command('save',{caption:'',items:f.ids});await f.command('prepare');await f.upload();await f.command('confirm',{count:1});
 await cleanupSentImages(f.env);assert.ok(f.objects.has('source/1'));assert.throws(()=>f.raw.prepare('DELETE FROM image_versions WHERE id=?').run(f.ids[0]));
 f.raw.exec("UPDATE send_cleanup SET due_at='2000-01-01'; UPDATE send_records SET expires_at='2000-01-01';");
 await cleanupSentImages({...f.env,STUDIO_IMAGES:{async delete(){throw new Error('R2 down');}}});assert.equal(f.raw.prepare('SELECT done FROM send_cleanup').get().done,0);
 await cleanupSentImages(f.env);assert.equal(f.raw.prepare('SELECT done FROM send_cleanup').get().done,1);assert.ok(!f.objects.has('source/1'));assert.ok(f.objects.has('source/2'));
 assert.equal(f.raw.prepare('SELECT version_id FROM dispatch_items').get().version_id,null);
 assert.equal(f.raw.prepare('SELECT content FROM submissions WHERE id=1').get().content,'original one');assert.equal((await currentSend(f.DB)).last_number,109);
 assert.equal(f.raw.prepare('SELECT count(*) n FROM audit_logs').get().n,6);assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(),[]);
 await cleanupSentImages(f.env);assert.equal(f.raw.prepare('SELECT attempts FROM send_cleanup').get().attempts,2);
});
test('0007 populated migration preserves source rows and historical references',t=>{
 const f=createTestDatabase({images:true});t.after(()=>f.close());
 f.raw.exec("INSERT INTO admins(id,access_email,role) VALUES(1,'owner@example.test','owner'); INSERT INTO submissions(id,content,status) VALUES(1,'original','approved');");
 f.raw.prepare('INSERT INTO admin_sessions(token_hash,admin_id,expires_at) VALUES(?,1,?)').run('a'.repeat(64),'2099-01-01T00:00:00Z');
 f.raw.exec("INSERT INTO audit_logs(admin_id,action,submission_id) VALUES(1,'approve_submission',1)");
 f.raw.prepare('INSERT INTO image_drafts(id,text,layout) VALUES(1,?,?)').run('copy',JSON.stringify(defaultLayout()));
 f.raw.prepare('INSERT INTO image_versions VALUES(?,1,1,?,?,?,1,?)').run('version','source','copy',JSON.stringify(defaultLayout()),'now');
 f.raw.exec("INSERT INTO dispatch_drafts(id,operation) VALUES('legacy','op'); INSERT INTO dispatch_items VALUES('legacy',0,'version');");
 const tables=['admins','admin_sessions','audit_logs','submissions','image_drafts','image_versions','dispatch_drafts'];
 const before=tables.map(name=>f.raw.prepare('SELECT * FROM '+name).all());f.raw.exec(readFileSync(new URL('../migrations/0008_single_dispatch.sql',import.meta.url),'utf8'));
 assert.deepEqual(tables.map(name=>f.raw.prepare('SELECT * FROM '+name).all()),before);assert.equal(f.raw.prepare('SELECT submission_id FROM dispatch_items').get().submission_id,1);assert.equal(f.raw.prepare('SELECT last_number FROM send_progress').get().last_number,108);assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('limits, empty/duplicate groups, audit rollback and simultaneous confirmation',async t=>{
 const f=fixture();t.after(()=>f.close());
 for(const items of [[],[f.ids[0],f.ids[0]],Array(11).fill(f.ids[0])])await assert.rejects(()=>f.command('save',{items,caption:''}));
 await assert.rejects(()=>f.command('save',{items:f.ids,caption:'x'.repeat(2001)}));
 assert.equal((await currentSend(f.DB)).revision,1);
 await f.command('save',{items:f.ids,caption:''});await f.command('prepare');await f.upload();
 for(const count of [0,-1,4,1.5])await assert.rejects(()=>f.command('confirm',{count}));
 const revision=(await currentSend(f.DB)).revision;
 const results=await Promise.allSettled([changeSend(f.DB,'confirm',{revision,count:1},principal),changeSend(f.DB,'confirm',{revision,count:1},principal)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await currentSend(f.DB)).last_number,109);
});
test('reset and explicit version replacement preserve pinned text until save',async t=>{
 const f=fixture();t.after(()=>f.close());await f.command('save',{items:[f.ids[0]],caption:''});await f.command('prepare');await f.command('reset');
 const version=crypto.randomUUID();f.raw.prepare("UPDATE image_drafts SET text='new copy',revision=2 WHERE id=1").run();f.raw.prepare('INSERT INTO image_versions(id,draft_id,draft_revision,object_key,text,layout) VALUES(?,1,2,?,?,?)').run(version,'new-source','new copy',JSON.stringify(defaultLayout()));
 let s=await currentSend(f.DB);assert.equal(s.batch.items[0].text,'copy 1');assert.equal(s.batch.items[0].latest_version_id,version);
 s=await f.command('save',{items:[version],caption:''});assert.equal(s.batch.items[0].text,'new copy');assert.equal(s.last_number,108);
});
test('cleanup DB failure after R2 deletion is retryable, while flags and live references prevent cleanup',async t=>{
 const f=fixture();t.after(()=>f.close());await f.command('save',{items:[f.ids[0]],caption:''});await f.command('prepare');await f.upload();await f.command('confirm',{count:1});
 f.raw.exec("UPDATE send_cleanup SET due_at='2000-01-01'; UPDATE send_records SET expires_at='2000-01-01'; CREATE TRIGGER fail_cleanup BEFORE DELETE ON image_versions BEGIN SELECT RAISE(ABORT,'cleanup DB failed'); END;");
 await cleanupSentImages({...f.env,SEND_CLEANUP_ENABLED:'false'});assert.ok(f.objects.has('source/1'));
 await cleanupSentImages(f.env);assert.ok(!f.objects.has('source/1'));assert.equal(f.raw.prepare('SELECT done FROM send_cleanup').get().done,0);assert.equal(f.raw.prepare('SELECT count(*) n FROM image_versions WHERE draft_id=1').get().n,1);
 f.raw.exec('DROP TRIGGER fail_cleanup');await cleanupSentImages(f.env);assert.equal(f.raw.prepare('SELECT done FROM send_cleanup').get().done,1);assert.equal((await currentSend(f.DB)).last_number,109);
 f.raw.exec("INSERT INTO send_uploads VALUES('source/2','2000-01-01'),('orphan','2000-01-01')");f.objects.set('orphan',true);await cleanupSentImages(f.env);assert.ok(f.objects.has('source/2'));assert.ok(!f.objects.has('orphan'));
 assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(),[]);
});
