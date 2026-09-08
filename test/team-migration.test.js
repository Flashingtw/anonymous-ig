import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTestDatabase } from "./helpers/d1.js";

export function migrateTeam(db) {
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    db.raw.exec(readFileSync(new URL("../migrations/0006_access_only_admins.sql", import.meta.url), "utf8"));
    db.raw.exec("COMMIT");
  } catch (error) { db.raw.exec("ROLLBACK"); throw error; }
}

test("0006 preserves populated identities, sessions, audits and owner guards while allowing Access-only admins", t => {
  const db = createTestDatabase({ team: false }); t.after(() => db.close());
  db.raw.exec(`INSERT INTO admins(id,github_user_id,github_username,role,access_email) VALUES(1,'101','owner','owner','Owner@Example.com'),(2,'202','disabled','moderator',NULL);
    UPDATE admins SET enabled=0 WHERE id=2;
    UPDATE admins SET username='owner.local',username_normalized='owner.local',password_hash='${"fixture-not-a-password-".repeat(4)}',password_updated_at='2026-09-01' WHERE id=1;
    INSERT INTO admin_sessions(token_hash,admin_id,expires_at) VALUES('${"a".repeat(64)}',1,'2099-01-01');
    INSERT INTO audit_logs(admin_id,action,metadata) VALUES(1,'login','{}');`);
  db.raw.exec("INSERT INTO admins(id,github_user_id,github_username) VALUES(99,'999','deleted-fixture'); DELETE FROM admins WHERE id=99; INSERT INTO audit_logs(id,admin_id,action) VALUES(99,1,'fixture'); DELETE FROM audit_logs WHERE id=99;");
  const tables = ["admins", "admin_sessions", "audit_logs"];
  const before = tables.map(name => db.raw.prepare(`SELECT * FROM ${name} ORDER BY 1`).all());
  migrateTeam(db);
  tables.forEach((name,i) => assert.deepEqual(db.raw.prepare(`SELECT * FROM ${name} ORDER BY 1`).all(), before[i]));
  db.raw.exec("INSERT INTO admins(access_email,role) VALUES(' Friend@Example.com ','moderator')");
  const friend = db.raw.prepare("SELECT * FROM admins WHERE access_email_normalized='friend@example.com'").get();
  assert.equal(friend.github_user_id,null); assert.equal(friend.username,null); assert.equal(friend.password_hash,null);
  assert.equal(friend.enabled,1);
  assert.ok(friend.id>99,"AUTOINCREMENT must not reuse a previously issued admin ID");
  db.raw.exec("INSERT INTO audit_logs(admin_id,action) VALUES(1,'migration_test')");
  assert.ok(db.raw.prepare("SELECT max(id) AS id FROM audit_logs").get().id>99);
  assert.throws(() => db.raw.exec("INSERT INTO admins(role) VALUES('moderator')"), /CHECK/);
  assert.throws(() => db.raw.exec("INSERT INTO admins(access_email) VALUES('friend@example.com')"), /UNIQUE/);
  assert.throws(() => db.raw.exec("UPDATE admins SET enabled=0 WHERE id=1"), /LAST_ENABLED_OWNER/);
  assert.deepEqual(db.raw.prepare("PRAGMA foreign_key_check").all(), []);
});

test("0006 keeps GitHub/local-only identities, rejects incomplete identities and preserves FK/UNIQUE", t => {
  const db = createTestDatabase(); t.after(() => db.close());
  db.raw.exec("INSERT INTO admins(github_user_id,github_username,role) VALUES('101','owner','owner')");
  db.raw.exec(`INSERT INTO admins(username,username_normalized,password_hash,password_updated_at) VALUES('local.user','local.user','${"x".repeat(80)}','2026-09-01')`);
  assert.throws(() => db.raw.exec("INSERT INTO admins(github_user_id) VALUES('303')"), /CHECK/);
  assert.throws(() => db.raw.exec("INSERT INTO admins(username) VALUES('incomplete')"), /CHECK/);
  assert.throws(() => db.raw.exec("INSERT INTO admins(github_user_id,github_username) VALUES('101','duplicate')"), /UNIQUE/);
  assert.throws(() => db.raw.exec(`INSERT INTO admin_sessions(token_hash,admin_id,expires_at) VALUES('${"b".repeat(64)}',999,'2099-01-01')`), /FOREIGN KEY/);
  assert.throws(() => db.raw.exec("UPDATE admins SET role='admin' WHERE id=1"), /LAST_ENABLED_OWNER/);
  assert.throws(() => db.raw.exec("DELETE FROM admins WHERE id=1"), /LAST_ENABLED_OWNER/);
  assert.deepEqual(db.raw.prepare("PRAGMA foreign_key_check").all(), []);
});
