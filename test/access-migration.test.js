import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTestDatabase } from "./helpers/d1.js";

test("0005 preserves populated 0004 identities, sessions and audits; email starts NULL and is unique", (t) => {
  const db = createTestDatabase({ access: false });
  t.after(() => db.close());
  db.raw.exec(`INSERT INTO admins(id, github_user_id, github_username, role) VALUES (1, '101', 'owner', 'owner'), (2, '202', 'disabled', 'moderator');
    UPDATE admins SET enabled=0 WHERE id=2;
    UPDATE admins SET username='existing.local', username_normalized='existing.local', password_hash='${"test-hash-preserved-".repeat(5)}', password_updated_at='2026-09-01T00:00:00Z' WHERE id=1;
    INSERT INTO admin_sessions(token_hash, admin_id, expires_at) VALUES ('${"a".repeat(64)}', 1, '2099-01-01');
    INSERT INTO audit_logs(admin_id,action,metadata) VALUES (1,'login','{}');`);
  const before = Object.fromEntries(["admins", "admin_sessions", "audit_logs"].map(name => [name, db.raw.prepare(`SELECT * FROM ${name}`).all()]));
  db.raw.exec(readFileSync(new URL("../migrations/0005_add_access_email.sql", import.meta.url), "utf8"));
  const after = db.raw.prepare("SELECT * FROM admins").all();
  for (const row of after) {
    assert.equal(row.access_email, null); assert.equal(row.access_email_normalized, null);
    delete row.access_email; delete row.access_email_normalized;
  }
  assert.deepEqual(after, before.admins);
  for (const name of ["admin_sessions", "audit_logs"]) assert.deepEqual(db.raw.prepare(`SELECT * FROM ${name}`).all(), before[name]);
  db.raw.exec("UPDATE admins SET access_email='Owner@Example.com' WHERE id=1");
  assert.equal(db.raw.prepare("SELECT access_email_normalized FROM admins WHERE id=1").get().access_email_normalized, "owner@example.com");
  assert.throws(() => db.raw.exec("UPDATE admins SET access_email='owner@example.com' WHERE id=2"), /UNIQUE/);
  assert.deepEqual(db.raw.prepare("PRAGMA foreign_key_check").all(), []);
});
