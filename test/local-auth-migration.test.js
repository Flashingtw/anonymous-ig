import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationUrls = [
  "../migrations/0001_create_submissions.sql",
  "../migrations/0002_create_admin_auth.sql",
  "../migrations/0004_add_local_admin_auth.sql"
].map((path) => new URL(path, import.meta.url));

const VALID_PASSWORD_HASH =
  "pbkdf2_sha256$600000$AAAAAAAAAAAAAAAAAAAAAA$ugOc1PYTYVrYARTBAxO2PaLIrS8ZrmgPBiK21-ydJRs";
const UPDATED_AT = "2026-01-02T03:04:05.000Z";

function migrationSql(index) {
  return readFileSync(migrationUrls[index], "utf8");
}

function databaseThrough(version) {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  for (let index = 0; index < version; index += 1) {
    database.exec(migrationSql(index));
  }
  return database;
}

function insertIdentity(database, {
  githubUserId = null,
  githubUsername = null,
  username = null,
  usernameNormalized = null,
  passwordHash = null,
  passwordUpdatedAt = null,
  role = "admin",
  enabled = 1
} = {}) {
  return database.prepare(`
    INSERT INTO admins (
      github_user_id,
      github_username,
      username,
      username_normalized,
      password_hash,
      password_updated_at,
      role,
      enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(
    githubUserId,
    githubUsername,
    username,
    usernameNormalized,
    passwordHash,
    passwordUpdatedAt,
    role,
    enabled
  ).id;
}

function plainRow(row) {
  return { ...row };
}

test("0004 preserves 0001-0002 admins, sessions, audit logs, submissions, and foreign keys", (t) => {
  const database = databaseThrough(2);
  t.after(() => database.close());

  const adminId = database.prepare(`
    INSERT INTO admins (
      github_user_id, github_username, role, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get("123456", "legacy-owner", "owner", 1, UPDATED_AT, UPDATED_AT).id;
  const submissionId = database.prepare("INSERT INTO submissions (content, status) VALUES ('legacy submission', 'approved') RETURNING id").get().id;
  const tokenHash = "a".repeat(64);
  database.prepare(`
    INSERT INTO admin_sessions (token_hash, admin_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(tokenHash, adminId, "2099-01-01T00:00:00.000Z", UPDATED_AT);
  const auditId = database.prepare(`
    INSERT INTO audit_logs (
      admin_id, action, submission_id, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?)
    RETURNING id
  `).get(adminId, "legacy_action", submissionId, '{"kept":true}', UPDATED_AT).id;

  database.exec(migrationSql(2));

  assert.deepEqual(plainRow(database.prepare(`
    SELECT id, github_user_id, github_username, username, username_normalized,
           password_hash, password_updated_at, role, enabled, created_at, updated_at
    FROM admins WHERE id = ?
  `).get(adminId)), {
    id: adminId,
    github_user_id: "123456",
    github_username: "legacy-owner",
    username: null,
    username_normalized: null,
    password_hash: null,
    password_updated_at: null,
    role: "owner",
    enabled: 1,
    created_at: UPDATED_AT,
    updated_at: UPDATED_AT
  });
  assert.deepEqual(plainRow(database.prepare(`
    SELECT token_hash, admin_id, expires_at, created_at
    FROM admin_sessions
  `).get()), {
    token_hash: tokenHash,
    admin_id: adminId,
    expires_at: "2099-01-01T00:00:00.000Z",
    created_at: UPDATED_AT
  });
  assert.deepEqual(plainRow(database.prepare(`
    SELECT id, admin_id, action, submission_id, metadata, created_at
    FROM audit_logs WHERE id = ?
  `).get(auditId)), {
    id: auditId,
    admin_id: adminId,
    action: "legacy_action",
    submission_id: submissionId,
    metadata: '{"kept":true}',
    created_at: UPDATED_AT
  });
  assert.deepEqual(plainRow(database.prepare("SELECT content, status FROM submissions WHERE id = ?").get(submissionId)), { content: "legacy submission", status: "approved" });
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.throws(
    () => database.prepare(`
      INSERT INTO admin_sessions (token_hash, admin_id, expires_at)
      VALUES (?, ?, ?)
    `).run("b".repeat(64), 999999, "2099-01-01T00:00:00.000Z"),
    /FOREIGN KEY constraint failed/
  );
});

test("0004 accepts local-only, GitHub-only, and dual identities", (t) => {
  const database = databaseThrough(3);
  t.after(() => database.close());

  const localId = insertIdentity(database, {
    username: "Local.User",
    usernameNormalized: "local.user",
    passwordHash: VALID_PASSWORD_HASH,
    passwordUpdatedAt: UPDATED_AT
  });
  const githubId = insertIdentity(database, {
    githubUserId: "2001",
    githubUsername: "github-only"
  });
  const dualId = insertIdentity(database, {
    githubUserId: "2002",
    githubUsername: "dual-github",
    username: "Dual.User",
    usernameNormalized: "dual.user",
    passwordHash: VALID_PASSWORD_HASH,
    passwordUpdatedAt: UPDATED_AT
  });

  assert.deepEqual(plainRow(database.prepare(`
    SELECT github_user_id, username_normalized FROM admins WHERE id = ?
  `).get(localId)), { github_user_id: null, username_normalized: "local.user" });
  assert.deepEqual(plainRow(database.prepare(`
    SELECT github_user_id, username_normalized FROM admins WHERE id = ?
  `).get(githubId)), { github_user_id: "2001", username_normalized: null });
  assert.deepEqual(plainRow(database.prepare(`
    SELECT github_user_id, username_normalized FROM admins WHERE id = ?
  `).get(dualId)), { github_user_id: "2002", username_normalized: "dual.user" });
});

test("0004 rejects missing or partial identities and case-insensitive username collisions", (t) => {
  const database = databaseThrough(3);
  t.after(() => database.close());

  assert.throws(() => insertIdentity(database), /CHECK constraint failed/);
  assert.throws(() => insertIdentity(database, {
    githubUserId: "3001"
  }), /CHECK constraint failed/);
  assert.throws(() => insertIdentity(database, {
    username: "Partial.User",
    usernameNormalized: "partial.user"
  }), /CHECK constraint failed/);
  assert.throws(() => insertIdentity(database, {
    username: "Partial.User",
    usernameNormalized: "partial.user",
    passwordHash: VALID_PASSWORD_HASH
  }), /CHECK constraint failed/);

  insertIdentity(database, {
    username: "Case.User",
    usernameNormalized: "case.user",
    passwordHash: VALID_PASSWORD_HASH,
    passwordUpdatedAt: UPDATED_AT
  });
  assert.throws(() => insertIdentity(database, {
    username: "cASE.uSER",
    usernameNormalized: "case.user",
    passwordHash: VALID_PASSWORD_HASH,
    passwordUpdatedAt: UPDATED_AT
  }), /UNIQUE constraint failed: admins\.username_normalized/);
  assert.throws(() => insertIdentity(database, {
    username: "Bad.Normalization",
    usernameNormalized: "BAD.NORMALIZATION",
    passwordHash: VALID_PASSWORD_HASH,
    passwordUpdatedAt: UPDATED_AT
  }), /CHECK constraint failed/);
  assert.throws(() => insertIdentity(database, {
    username: "Alice",
    usernameNormalized: "someone.else",
    passwordHash: VALID_PASSWORD_HASH,
    passwordUpdatedAt: UPDATED_AT
  }), /CHECK constraint failed/);
  assert.throws(() => insertIdentity(database, {
    username: "unsafe user",
    usernameNormalized: "safe.user",
    passwordHash: VALID_PASSWORD_HASH,
    passwordUpdatedAt: UPDATED_AT
  }), /CHECK constraint failed/);
});

test("0004 prevents disabling, demoting, or deleting the last enabled owner", (t) => {
  const database = databaseThrough(3);
  t.after(() => database.close());
  const ownerId = insertIdentity(database, {
    githubUserId: "4001",
    githubUsername: "only-owner",
    role: "owner"
  });
  insertIdentity(database, {
    githubUserId: "4002",
    githubUsername: "disabled-owner",
    role: "owner",
    enabled: 0
  });

  assert.throws(
    () => database.prepare("UPDATE admins SET enabled = 0 WHERE id = ?").run(ownerId),
    /LAST_ENABLED_OWNER/
  );
  assert.throws(
    () => database.prepare("UPDATE admins SET role = 'admin' WHERE id = ?").run(ownerId),
    /LAST_ENABLED_OWNER/
  );
  assert.throws(
    () => database.prepare("DELETE FROM admins WHERE id = ?").run(ownerId),
    /LAST_ENABLED_OWNER/
  );
  assert.deepEqual(plainRow(database.prepare(`
    SELECT role, enabled FROM admins WHERE id = ?
  `).get(ownerId)), { role: "owner", enabled: 1 });

  const secondOwnerId = insertIdentity(database, {
    githubUserId: "4003",
    githubUsername: "second-owner",
    role: "owner"
  });
  assert.equal(
    Number(database.prepare("UPDATE admins SET enabled = 0 WHERE id = ?").run(ownerId).changes),
    1
  );
  assert.throws(
    () => database.prepare("UPDATE admins SET role = 'admin' WHERE id = ?").run(secondOwnerId),
    /LAST_ENABLED_OWNER/
  );
});
