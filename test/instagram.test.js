import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createTestDatabase} from './helpers/d1.js';
import {stageInstagramImage,scheduleInstagram,editInstagram,processInstagramQueue} from '../worker/src/repositories/instagram-queue.js';
import {instagramService,InstagramError,publishInstagramPost} from '../worker/src/services/instagram.js';
import {instagramHandler,instagramMedia,validateJpeg} from '../worker/src/handlers/instagram.js';
import {changeSend,currentSend} from '../worker/src/repositories/current-send.js';
import {updateInstagramCaption} from '../worker/src/repositories/instagram-captions.js';
import {handleApiRequest} from '../worker/src/index.js';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
const date=new Date('2030-01-01T00:00:00Z'),principal={adminId:1,role:'owner',provider:'dev'};
function fixture({preparationSchema=true}={}){
 const f=createTestDatabase({images:true,singleSend:true,studioDelete:true});
 f.raw.exec("INSERT INTO admins(id,access_email,role) VALUES(1,'test@example.test','owner'); INSERT INTO submissions(id,content,status) VALUES(1,'original','approved'),(2,'two','approved'); INSERT INTO send_batches(id,state,caption,generation,editor_id) VALUES('batch','prepared','caption 🔒','generation',1); INSERT INTO send_items(batch_id,position,submission_id,version_id,number,object_key) VALUES('batch',0,1,'v1',109,'original.png'),('batch',1,2,'v2',110,'second.png');");
 const before=JSON.stringify(f.raw.prepare('SELECT * FROM submissions').all());
 f.raw.exec(readFileSync(new URL('../migrations/0010_instagram_publish_queue.sql',import.meta.url),'utf8'));
 f.raw.exec(readFileSync(new URL('../migrations/0011_multiple_send_batches.sql',import.meta.url),'utf8'));
 f.raw.exec(readFileSync(new URL('../migrations/0012_automatic_locked_batches.sql',import.meta.url),'utf8'));
 if(preparationSchema)f.raw.exec(readFileSync(new URL('../migrations/0013_instagram_preparation.sql',import.meta.url),'utf8'));
 if(preparationSchema)f.raw.exec(readFileSync(new URL('../migrations/0014_instagram_caption_edits.sql',import.meta.url),'utf8'));
 assert.equal(JSON.stringify(f.raw.prepare('SELECT * FROM submissions').all()),before);
 const env={DB:f.DB,IG_PUBLISH_ENABLED:'true',IG_MEDIA_ORIGIN:'https://example.test',STUDIO_IMAGES:{get:async()=>({body:new Uint8Array([1])})}};
 const stage=async()=>{const uploads=[];for(const position of [0,1]){const key=`${crypto.randomUUID()}.jpg`;await f.DB.prepare('INSERT INTO send_uploads VALUES(?,?)').bind(key,'2099-01-01').run();uploads.push(await stageInstagramImage(f.DB,{id:'batch',generation:'generation',position,key}));}return uploads;};
 const schedule=async(time=date)=>scheduleInstagram(f.DB,{id:'batch',revision:(await currentSend(f.DB)).revision,generation:'generation',publishAt:time.toISOString(),uploads:await stage()},principal);
 const row=()=>f.raw.prepare('SELECT * FROM instagram_queue WHERE batch_id=?').get('batch');
 let publishes=0,creates=0;const calls=[];const service={create:async args=>{calls.push(args);return String(123+creates++);},createCarousel:async args=>{calls.push(args);return '888';},status:async()=> 'FINISHED',publish:async id=>{calls.push({publish:id});return String(900+ ++publishes);}};
 return {...f,env,stage,schedule,row,service,calls,publishes:()=>publishes};
}

test('normal Meta processing completes in the same invocation without a failure or five-minute backoff',async t=>{
 const f=fixture();t.after(()=>f.close());await f.schedule();
 const reads=new Map(),waits=[];
 const service={...f.service,status:async id=>{const count=reads.get(id)??0;reads.set(id,count+1);return count===0?'IN_PROGRESS':'FINISHED';}};
 const result=await processInstagramQueue(f.env,{now:date,service,wait:async ms=>{waits.push(ms);}});
 assert.equal(result.status,'published');assert.equal(f.publishes(),1);
 assert.equal(f.row().publish_attempts,0);assert.equal(f.row().publish_error,null);
 assert.equal(f.row().publish_at,date.toISOString());assert.ok(waits.length>0);
 assert.equal(f.raw.prepare("SELECT count(*) n FROM audit_logs WHERE action='ig_failed'").get().n,0);
});

