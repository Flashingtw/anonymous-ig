import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeSql, runCli } from "../scripts/manage-admin.js";
import { verifyPassword } from "../worker/src/security/passwords.js";
import { runCli as bindAccessEmail } from "../scripts/bind-access-email.js";
import { runCli as createAccessAdmin } from "../scripts/create-access-admin.js";

test("real Wrangler binds in an isolated D1 and rolls back an audit failure", { timeout: 120_000 }, async (t) => {
  const persistence = await mkdtemp(join(tmpdir(), "anonymous-bind-test-"));
  t.after(() => rm(persistence, { recursive: true, force: true }));
  const execute = (request) => executeSql({ ...request, target: "local" }, {
    spawn: (executable, args, options) => spawnSync(executable,
      [...args, "--persist-to", persistence], {
        ...options, timeout: 30_000,
        env: { ...options.env, WRANGLER_LOG_PATH: options.env.WRANGLER_LOG_PATH ?? persistence }
      }),
    stdout: { write() {} }, stderr: { write() {} }
  });
  const query = (request) => execute({ ...request, json: true });
  // Apply only 0001+0002+0004: owner binding has no renderer schema dependency.
  const schema = (await Promise.all([
    "0001_create_submissions", "0002_create_admin_auth", "0004_add_local_admin_auth"
  ].map((name) => readFile(new URL(`../migrations/${name}.sql`, import.meta.url), "utf8")))).join("\n");
  await execute({ sql: schema, sensitive: true });
  await execute({ sql: "INSERT INTO admins (id, github_user_id, github_username, role) VALUES (7, '101', 'owner', 'owner'), (8, '202', 'other', 'admin');" });
  const argv = ["bind-local", "--github-user-id", "101", "--username", "Owner.Local", "--local"];
  const messages = [];
  const dependencies = { query, execute, logger: { log: (message) => messages.push(message) } };
  await runCli(argv, { ...dependencies, passwordReader: () => assert.fail("preview must not prompt") });
  assert.match(messages.join("\n"), /admin id 7/);
  const before = await query({ sql: "SELECT id, github_user_id, role, username FROM admins ORDER BY id;" });
  assert.equal(before[0].username, null);
  await runCli([...argv, "--execute"], { ...dependencies, passwordReader: async () => "Bind8abc" });
  const after = await query({ sql: "SELECT id, github_user_id, role, username, password_hash FROM admins ORDER BY id;" });
  assert.equal(after.length, 2);
  assert.equal(after[0].id, 7);
  assert.equal(after[0].github_user_id, "101");
  assert.equal(after[0].role, "owner");
  assert.equal(after[0].username, "Owner.Local");
  assert.equal(await verifyPassword("Bind8abc", after[0].password_hash), true);
  await execute({ sql: "CREATE TRIGGER fail_bind_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'AUDIT_UNAVAILABLE'); END;" });
  await assert.rejects(() => runCli([
    "bind-local", "--github-user-id", "202", "--username", "Other.Local", "--local", "--execute"
  ], { ...dependencies, passwordReader: async () => "Other8ab" }), /Wrangler exited/);
  const untouched = await query({ sql: "SELECT username, password_hash FROM admins WHERE id = 8;" });
  assert.equal(untouched[0].username, null);
  assert.equal(untouched[0].password_hash, null);
  assert.doesNotMatch(messages.join("\n"), /Bind8abc|Other8ab|pbkdf2_sha256/);
  // Additive Access migration and CLI use the same real D1 file transaction.
  await execute({ sql: "DROP TRIGGER fail_bind_audit;" });
  await execute({ sql: await readFile(new URL("../migrations/0005_add_access_email.sql", import.meta.url), "utf8"), sensitive: true });
  const accessArgs = ["--github-user-id", "101", "--email", " Owner@Example.com ", "--local"];
  await bindAccessEmail(accessArgs, dependencies);
  assert.equal((await query({ sql: "SELECT access_email FROM admins WHERE id=7" }))[0].access_email, null);
  await bindAccessEmail([...accessArgs, "--execute"], dependencies);
  const bound = await query({ sql: "SELECT id,github_user_id,role,username,password_hash,access_email FROM admins ORDER BY id" });
  assert.equal(bound.length, 2);
  assert.deepEqual({ ...bound[0], access_email: undefined }, { ...after[0], access_email: undefined });
  assert.equal(bound[0].access_email, "owner@example.com");
  assert.equal((await query({ sql: "SELECT COUNT(*) AS n FROM audit_logs WHERE action='admin_access_email_bound'" }))[0].n, 1);
  await execute({ sql: "CREATE TRIGGER fail_access_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'AUDIT_UNAVAILABLE'); END;" });
  await assert.rejects(bindAccessEmail(["--github-user-id", "202", "--email", "other@example.com", "--local", "--execute"], dependencies), /binding failed/);
  assert.equal((await query({ sql: "SELECT access_email FROM admins WHERE id=8" }))[0].access_email, null);
  await execute({ sql: "DROP TRIGGER fail_access_audit;" });
  // 0006 must also work in real local D1 with populated parent/child tables.
  const preserved = await query({ sql: "SELECT * FROM admins ORDER BY id" });
  const sessions = await query({ sql: "SELECT * FROM admin_sessions ORDER BY token_hash" });
  const audits = await query({ sql: "SELECT * FROM audit_logs ORDER BY id" });
  await execute({ sql: await readFile(new URL("../migrations/0006_access_only_admins.sql", import.meta.url), "utf8"), sensitive: true });
  assert.deepEqual(await query({ sql: "SELECT * FROM admins ORDER BY id" }), preserved);
  assert.deepEqual(await query({ sql: "SELECT * FROM admin_sessions ORDER BY token_hash" }), sessions);
  assert.deepEqual(await query({ sql: "SELECT * FROM audit_logs ORDER BY id" }), audits);
  assert.deepEqual(await query({ sql: "PRAGMA foreign_key_check" }), []);
  const createArgs = ["--email", " Friend@Example.com ", "--role", "moderator", "--local"];
  await createAccessAdmin(createArgs, dependencies);
  assert.equal((await query({ sql: "SELECT count(*) AS n FROM admins" }))[0].n, 2);
  await createAccessAdmin([...createArgs, "--execute"], dependencies);
  const friend = (await query({ sql: "SELECT id,role,enabled,github_user_id,username,password_hash FROM admins WHERE access_email_normalized='friend@example.com'" }))[0];
  assert.equal(friend.role, "moderator"); assert.equal(friend.enabled, 1);
  assert.equal(friend.github_user_id, null); assert.equal(friend.username, null); assert.equal(friend.password_hash, null);
  await execute({ sql: "CREATE TRIGGER fail_create_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'AUDIT_UNAVAILABLE'); END;" });
  await assert.rejects(createAccessAdmin(["--email","rollback@example.com","--local","--execute"], dependencies), /creation failed/);
  assert.equal((await query({ sql: "SELECT count(*) AS n FROM admins" }))[0].n, 3);
});
