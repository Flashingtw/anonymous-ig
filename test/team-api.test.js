import assert from "node:assert/strict";
import test from "node:test";
import { handleApiRequest } from "../worker/src/index.js";
import { createTestDatabase } from "./helpers/d1.js";
import { accessEnv, accessToken, accessJwks } from "./helpers/access.js";

function fixture(t) {
  const db=createTestDatabase();t.after(()=>db.close());
  db.raw.exec("INSERT INTO admins(id,github_user_id,github_username,access_email,role) VALUES(1,'101','original-owner','owner@example.com','owner'); INSERT INTO admins(access_email,role) VALUES('admin@example.com','admin'),('moderator@example.com','moderator')");
  const env={...accessEnv,DB:db.DB,APP_ENV:"production",ACCESS_AUTH_ENABLED:"true",LOCAL_AUTH_ENABLED:"false",SESSION_SECRET:"local-test-session-secret-at-least-32-characters"};
  const call=(path,options={})=>handleApiRequest(new Request('https://admin.example.test'+path,options),env,{accessJwks});
  const login=async email=>{
    const r=await call('/api/auth/access',{headers:{'Cf-Access-Jwt-Assertion':await accessToken({email})}});
    assert.equal(r.status,302);
    const Cookie=r.headers.get('set-cookie').split(';')[0];
    const me=(await (await call('/api/auth/me',{headers:{Cookie}})).json()).data;
    return {Cookie,me};
  };
  return {db,call,login};
}
test("admin directory is owner-only, sanitized and read-only at the HTTP boundary",async t=>{
  const {call,login}=fixture(t);
  assert.equal((await call('/api/admin/admins')).status,401);
  for(const role of ['owner','admin','moderator']) {
    const {Cookie}=await login(`${role}@example.com`);
    const r=await call('/api/admin/admins',{headers:{Cookie}});
    assert.equal(r.status,role==='owner'?200:403);
    if(role==='owner') {
      const data=(await r.json()).data;
      assert.equal(data.admins.length,3);
      assert.deepEqual(data.admins[2].providers,['access']);
      assert.equal(data.admins[2].email,'moderator@example.com');
      assert.doesNotMatch(JSON.stringify(data),/password|token|secret/i);
    }
    for(const method of ['POST','PATCH','DELETE']) assert.equal((await call('/api/admin/admins',{method,headers:{Cookie}})).status,role==='owner'?405:403);
  }
});

for(const role of ['owner','admin','moderator']) test(`${role} can list, approve and reject with existing CSRF protection`,async t=>{
  const {call,login}=fixture(t);
  const {Cookie,me}=await login(`${role}@example.com`);
  assert.equal(me.user.role,role);
  for(const action of ['approve','reject']) {
    const submitted=await call('/api/submissions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:`Local role fixture ${action}`})});
    const id=(await submitted.json()).data.submission.id;
    const listed=(await (await call('/api/admin/submissions',{headers:{Cookie}})).json()).data.submissions;
    assert.ok(listed.some(s=>s.id===id));
    assert.equal((await call(`/api/admin/submissions/${id}/${action}`,{method:'POST',headers:{Cookie}})).status,403);
    const r=await call(`/api/admin/submissions/${id}/${action}`,{method:'POST',headers:{Cookie,'X-CSRF-Token':me.csrfToken}});
    assert.equal(r.status,200);
    assert.equal((await r.json()).data.submission.status,action==='approve'?'approved':'rejected');
  }
});

test("Access-only identity is normalized, visible, session-backed and never auto-registered",async t=>{
  const {call,login,db}=fixture(t);
  const {Cookie,me}=await login(' MODERATOR@EXAMPLE.COM ');
  assert.equal(me.user.accessEmail,'moderator@example.com');
  assert.equal(me.user.adminId,3);
  assert.equal(me.user.githubUsername,null);assert.equal(me.user.username,null);
  assert.deepEqual(me.user.authMethods,['access']);
  db.raw.exec("UPDATE admins SET enabled=0 WHERE id=3");
  assert.equal((await call('/api/admin/submissions',{headers:{Cookie}})).status,401);
  for(const email of ['moderator@example.com','unknown@example.com']) {
    const r=await call('/api/auth/access',{headers:{'Cf-Access-Jwt-Assertion':await accessToken({email})}});
    assert.equal(r.status,403);assert.equal(r.headers.get('set-cookie'),null);
  }
  assert.equal(db.raw.prepare('SELECT count(*) AS n FROM admins').get().n,3);
});