test('prepare within fifteen minutes, stay unpublished, then reuse ready containers at due time',async t=>{
 const f=fixture();t.after(()=>f.close());await f.schedule();
 const run=minute=>processInstagramQueue(f.env,{now:new Date(date.getTime()+minute*60000),service:f.service});
 assert.equal((await run(-16)).status,'idle');assert.equal(f.calls.length,0);
 assert.equal((await run(-15)).status,'prepared');assert.equal(f.publishes(),0);
 assert.equal(f.row().preparation_status,'ready');assert.equal(f.row().publish_status,'pending');
 assert.equal(f.row().publish_started,0);assert.equal(f.row().publish_attempts,0);
 assert.equal((await currentSend(f.DB)).last_number,108);assert.equal(f.calls.length,3);
 assert.equal((await run(-10)).status,'idle');assert.equal(f.calls.length,3);
 assert.equal((await run(0)).status,'published');assert.equal(f.calls.length,4);assert.equal(f.publishes(),1);
 assert.deepEqual(f.calls[3],{publish:'888'});assert.equal((await currentSend(f.DB)).last_number,110);
 assert.equal(f.row().publish_at,date.toISOString());
});

test('preparation errors back off without moving the requested time or publishing early',async t=>{
 const f=fixture();t.after(()=>f.close());await f.schedule();
 await processInstagramQueue(f.env,{now:new Date(date.getTime()-15*60000),service:{...f.service,create:async()=>{throw new InstagramError('temporary');}}});
 assert.equal(f.row().publish_at,date.toISOString());assert.equal(f.row().publish_attempts,1);
 assert.equal(f.row().next_attempt_at,new Date(date.getTime()-10*60000).toISOString());
 assert.equal((await processInstagramQueue(f.env,{now:new Date(date.getTime()-12*60000),service:f.service})).status,'idle');
 assert.equal((await processInstagramQueue(f.env,{now:new Date(date.getTime()-10*60000),service:f.service})).status,'prepared');
 assert.equal(f.publishes(),0);
});

