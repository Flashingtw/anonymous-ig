import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createTestDatabase} from './helpers/d1.js';
import {readInstagramCaption,updateInstagramCaption} from '../worker/src/repositories/instagram-captions.js';
import {processInstagramQueue} from '../worker/src/repositories/instagram-queue.js';
import {currentSend} from '../worker/src/repositories/current-send.js';
import {defaultCaption,scheduledCaption,editableCaption} from '../frontend/admin/studio/caption.js';
import {handleApiRequest} from '../worker/src/index.js';
import {accessEnv,accessToken,accessJwks} from './helpers/access.js';

const time='2030-01-01T16:00:00.000Z',principal={adminId:1,role:'owner'};
const oldCaption=defaultCaption([999],new Date('2026-10-05T00:00:00Z')).replace('Monday','星期一')+'\n原本附註';
function fixture(t,{automatic=1,caption=oldCaption,migrate=true}={}){
 const f=createTestDatabase({images:true,singleSend:true,studioDelete:true});t.after(()=>f.close());
 for(const name of ['0010_instagram_publish_queue','0011_multiple_send_batches','0012_automatic_locked_batches','0013_instagram_preparation'])f.raw.exec(readFileSync(new URL(`../migrations/${name}.sql`,import.meta.url),'utf8'));
 f.raw.exec("INSERT INTO admins(id,access_email,role) VALUES(1,'owner@example.com','owner'),(2,'admin@example.com','admin'),(3,'moderator@example.com','moderator'); INSERT INTO submissions(id,content,status) VALUES(1,'unchanged','approved'),(2,'second','approved');");
 f.raw.prepare("INSERT INTO send_batches(id,state,caption,generation,editor_id,auto_publish,publish_at) VALUES('batch','prepared',?,'generation',1,?,?)").run(caption,automatic,time);
 f.raw.exec("INSERT INTO send_items(batch_id,position,submission_id,version_id,number,object_key) VALUES('batch',0,1,'v1',109,'one.png'),('batch',1,2,'v2',110,'two.png');");
 f.raw.prepare("INSERT INTO instagram_queue(batch_id,generation,first_number,last_number,item_count,publish_status,publish_at,published_caption,editor_id,creation_id,preparation_status,prepared_at) VALUES('batch','generation',109,110,2,'pending',?,?,1,'old-parent','ready','2029-12-31')").run(time,caption);
 f.raw.exec("INSERT INTO instagram_items(batch_id,position,submission_id,number,published_image_key,source_png_key,image_token,creation_id) VALUES('batch',0,1,109,'one.jpg','one.png','token-one','old-child-one'),('batch',1,2,110,'two.jpg','two.png','token-two','old-child-two');");
 if(migrate)f.raw.exec(readFileSync(new URL('../migrations/0014_instagram_caption_edits.sql',import.meta.url),'utf8'));
 const row=()=>f.raw.prepare("SELECT * FROM instagram_queue WHERE batch_id='batch'").get();
 return {...f,row};
}

test('0014 preserves existing scheduled captions and data; raw snapshot edits remain blocked',t=>{
 const f=fixture(t,{migrate:false});
 const tables=['admins','submissions','send_batches','send_items','send_progress','instagram_queue','instagram_items','audit_logs'];
 const before=tables.map(table=>f.raw.prepare(`SELECT * FROM ${table}`).all());
 f.raw.exec(readFileSync(new URL('../migrations/0014_instagram_caption_edits.sql',import.meta.url),'utf8'));
 assert.deepEqual(tables.map(table=>f.raw.prepare(`SELECT * FROM ${table}`).all()),before);
 for(const sql of ["UPDATE instagram_queue SET published_caption='bad'","UPDATE send_batches SET caption='bad'","UPDATE send_items SET number=999","UPDATE instagram_items SET published_image_key='other.jpg'","UPDATE send_batches SET state='cancelled'"])assert.throws(()=>f.raw.exec(sql),/LOCKED/);
 assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(),[]);
});

