import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestDatabase} from './helpers/d1.js';
import {listPendingSubmissionsHandler} from '../worker/src/handlers/submissions.js';
test('cursor pagination reads beyond 100 without losing rows when earlier submissions are reviewed',async t=>{
 const f=createTestDatabase();t.after(()=>f.close());
 for(let id=1;id<=235;id++)f.raw.prepare('INSERT INTO submissions(id,content,created_at) VALUES(?,?,?)').run(id,'test','2026-01-01T00:00:00Z');
 const read=async after=>(await(await listPendingSubmissionsHandler(new Request('https://example.test/api/admin/submissions?limit=100'+(after?'&after='+after:'')),{DB:f.DB})).json()).data;
 const first=await read();assert.equal(first.submissions.length,100);assert.equal(first.meta.total,235);
 f.raw.exec("UPDATE submissions SET status='approved' WHERE id<=100");
 const second=await read(first.meta.nextCursor),third=await read(second.meta.nextCursor);
 assert.equal(second.submissions[0].id,101);assert.equal(second.submissions.length,100);assert.equal(third.submissions.length,35);assert.equal(third.meta.nextCursor,null);
 assert.equal(new Set([...first.submissions,...second.submissions,...third.submissions].map(s=>s.id)).size,235);
 for(const after of ['0','-1','oops','1.5'])await assert.rejects(()=>read(after),e=>e.status===400);
});
