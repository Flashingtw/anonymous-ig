import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "./helpers/d1.js";
import { runCli, parseArguments } from "../scripts/create-access-admin.js";

const args = ["--email", " Friend@Example.com ", "--role", "moderator", "--local"];
function fixture(t) {
  const db = createTestDatabase(); t.after(() => db.close());
  const messages=[];
  return { db, messages, dependencies: {
    query: async ({sql}) => db.raw.prepare(sql).all(),
    execute: async ({sql}) => {
      db.raw.exec("BEGIN IMMEDIATE");
      try { db.raw.exec(sql); db.raw.exec("COMMIT"); } catch(error) { db.raw.exec("ROLLBACK"); throw error; }
    }, logger:{log:message=>messages.push(message)}
  }};
}
test("create-access normalizes email and defaults to dry-run without any writes", async t => {
  const {db,messages,dependencies}=fixture(t);
  assert.equal(parseArguments(args).email,"friend@example.com");
  await runCli(args,{...dependencies,execute:()=>assert.fail("dry-run must not write")});
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM admins").get().n,0);
  assert.match(messages.join("\n"),/friend@example.com/);
});

test("execute creates enabled Access-only moderator and atomic redacted audit; duplicate email rejected", async t => {
  const {db,dependencies}=fixture(t);
  await runCli([...args,"--execute"],dependencies);
  const row=db.raw.prepare("SELECT * FROM admins").get();
  assert.equal(row.access_email,"friend@example.com");assert.equal(row.role,"moderator");assert.equal(row.enabled,1);
  for(const field of ["github_user_id","github_username","username","username_normalized","password_hash","password_updated_at"]) assert.equal(row[field],null);
  const audit=db.raw.prepare("SELECT * FROM audit_logs").get();
  assert.equal(audit.action,"admin_access_created");
  assert.deepEqual(JSON.parse(audit.metadata),{source:"create-access-cli",target_admin_id:row.id,role:"moderator",provider:"cloudflare_access"});
  await assert.rejects(runCli([...args,"--execute"],dependencies),/Duplicate/);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM admins").get().n,1);
});

test("owner and malformed CLI arguments rejected; admin role explicitly allowed", () => {
  for(const role of ["owner","superadmin","","ADMIN"]) assert.throws(()=>parseArguments(["--email","a@example.com","--role",role,"--local"]));
  for(const input of [[],["--email","bad","--local"],[...args,"--remote"],[...args,"--password","secret"],[...args,"--execute","--execute"]]) assert.throws(()=>parseArguments(input));
  assert.equal(parseArguments(["--email","a@example.com","--role","admin","--remote"]).execute,false);
});

test("audit failure rolls back create, and concurrent duplicate cannot insert another row", async t => {
  const {db,dependencies}=fixture(t);
  db.raw.exec("CREATE TRIGGER fail_team_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  await assert.rejects(runCli([...args,"--execute"],dependencies),/failed or outcome/);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM admins").get().n,0);
  db.raw.exec("DROP TRIGGER fail_team_audit");
  await assert.rejects(runCli([...args,"--execute"],{...dependencies,execute: async request=>{
    db.raw.exec("INSERT INTO admins(access_email) VALUES('friend@example.com')");
    return dependencies.execute(request);
  }}),/failed or outcome/);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM admins").get().n,1);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM audit_logs").get().n,0);
});