for(const automatic of [0,1])test(`old ${automatic?'automatic':'manual'} queued captions edit atomically without changing images, time, numbering or retries`,async t=>{
 const f=fixture(t,{automatic});f.raw.exec("UPDATE instagram_queue SET publish_attempts=1,next_attempt_at='2030-01-01T15:50:00.000Z'");
 const before=f.row(),items=f.raw.prepare('SELECT * FROM instagram_items ORDER BY position').all();
 const editor=await readInstagramCaption(f.DB,'batch');assert.equal(editor.customText,'原本附註');assert.equal(editor.recognized,true);
 assert.equal(f.row().published_caption,oldCaption,'read does not rewrite');
 const result=await updateInstagramCaption(f.DB,'batch',{revision:editor.revision,customText:'更新公告\n第二行'},principal);
 assert.equal(result.caption,scheduledCaption('更新公告\n第二行',[109,110],time));assert.match(result.caption,/2030\/01\/02 - Wednesday/);
 assert.equal(f.row().creation_id,null);assert.equal(f.row().preparation_status,'none');assert.equal(f.row().prepared_at,null);
 assert.equal((await currentSend(f.DB,'batch')).batch.caption,result.caption);
 for(const key of ['first_number','last_number','generation','publish_at','publish_attempts','next_attempt_at','publish_status','editor_id'])assert.equal(f.row()[key],before[key],key);
 assert.equal((await currentSend(f.DB)).last_number,108);
 assert.deepEqual(f.raw.prepare('SELECT * FROM instagram_items ORDER BY position').all().map(item=>({...item})),items.map(item=>({...item,creation_id:null})));
 assert.equal(f.raw.prepare('SELECT caption FROM instagram_caption_edits').get().caption,result.caption);
 const audit=f.raw.prepare("SELECT * FROM audit_logs WHERE action='ig_caption_updated'").get();assert.equal(audit.admin_id,1);assert.doesNotMatch(audit.metadata,/更新公告|old-parent|token-one/);
 assert.equal(f.raw.prepare('SELECT content FROM submissions WHERE id=1').get().content,'unchanged');
 for(const sql of ["UPDATE instagram_caption_edits SET caption='bad'","DELETE FROM instagram_caption_edits","UPDATE instagram_queue SET published_caption='bad'","UPDATE send_batches SET caption='bad'","UPDATE send_batches SET state='cancelled'"])assert.throws(()=>f.raw.exec(sql),/LOCKED/);
});

test('unknown and ambiguous legacy formats are preserved in full for explicit review',async t=>{
 const unknown='  舊格式\r\n#777\n🔒 my date\n';const f=fixture(t,{caption:unknown});
 assert.deepEqual(editableCaption(unknown),{customText:unknown,recognized:false});
 const editor=await readInstagramCaption(f.DB,'batch');assert.equal(editor.customText,unknown);assert.equal(editor.recognized,false);
 assert.equal(f.row().published_caption,unknown);
 const doubled=defaultCaption([1])+'\n'+defaultCaption([2]);assert.equal(editableCaption(doubled).customText,doubled);assert.equal(editableCaption(doubled).recognized,false);
 const crlf=oldCaption.replace(/\n/g,'\r\n');assert.equal(editableCaption(crlf).customText,'原本附註');
 await updateInstagramCaption(f.DB,'batch',{revision:editor.revision,customText:'我已人工整理'},principal);
 assert.match(f.row().published_caption,/^我已人工整理\n\n🔒/);
});

