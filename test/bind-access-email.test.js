import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTestDatabase } from "./helpers/d1.js";
import { runCli, parseArguments } from "../scripts/bind-access-email.js";

function fixture(t) {
  const db = createTestDatabase({ access: false }); t.after(() => db.close());
  db.raw.exec(readFileSync(new URL("../migrations/0005_add_access_email.sql", import.meta.url), "utf8"));
  db.raw.exec("INSERT INTO admins(id,github_user_id,github_username,role) VALUES(1,'101','owner','owner')");
  const messages = [];
  return { db, messages, dependencies: {
    query: async ({ sql }) => db.raw.prepare(sql).all(),
    execute: async ({ sql }) => {
      db.raw.exec("BEGIN IMMEDIATE");
      try { db.raw.exec(sql); db.raw.exec("COMMIT"); } catch (error) { db.raw.exec("ROLLBACK"); throw error; }
    }, logger: { log: message => messages.push(message) }
  } };
}
const args = ["--github-user-id", "101", "--email", " Owner@Example.com ", "--local"];

test("binding rejects bad options, missing target and malformed email", () => {
  for (const argv of [[], args.slice(0, -1), [...args, "--remote"], [...args, "--password", "secret"], [...args, "--role", "owner"], ["--github-user-id", "abc", "--email", "x@y.test", "--local"], ["--github-user-id", "101", "--email", "bad", "--local"]]) {
    assert.throws(() => parseArguments(argv));
  }
});

test("binding dry-run names the existing owner and normalized email without writes", async (t) => {
  const { db, dependencies, messages } = fixture(t);
  const before = db.raw.prepare("SELECT * FROM admins").all();
  await runCli(args, { ...dependencies, execute: () => assert.fail("dry-run write") });
  assert.match(messages.join("\n"), /admin id 1/);
  assert.match(messages.join("\n"), /owner@example.com/);
  assert.deepEqual(db.raw.prepare("SELECT * FROM admins").all(), before);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n, 0);
});

test("binding adds normalized email on the same owner, preserves identity and sessions, and audits", async (t) => {
  const { db, dependencies } = fixture(t);
  db.raw.exec(`INSERT INTO admin_sessions(token_hash,admin_id,expires_at) VALUES('${"a".repeat(64)}',1,'2099-01-01')`);
  const before = db.raw.prepare("SELECT * FROM admins WHERE id=1").get();
  await runCli([...args, "--execute"], dependencies);
  const after = db.raw.prepare("SELECT * FROM admins WHERE id=1").get();
  for (const field of ["id", "github_user_id", "github_username", "role", "enabled", "created_at", "username", "password_hash", "password_updated_at"]) assert.equal(after[field], before[field]);
  assert.equal(after.access_email, "owner@example.com");
  assert.equal(after.access_email_normalized, "owner@example.com");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM admins").get().n, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM admin_sessions").get().n, 1);
  const audit = db.raw.prepare("SELECT * FROM audit_logs").get();
  assert.equal(audit.action, "admin_access_email_bound");
  assert.deepEqual(JSON.parse(audit.metadata), { source: "bind-access-email-cli", target_admin_id: 1, provider: "cloudflare_access" });
});

test("duplicate, disabled and previously bound admins are rejected", async (t) => {
  const { db, dependencies } = fixture(t);
  db.raw.exec("INSERT INTO admins(id,github_user_id,github_username,role,enabled,access_email) VALUES(2,'202','other','moderator',0,'owner@example.com')");
  await assert.rejects(runCli([...args, "--execute"], dependencies), /Duplicate/);
  await assert.rejects(runCli(["--github-user-id","202","--email","new@example.com","--local","--execute"], dependencies), /disabled/);
  db.raw.exec("UPDATE admins SET access_email=NULL WHERE id=2");
  await runCli([...args,"--execute"], dependencies);
  await assert.rejects(runCli([...args,"--execute"], dependencies), /already/);
});

test("audit failure rolls back binding; preview race cannot bind a changed identity", async (t) => {
  const { db, dependencies } = fixture(t);
  db.raw.exec("CREATE TRIGGER fail_access_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'test failure'); END");
  await assert.rejects(runCli([...args,"--execute"], dependencies), /binding failed or outcome unavailable/);
  assert.equal(db.raw.prepare("SELECT access_email FROM admins WHERE id=1").get().access_email, null);
  db.raw.exec("DROP TRIGGER fail_access_audit");
  await assert.rejects(runCli([...args,"--execute"], { ...dependencies, execute: async request => {
    db.raw.exec("UPDATE admins SET github_user_id='999' WHERE id=1");
    await dependencies.execute(request);
  } }), /binding failed or outcome unavailable/);
  assert.equal(db.raw.prepare("SELECT access_email FROM admins WHERE id=1").get().access_email, null);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n, 0);
});