test('0012 to 0013 preserves queue receipts, containers, snapshots, ledgers and foreign keys',t=>{
 const f=fixture({preparationSchema:false});t.after(()=>f.close());
 f.raw.exec("INSERT INTO instagram_queue(batch_id,generation,first_number,last_number,item_count,publish_status,publish_at,published_caption,creation_id,instagram_media_id,publish_started,editor_id) VALUES('batch','generation',109,110,2,'publishing','2030-01-01T00:00:00.000Z','immutable','777','999',1,1); INSERT INTO instagram_items(batch_id,position,submission_id,number,published_image_key,source_png_key,image_token,creation_id) VALUES('batch',0,1,109,'a.jpg','original.png','test-token','123');");
 const tables=['admins','submissions','send_batches','send_items','send_progress','send_records','audit_logs','instagram_items','instagram_queue'];
 const before=new Map(tables.map(table=>[table,f.raw.prepare(`SELECT * FROM ${table}`).all()]));
 f.raw.exec(readFileSync(new URL('../migrations/0013_instagram_preparation.sql',import.meta.url),'utf8'));
 for(const table of tables){
  const rows=f.raw.prepare(`SELECT * FROM ${table}`).all();
  if(table==='instagram_queue')for(const row of rows){assert.equal(row.preparation_status,'none');assert.equal(row.prepared_at,null);assert.equal(row.next_attempt_at,null);delete row.preparation_status;delete row.prepared_at;delete row.next_attempt_at;}
  assert.deepEqual(rows,before.get(table),table);
 }
 assert.throws(()=>f.raw.exec("UPDATE instagram_queue SET preparation_status='invalid'"),/CHECK/);
 assert.throws(()=>f.raw.exec("UPDATE instagram_queue SET published_caption='changed'"),/SNAPSHOT/);
 assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('preparing parent remains processing without attempts; concurrent Cron waits and next tick resumes',async t=>{
 const f=fixture();t.after(()=>f.close());await f.schedule();const now=new Date(date.getTime()-15*60000);let waits=0;
 assert.equal((await processInstagramQueue(f.env,{now,service:{...f.service,status:async id=>id==='888'?'IN_PROGRESS':'FINISHED'},wait:async()=>{
  waits++;assert.equal((await processInstagramQueue(f.env,{now,service:f.service})).status,'idle');
 }})).status,'pending');
 assert.equal(waits,4);assert.equal(f.row().preparation_status,'processing');assert.equal(f.row().creation_id,'888');assert.equal(f.row().publish_attempts,0);
 assert.equal(f.calls.length,3);assert.equal(f.publishes(),0);
 assert.equal((await processInstagramQueue(f.env,{now:new Date(date.getTime()-10*60000),service:f.service})).status,'prepared');
 assert.equal(f.calls.length,3);assert.equal(f.publishes(),0);assert.equal(f.row().preparation_status,'ready');
});

test('single image prewarms and an expired preparation lease can recover without publishing early',async t=>{
 const f=fixture();t.after(()=>f.close());f.raw.exec('DELETE FROM send_items WHERE position=1');
 const key='single.jpg';f.raw.prepare('INSERT INTO send_uploads VALUES(?,?)').run(key,'2099-01-01');
 const upload=await stageInstagramImage(f.DB,{id:'batch',generation:'generation',position:0,key});
 await scheduleInstagram(f.DB,{id:'batch',revision:1,generation:'generation',publishAt:date.toISOString(),uploads:[upload]},principal);
 f.raw.exec("UPDATE instagram_queue SET publish_status='publishing',lease_until='2020-01-01',lease_token='interrupted'");
 assert.equal((await processInstagramQueue(f.env,{now:new Date(date.getTime()-5*60000),service:f.service})).status,'prepared');
 assert.equal(f.calls.length,1);assert.equal(f.publishes(),0);assert.equal(f.row().publish_started,0);
 assert.equal((await processInstagramQueue(f.env,{now:date,service:f.service})).status,'published');
 assert.equal(f.calls.length,2);assert.equal(f.publishes(),1);assert.equal((await currentSend(f.DB)).last_number,109);
});

test('definite expiration resets containers atomically, retains numbers, and safely prepares again',async t=>{
 const f=fixture();t.after(()=>f.close());await f.schedule();const now=new Date(date.getTime()-15*60000);
 await processInstagramQueue(f.env,{now,service:f.service});const caption=f.row().published_caption;
 assert.equal((await processInstagramQueue(f.env,{now:date,service:{...f.service,status:async()=> 'EXPIRED'}})).status,'pending');
 assert.equal(f.row().creation_id,null);assert.equal(f.row().preparation_status,'none');assert.equal(f.row().publish_attempts,0);
 assert.equal(f.raw.prepare('SELECT count(creation_id) n FROM instagram_items').get().n,0);
 assert.equal((await currentSend(f.DB)).last_number,108);assert.equal(f.row().published_caption,caption);assert.equal(f.publishes(),0);
 assert.equal(f.raw.prepare("SELECT count(*) n FROM audit_logs WHERE action='ig_container_expired'").get().n,1);
 assert.equal((await processInstagramQueue(f.env,{now:new Date(date.getTime()+5*60000),service:f.service})).status,'published');
 assert.equal(f.publishes(),1);assert.equal(f.row().publish_at,date.toISOString());
});

test('expired-container reset rolls back on audit failure; ambiguous published status never resets or retries',async t=>{
 const f=fixture();t.after(()=>f.close());await f.schedule();await processInstagramQueue(f.env,{now:new Date(date.getTime()-15*60000),service:f.service});
 f.raw.exec("CREATE TRIGGER fail_expiry BEFORE INSERT ON audit_logs WHEN NEW.action='ig_container_expired' BEGIN SELECT RAISE(ABORT,'audit failure'); END;");
 await assert.rejects(()=>processInstagramQueue(f.env,{now:date,service:{...f.service,status:async()=> 'EXPIRED'}}),/audit failure/);
 assert.equal(f.row().creation_id,'888');assert.equal(f.raw.prepare('SELECT count(creation_id) n FROM instagram_items').get().n,2);
 f.raw.exec('DROP TRIGGER fail_expiry');
 await processInstagramQueue(f.env,{now:new Date(date.getTime()+11*60000),service:{...f.service,status:async()=> 'PUBLISHED'}});
 assert.equal(f.row().uncertain,1);assert.equal(f.row().publish_status,'failed');assert.equal(f.row().creation_id,'888');
 assert.equal(f.publishes(),0);await assert.rejects(()=>editInstagram(f.DB,'batch','retry-publish',f.row().revision,principal));
});

test('another Cron cannot claim the batch while the first is polling Meta',async t=>{
 const f=fixture();t.after(()=>f.close());await f.schedule();let ready=false;
 const result=await processInstagramQueue(f.env,{now:date,service:{...f.service,status:async()=>ready?'FINISHED':'IN_PROGRESS'},wait:async()=>{
  assert.equal((await processInstagramQueue(f.env,{now:date,service:f.service})).status,'idle');ready=true;
 }});
 assert.equal(result.status,'published');assert.equal(f.publishes(),1);
});

test('lease loss during polling stops before creating a parent or publishing',async t=>{
 const f=fixture();t.after(()=>f.close());await f.schedule();let ready=false;
 await assert.rejects(()=>processInstagramQueue(f.env,{now:date,service:{...f.service,status:async()=>ready?'FINISHED':'IN_PROGRESS'},wait:async()=>{
  f.raw.exec("UPDATE instagram_queue SET lease_token='new-owner'");ready=true;
 }}));
 assert.equal(f.calls.length,2);assert.equal(f.publishes(),0);assert.equal(f.row().lease_token,'new-owner');
});

test('single image waits for processing; a real container error still fails without publishing',async()=>{
 for(const terminal of ['FINISHED','ERROR','EXPIRED','PUBLISHED']){
  let count=0,publishes=0;const events=[];
  const input={images:[{imageUrl:'https://example.test/image.jpg'}],caption:'text',onCreated:async id=>events.push(id),onPublishing:async()=>events.push('intent')};
  const service={create:async()=> '123',status:async()=>count++===0?'IN_PROGRESS':terminal,publish:async()=>{publishes++;return '456';}};
  const operation=()=>publishInstagramPost(input,service,{wait:async ms=>assert.equal(ms,60000)});
  if(terminal==='FINISHED'){assert.equal(await operation(),'456');assert.deepEqual(events,['123','intent']);assert.equal(publishes,1);}
  else{await assert.rejects(operation,e=>e instanceof InstagramError&&e.ambiguous===(terminal==='PUBLISHED'));assert.equal(publishes,0);assert.deepEqual(events,['123']);}
 }
});
test('migration preserves existing rows/FKs, snapshots are immutable and manual send cannot race a queue',async t=>{
 const f=fixture();t.after(()=>f.close());await f.schedule();
 assert.equal(f.row().published_caption,'caption 🔒');assert.equal(f.raw.prepare('SELECT source_png_key FROM instagram_items ORDER BY position').get().source_png_key,'original.png');
 assert.throws(()=>f.raw.exec("UPDATE instagram_queue SET published_caption='edited'"),/SNAPSHOT/);
 for(const command of ['cancel','confirm'])await assert.rejects(()=>changeSend(f.DB,command,{revision:2,count:1},principal),/排程/);
 assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(),[]);
 assert.equal((await currentSend(f.DB)).last_number,108);
});
test('concurrent invocations publish ONE carousel in image order and atomically confirm the whole batch',async t=>{
 const f=fixture();t.after(()=>f.close());await f.schedule();
 await Promise.all([processInstagramQueue(f.env,{now:date,service:f.service}),processInstagramQueue(f.env,{now:date,service:f.service})]);
 assert.equal(f.publishes(),1);assert.equal(f.row().publish_status,'published');
 assert.deepEqual(f.calls[2],{children:['123','124'],caption:'caption 🔒'});assert.deepEqual(f.calls[3],{publish:'888'});
 assert.ok(f.calls.slice(0,2).every(c=>c.carouselItem&&!('caption' in c)));
 await processInstagramQueue(f.env,{now:date,service:f.service});
 assert.equal(f.publishes(),1);assert.equal((await currentSend(f.DB)).last_number,110);assert.equal((await currentSend(f.DB)).batch,null);
 assert.equal(f.raw.prepare('SELECT count(*) n FROM send_cleanup').get().n,2);assert.equal(f.raw.prepare('SELECT content FROM submissions WHERE id=1').get().content,'original');
});
test('future jobs wait; safe failures back off and fail on third attempt, manual retry recovers',async t=>{
 const f=fixture();t.after(()=>f.close());await f.schedule();
 assert.equal((await processInstagramQueue(f.env,{now:new Date('2029-12-31')})).status,'idle');
 const service={...f.service,create:async()=>{throw new InstagramError('Meta HTTP 400 / code 190。');}};
 for(const [minute,status]of [[0,'pending'],[5,'pending'],[20,'failed']]){
  const now=new Date(date.getTime()+minute*60000);assert.equal((await processInstagramQueue(f.env,{now,service})).status,status);
 }
 assert.equal(f.row().publish_attempts,3);assert.equal(f.publishes(),0);
 await editInstagram(f.DB,'batch','retry-publish',f.row().revision,principal,date);
 await processInstagramQueue(f.env,{now:date,service:f.service});assert.equal(f.row().publish_status,'published');
});
test('ambiguous publication is never auto-republished or manually retried; expired lease fails closed',async t=>{
 const f=fixture();t.after(()=>f.close());await f.schedule();
 await processInstagramQueue(f.env,{now:date,service:{...f.service,publish:async()=>{throw new InstagramError('network',{ambiguous:true});}}});
 assert.equal(f.row().uncertain,1);await assert.rejects(()=>editInstagram(f.DB,'batch','retry-publish',f.row().revision,principal));
 assert.equal((await processInstagramQueue(f.env,{now:date,service:f.service})).status,'idle');
 f.raw.exec("UPDATE instagram_queue SET publish_status='publishing',lease_until='2020-01-01',lease_token='old',publish_started=1");
 await processInstagramQueue(f.env,{now:date,service:f.service});assert.equal(f.publishes(),0);assert.equal(f.row().publish_status,'failed');
});
test('audit failure rolls back schedule; receipt survives ledger failure and recovery never republishes',async t=>{
 const f=fixture();t.after(()=>f.close());f.raw.exec("CREATE TRIGGER fail_ig BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'audit failure'); END;");
 await assert.rejects(()=>f.schedule(),/audit failure/);assert.equal(f.row(),undefined);assert.equal((await currentSend(f.DB)).revision,1);
 f.raw.exec('DROP TRIGGER fail_ig');await f.schedule();
 f.raw.exec("CREATE TRIGGER fail_ig BEFORE INSERT ON audit_logs WHEN NEW.action='ig_published' BEGIN SELECT RAISE(ABORT,'audit failure'); END;");
 await assert.rejects(()=>processInstagramQueue(f.env,{now:date,service:f.service}),/receipt/);
 assert.equal(f.row().instagram_media_id,'901');assert.equal((await currentSend(f.DB)).last_number,108);
 f.raw.exec('DROP TRIGGER fail_ig');await processInstagramQueue(f.env,{now:new Date(date.getTime()+11*60000),service:f.service});
 assert.equal(f.publishes(),1);assert.equal((await currentSend(f.DB)).last_number,110);
});
test('one cancel unlocks the entire batch, stale revisions rejected, numbering preserved',async t=>{
 const f=fixture();t.after(()=>f.close());await f.schedule();
 await assert.rejects(()=>editInstagram(f.DB,'batch','cancel-publish',999,principal));
 await editInstagram(f.DB,'batch','cancel-publish',f.row().revision,principal);
 await changeSend(f.DB,'cancel',{revision:(await currentSend(f.DB)).revision},principal);assert.equal((await currentSend(f.DB)).last_number,108);
});
test('partial/duplicate/stale uploads never schedule a partial post; reschedule takes a fresh full snapshot',async t=>{
 const f=fixture();t.after(()=>f.close());const uploads=await f.stage();
 const input={id:'batch',revision:1,generation:'generation',publishAt:date.toISOString()};
 for(const invalid of [[],uploads.slice(0,1),[uploads[0],uploads[0]],Array(11).fill(uploads[0])])await assert.rejects(()=>scheduleInstagram(f.DB,{...input,uploads:invalid},principal));
 assert.equal(f.row(),undefined);assert.equal((await currentSend(f.DB)).revision,1);
 await assert.rejects(()=>scheduleInstagram(f.DB,{...input,generation:'stale',uploads},principal));
 await scheduleInstagram(f.DB,{...input,uploads:uploads.toReversed()},principal);
 assert.deepEqual(f.raw.prepare('SELECT number FROM instagram_items ORDER BY position').all().map(i=>i.number),[109,110]);
 await assert.rejects(()=>f.schedule());
 await editInstagram(f.DB,'batch','cancel-publish',f.row().revision,principal);
 await f.schedule();assert.equal(f.raw.prepare('SELECT count(*) n FROM instagram_items').get().n,2);
 assert.equal((await currentSend(f.DB)).last_number,108);assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('partially manually confirmed batches cannot be reposted as a carousel',async t=>{
 const f=fixture();t.after(()=>f.close());f.raw.exec('UPDATE send_items SET confirmed=1 WHERE position=0');
 await assert.rejects(()=>f.schedule());assert.equal(f.row(),undefined);
});
test('processing children are persisted and reused; no child is ever published on its own',async t=>{
 const f=fixture();t.after(()=>f.close());await f.schedule();
 const waits=[];await processInstagramQueue(f.env,{now:date,service:{...f.service,status:async()=> 'IN_PROGRESS'},wait:async ms=>{waits.push(ms);}});
 assert.equal(waits.length,4);assert.equal(f.row().publish_attempts,0);assert.equal(f.row().publish_at,date.toISOString());
 assert.equal(f.publishes(),0);assert.equal(f.calls.length,2);
 assert.equal(f.raw.prepare('SELECT count(creation_id) n FROM instagram_items').get().n,2);
 await processInstagramQueue(f.env,{now:new Date(date.getTime()+5*60000),service:f.service});
 assert.equal(f.calls.length,4);assert.deepEqual(f.calls[2],{children:['123','124'],caption:'caption 🔒'});assert.deepEqual(f.calls[3],{publish:'888'});
 assert.equal(f.publishes(),1);
});
test('Meta adapter keeps token out of URLs and errors, creates then publishes using configured version',async()=>{
 const requests=[],env={IG_ACCESS_TOKEN:'VERY_SECRET_TOKEN',IG_USER_ID:'7',IG_API_VERSION:'v25.0'};
 const service=instagramService(env,async(url,options)=>{requests.push({url,options});return Response.json(url.includes('status_code')?{status_code:'FINISHED'}:{id:'123'});});
 assert.equal(await service.create({imageUrl:'https://example.test/image.jpg',caption:'hello'}),'123');await service.status('123');await service.publish('123');
 await service.create({imageUrl:'https://example.test/child.jpg',carouselItem:true});await service.createCarousel({children:['11','22'],caption:'shared'});
 assert.equal(requests.length,5);assert.ok(requests.every(r=>!r.url.includes(env.IG_ACCESS_TOKEN)&&r.url.startsWith('https://graph.instagram.com/v25.0/')));
 assert.equal(requests[3].options.body.get('is_carousel_item'),'true');assert.equal(requests[3].options.body.has('caption'),false);
 assert.equal(requests[4].options.body.get('media_type'),'CAROUSEL');assert.equal(requests[4].options.body.get('children'),'11,22');assert.equal(requests[4].options.body.get('caption'),'shared');
 const failure=instagramService(env,async()=>Response.json({error:{code:190,message:env.IG_ACCESS_TOKEN}},{status:400}));
 await assert.rejects(()=>failure.publish('123'),e=>e.message.includes('190')&&!e.message.includes(env.IG_ACCESS_TOKEN));
});
test('media URL needs unguessable active token and expiry; admin auth/CSRF still enforced',async t=>{
 const f=fixture();t.after(()=>f.close());await f.schedule();const url='https://example.test/api/instagram-media/x.jpg';
 const token=f.raw.prepare('SELECT image_token FROM instagram_items').get().image_token;
 await assert.rejects(()=>instagramMedia(new Request(url),f.env,token),e=>e.status===404);
 f.raw.exec("UPDATE instagram_queue SET image_expires_at='2099-01-01'");assert.equal((await instagramMedia(new Request(url),f.env,token)).status,200);
 await assert.rejects(()=>instagramMedia(new Request(url),f.env,crypto.randomUUID()),e=>e.status===404);
 await assert.rejects(()=>instagramHandler(new Request('https://example.test/api/admin/submissions/1/retry-publish',{method:'POST'}),f.env,{provider:'access'},'/api/admin/submissions/1/retry-publish'),e=>e.code==='CSRF_INVALID');
 const env={...f.env,APP_ENV:'development',ADMIN_AUTH_PROVIDER:'dev',DEV_ADMIN_MODE:'true',DEV_ADMIN_TOKEN:'isolated-local-runtime-test-token'};
 assert.equal((await handleApiRequest(new Request('https://example.test/api/admin/instagram'),env)).status,401);
 assert.equal((await processInstagramQueue({})).status,'disabled');
 assert.throws(()=>validateJpeg(new Uint8Array(20)));assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('real workerd D1 atomically claims a queue row and commits the publish ledger',async t=>{
 const bundle=await build({stdin:{contents:`import {processInstagramQueue} from './worker/src/repositories/instagram-queue.js';export default {async fetch(request,env){return Response.json(await processInstagramQueue(env,{service:{create:async()=> '123',status:async()=> 'FINISHED',publish:async()=> '456'}}));}}`,resolveDir:process.cwd()},bundle:true,format:'esm',platform:'browser',write:false});
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-31',d1Databases:['DB'],bindings:{IG_PUBLISH_ENABLED:'true',IG_MEDIA_ORIGIN:'https://example.test'}}));t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
 for(const name of ['0001_create_submissions','0002_create_admin_auth','0004_add_local_admin_auth','0005_add_access_email','0006_access_only_admins','0007_image_drafts','0008_single_dispatch','0009_studio_removals','0010_instagram_publish_queue','0011_multiple_send_batches','0012_automatic_locked_batches','0013_instagram_preparation','0014_instagram_caption_edits'])await db.exec(readFileSync(new URL(`../migrations/${name}.sql`,import.meta.url),'utf8').replace(/^--.*$/gm,'').replace(/[\r\n]/g,' '));
 await db.exec("INSERT INTO admins(id,access_email,role) VALUES(1,'a@example.test','owner'); INSERT INTO submissions(id,content,status) VALUES(1,'original','approved'); INSERT INTO send_batches(id,state,caption,generation,editor_id) VALUES('batch','prepared','caption','generation',1); INSERT INTO send_items(batch_id,position,submission_id,version_id,number,object_key) VALUES('batch',0,1,'v1',109,'original.png');");
 await db.prepare('INSERT INTO send_uploads VALUES(?,?)').bind('test.jpg','2099-01-01').run();
 const upload=await stageInstagramImage(db,{id:'batch',generation:'generation',position:0,key:'test.jpg'});
 await scheduleInstagram(db,{id:'batch',revision:1,generation:'generation',publishAt:'2020-01-01T00:00:00.000Z',uploads:[upload]},principal);
 const edited=await updateInstagramCaption(db,'batch',{revision:1,customText:'D1 trigger caption test'},principal);
 assert.equal(await db.prepare("SELECT caption FROM send_batches WHERE id='batch'").first('caption'),edited.caption);
 assert.equal(await db.prepare("SELECT count(*) n FROM audit_logs WHERE action='ig_caption_updated'").first('n'),1);
 assert.deepEqual(await(await mf.dispatchFetch('https://example.test/run')).json(),{status:'published'});
 assert.equal(await db.prepare('SELECT instagram_media_id FROM instagram_queue').first('instagram_media_id'),'456');
 assert.equal(await db.prepare('SELECT last_number FROM send_progress').first('last_number'),109);
 assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
});