test('stale and simultaneous saves cannot overwrite another editor; audit failure rolls everything back',async t=>{
 const f=fixture(t);const before=f.row();
 f.raw.exec("CREATE TRIGGER fail_caption_audit BEFORE INSERT ON audit_logs WHEN NEW.action='ig_caption_updated' BEGIN SELECT RAISE(ABORT,'audit failure'); END;");
 await assert.rejects(()=>updateInstagramCaption(f.DB,'batch',{revision:1,customText:'rollback'},principal),/audit failure/);
 assert.deepEqual(f.row(),before);assert.equal(f.raw.prepare('SELECT count(*) n FROM instagram_caption_edits').get().n,0);
 assert.equal((await currentSend(f.DB)).revision,1);assert.equal((await currentSend(f.DB)).batch.caption,oldCaption);
 assert.equal(f.raw.prepare('SELECT count(creation_id) n FROM instagram_items').get().n,2);
 f.raw.exec('DROP TRIGGER fail_caption_audit');
 const results=await Promise.allSettled(['first','second'].map(customText=>updateInstagramCaption(f.DB,'batch',{revision:1,customText},principal)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
 assert.equal(f.raw.prepare('SELECT count(*) n FROM instagram_caption_edits').get().n,1);
 await assert.rejects(()=>updateInstagramCaption(f.DB,'batch',{revision:1,customText:'stale'},principal),e=>e.status===409);
});

test('publishing, unknown outcome, receipts and active leases reject edits even with unexpired editor data',async t=>{
 const f=fixture(t,{automatic:0});
 for(const sql of ["publish_status='publishing'","publish_status='published'","publish_status='none'","uncertain=1","publish_started=1","instagram_media_id='123'","lease_token='working'","lease_until='2000-01-01'"]){
  f.raw.exec(`UPDATE instagram_queue SET ${sql}`);
  await assert.rejects(()=>readInstagramCaption(f.DB,'batch'),e=>e.status===409);
  await assert.rejects(()=>updateInstagramCaption(f.DB,'batch',{revision:f.row().revision,customText:'not allowed'},principal),e=>e.status===409);
  // Local fixture reset only; no production writes.
  f.raw.exec("UPDATE instagram_queue SET publish_status='pending',uncertain=0,publish_started=0,instagram_media_id=NULL,lease_token=NULL,lease_until=NULL");
 }
 const raced={prepare(sql){const s=f.DB.prepare(sql);if(sql.startsWith('INSERT INTO instagram_caption_edits')){const run=s.run.bind(s);s.run=()=>{f.raw.exec("UPDATE instagram_queue SET publish_status='publishing',lease_token='cron',revision=revision+1");return run();};}return s;}};
 await assert.rejects(()=>updateInstagramCaption(raced,'batch',{revision:1,customText:'race'},principal),e=>e.status===409);
 assert.equal(f.row().published_caption,oldCaption);assert.equal(f.row().creation_id,'old-parent');
});

test('caption validation rejects oversized text and invalid roles; failed jobs stay failed until explicit retry',async t=>{
 const f=fixture(t);for(const customText of [null,{},'字'.repeat(2000),'e\u0301'.repeat(2000)])await assert.rejects(()=>updateInstagramCaption(f.DB,'batch',{revision:1,customText},principal),e=>e.status===400);
 await assert.rejects(()=>updateInstagramCaption(f.DB,'batch',{revision:1,customText:'x'},{adminId:1,role:'viewer'}),e=>e.status===403);
 f.raw.exec("UPDATE instagram_queue SET publish_status='failed',publish_attempts=3,publish_error='Meta error'");
 await updateInstagramCaption(f.DB,'batch',{revision:1,customText:''},principal);
 assert.equal(f.row().publish_status,'failed');assert.equal(f.row().publish_attempts,3);assert.equal(f.row().publish_error,'Meta error');
 assert.equal((await processInstagramQueue({DB:f.DB,IG_PUBLISH_ENABLED:'true'},{now:new Date(time)})).status,'idle');
});

test('after a caption edit Cron creates fresh containers with the new caption and publishes once',async t=>{
 const f=fixture(t);await updateInstagramCaption(f.DB,'batch',{revision:1,customText:'final caption'},principal);
 let sequence=0,publishes=0;const captions=[],ids=[];
 const service={create:async()=>String(++sequence),createCarousel:async({children,caption})=>{ids.push(...children);captions.push(caption);return '99';},status:async id=>{assert.ok(!id.startsWith('old-'));return 'FINISHED';},publish:async id=>{assert.equal(id,'99');publishes++;return '199';}};
 const env={DB:f.DB,IG_PUBLISH_ENABLED:'true',IG_MEDIA_ORIGIN:'https://example.test'};
 assert.equal((await processInstagramQueue(env,{now:new Date(Date.parse(time)-15*60000),service})).status,'prepared');assert.equal(publishes,0);
 assert.deepEqual(ids,['1','2']);assert.deepEqual(captions,[f.row().published_caption]);
 assert.equal((await processInstagramQueue(env,{now:new Date(time),service})).status,'published');assert.equal(publishes,1);assert.equal((await currentSend(f.DB)).last_number,110);
 await assert.rejects(()=>updateInstagramCaption(f.DB,'batch',{revision:f.row().revision,customText:'too late'},principal),e=>e.status===409);
});

test('caption HTTP routes retain session, CSRF and enabled checks for owner/admin/moderator',async t=>{
 const f=fixture(t);const env={...accessEnv,DB:f.DB,APP_ENV:'production',ACCESS_AUTH_ENABLED:'true',LOCAL_AUTH_ENABLED:'false',IG_PUBLISH_ENABLED:'true',SESSION_SECRET:'local-test-session-secret-at-least-32-characters'};
 f.raw.exec("INSERT INTO admins(id,access_email,role) VALUES(4,'backup-owner@example.test','owner')");
 const call=(path,options={})=>handleApiRequest(new Request('https://admin.example.test'+path,options),env,{accessJwks});
 const path='/api/admin/instagram/batches/batch/caption';assert.equal((await call(path)).status,401);
 for(const [i,role]of ['owner','admin','moderator'].entries()){
  const response=await call('/api/auth/access',{headers:{'Cf-Access-Jwt-Assertion':await accessToken({email:role+'@example.com'})}});assert.equal(response.status,302);
  const Cookie=response.headers.get('set-cookie').split(';')[0];const me=(await(await call('/api/auth/me',{headers:{Cookie}})).json()).data;
  assert.equal((await call(path,{headers:{Cookie}})).status,200);
  const options={method:'POST',headers:{Cookie,'Content-Type':'application/json'},body:JSON.stringify({revision:f.row().revision,customText:role+' update'})};
  assert.equal((await call(path,options)).status,403);
  options.headers['X-CSRF-Token']=me.csrfToken;assert.equal((await call(path,options)).status,200);
  assert.equal(f.raw.prepare("SELECT admin_id FROM audit_logs WHERE action='ig_caption_updated' ORDER BY id DESC").get().admin_id,i+1);
  assert.equal((await call(path,{...options,body:JSON.stringify({revision:f.row().revision,customText:'x',publishAt:'2099-01-01'})})).status,400);
  f.raw.prepare('UPDATE admins SET enabled=0 WHERE id=?').run(i+1);
  assert.equal((await call(path,{headers:{Cookie}})).status,401);assert.equal((await call(path,options)).status,401);
 }
 assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(),[]);
});
