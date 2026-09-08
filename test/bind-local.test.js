import assert from "node:assert/strict";
import test from "node:test";
import { executeSql, parseArguments, readConfirmedPassword, runCli } from "../scripts/manage-admin.js";
import { hashPassword, verifyPassword } from "../worker/src/security/passwords.js";
import { createTestDatabase } from "./helpers/d1.js";

const argv = ["bind-local", "--github-user-id", "101", "--username", "Owner.Local", "--remote"];

function fixture(t) {
  const database = createTestDatabase();
  t.after(() => database.close());
  database.raw.exec("INSERT INTO admins (id, github_user_id, github_username, role) VALUES (7, '101', 'existing-owner', 'owner')");
  const messages = [];
  return {
    database, messages,
    dependencies: {
      query: async ({ sql, target }) => {
        assert.equal(target, "remote");
        return database.raw.prepare(sql).all();
      },
      execute: async ({ sql }) => {
        database.raw.exec("BEGIN IMMEDIATE");
        try {
          database.raw.exec(sql);
          database.raw.exec("COMMIT");
        } catch (error) {
          database.raw.exec("ROLLBACK");
          throw error;
        }
      },
      passwordReader: async () => "Bind8abc",
      logger: { log: (message) => messages.push(message) }
    }
  };
}

test("bind-local preview resolves the existing admin ID without passwords or writes", async (t) => {
  const { database, messages, dependencies } = fixture(t);
  const before = database.raw.prepare("SELECT * FROM admins").all();
  await runCli(argv, {
    ...dependencies,
    passwordReader: () => assert.fail("dry-run must not ask for a password"),
    execute: () => assert.fail("dry-run must not write")
  });
  assert.match(messages.join("\n"), /Target: remote/);
  assert.match(messages.join("\n"), /admin id 7/);
  assert.match(messages.join("\n"), /Preview only/);
  assert.deepEqual(database.raw.prepare("SELECT * FROM admins").all(), before);
  assert.equal(database.raw.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n, 0);
});

test("binding updates only credentials on the displayed owner, audits and revokes only its sessions", async (t) => {
  const { database, messages, dependencies } = fixture(t);
  database.raw.exec("INSERT INTO admins (id, github_user_id, github_username, role) VALUES (8, '202', 'other', 'admin')");
  for (const id of [7, 8]) {
    database.raw.prepare("INSERT INTO admin_sessions (token_hash, admin_id, expires_at) VALUES (?, ?, '2099-01-01T00:00:00.000Z')")
      .run(String(id).repeat(64), id);
  }
  const before = database.raw.prepare("SELECT * FROM admins WHERE id = 7").get();
  await runCli([...argv, "--execute"], {
    ...dependencies,
    passwordReader: () => readConfirmedPassword({ prompt: async () => {
      assert.match(messages.join("\n"), /admin id 7/);
      return "Bind8abc";
    } })
  });
  const after = database.raw.prepare("SELECT * FROM admins WHERE id = 7").get();
  for (const key of ["id", "github_user_id", "github_username", "role", "enabled", "created_at"]) {
    assert.equal(after[key], before[key], key);
  }
  assert.equal(after.username, "Owner.Local");
  assert.equal(after.username_normalized, "owner.local");
  assert.ok(after.password_updated_at);
  assert.equal(await verifyPassword("Bind8abc", after.password_hash), true);
  assert.equal(database.raw.prepare("SELECT COUNT(*) AS n FROM admins").get().n, 2);
  assert.deepEqual(database.raw.prepare("SELECT admin_id FROM admin_sessions").all().map((row) => row.admin_id), [8]);
  const audit = database.raw.prepare("SELECT * FROM audit_logs").all();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "admin_local_identity_bound");
  assert.equal(audit[0].admin_id, null);
  assert.deepEqual(JSON.parse(audit[0].metadata), { source: "manage-admin-cli", target_admin_id: 7 });
  assert.doesNotMatch(messages.join("\n"), /Bind8abc|pbkdf2_sha256/);
});

test("bind-local validates numeric IDs, explicit targets and forbids passwords or role changes in argv", () => {
  assert.equal(parseArguments(argv).githubUserId, "101");
  for (const invalid of [
    [...argv, "--role", "owner"], [...argv, "--password", "do-not-echo"],
    [...argv, "--password=do-not-echo"], [...argv, "--local"],
    argv.filter((value) => value !== "--remote"),
    argv.filter((value) => !["--github-user-id", "101"].includes(value)),
    ...["abc", "1 OR 1=1", "-1", "1.2", "1".repeat(33)].map((id) => argv.map((value) => value === "101" ? id : value))
  ]) assert.throws(() => parseArguments(invalid));
});

test("missing, ambiguous, disabled, already-bound and conflicting targets are rejected before asking for secrets", async (t) => {
  for (const reason of ["missing", "ambiguous", "disabled", "bound", "conflict"]) {
    await t.test(reason, async (t) => {
      const { database, dependencies } = fixture(t);
      const hash = await hashPassword("Fixture8");
      let args = argv;
      if (reason === "missing") args = argv.map((value) => value === "101" ? "999" : value);
      if (reason === "disabled") {
        database.raw.exec("INSERT INTO admins (github_user_id, github_username, role) VALUES ('202', 'backup', 'owner'); UPDATE admins SET enabled = 0 WHERE id = 7;");
      }
      if (reason === "bound") {
        database.raw.prepare("UPDATE admins SET username = 'prior', username_normalized = 'prior', password_hash = ?, password_updated_at = '2026-01-01' WHERE id = 7").run(hash);
      }
      if (reason === "conflict") {
        database.raw.prepare("INSERT INTO admins (username, username_normalized, password_hash, password_updated_at) VALUES ('OWNER.LOCAL', 'owner.local', ?, '2026-01-01')").run(hash);
      }
      const before = database.raw.prepare("SELECT * FROM admins").all();
      await assert.rejects(() => runCli([...args, "--execute"], {
        ...dependencies,
        ...(reason === "ambiguous" ? { query: async (request) => {
          const rows = await dependencies.query(request);
          return [...rows, ...rows];
        } } : {}),
        passwordReader: () => assert.fail("invalid target must be rejected before secrets"),
        execute: () => assert.fail("invalid target must not write")
      }), /exactly one|disabled|already has|already used/);
      assert.deepEqual(database.raw.prepare("SELECT * FROM admins").all(), before);
    });
  }
});

test("bind-local refuses a second execution rather than silently replacing the password", async (t) => {
  const { database, dependencies } = fixture(t);
  await runCli([...argv, "--execute"], dependencies);
  const before = database.raw.prepare("SELECT * FROM admins").all();
  await assert.rejects(() => runCli([...argv, "--execute"], dependencies), /already has a local identity/);
  assert.deepEqual(database.raw.prepare("SELECT * FROM admins").all(), before);
  assert.equal(database.raw.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n, 1);
});

test("binding rechecks identity, enabled state, role and username at the write boundary", async (t) => {
  for (const change of ["disabled", "role", "bound", "conflict", "replaced", "github-id"]) {
    await t.test(change, async (t) => {
      const { database, dependencies } = fixture(t);
      database.raw.exec("INSERT INTO admins (id, github_user_id, github_username, role) VALUES (8, '202', 'backup', 'owner')");
      database.raw.prepare("INSERT INTO admin_sessions (token_hash, admin_id, expires_at) VALUES (?, 8, '2099-01-01')").run("a".repeat(64));
      const hash = await hashPassword("Other8ab");
      let afterChange;
      await assert.rejects(() => runCli([...argv, "--execute"], {
        ...dependencies,
        passwordReader: async () => {
          if (change === "disabled") database.raw.exec("UPDATE admins SET enabled = 0 WHERE id = 7");
          if (change === "role") database.raw.exec("UPDATE admins SET role = 'moderator' WHERE id = 7");
          if (change === "github-id") database.raw.exec("UPDATE admins SET github_user_id = '303' WHERE id = 7");
          if (change === "bound") database.raw.prepare("UPDATE admins SET username = 'other', username_normalized = 'other', password_hash = ?, password_updated_at = '2026-01-01' WHERE id = 7").run(hash);
          if (change === "conflict") database.raw.prepare("UPDATE admins SET username = 'OWNER.LOCAL', username_normalized = 'owner.local', password_hash = ?, password_updated_at = '2026-01-01' WHERE id = 8").run(hash);
          if (change === "replaced") database.raw.exec("DELETE FROM admins WHERE id = 7; INSERT INTO admins (github_user_id, github_username, role) VALUES ('101', 'replacement', 'owner')");
          afterChange = database.raw.prepare("SELECT * FROM admins").all();
          return "Bind8abc";
        }
      }), /malformed JSON/);
      assert.deepEqual(database.raw.prepare("SELECT * FROM admins").all(), afterChange);
      assert.equal(database.raw.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n, 0);
      assert.equal(database.raw.prepare("SELECT COUNT(*) AS n FROM admin_sessions").get().n, 1);
    });
  }
});

test("binding failure during audit rolls back credentials and preserves sessions", async (t) => {
  const { database, dependencies } = fixture(t);
  database.raw.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'AUDIT_UNAVAILABLE'); END;");
  const before = database.raw.prepare("SELECT * FROM admins").all();
  await assert.rejects(() => runCli([...argv, "--execute"], dependencies), /AUDIT_UNAVAILABLE/);
  assert.deepEqual(database.raw.prepare("SELECT * FROM admins").all(), before);
});

test("Wrangler read-only JSON query returns structured metadata and fails closed on malformed output", async () => {
  for (const output of ['[{"success":true,"results":[{"id":7}]}]', '[]', 'not json', '[{"success":false,"results":[]}]']) {
    const operation = executeSql({ target: "remote", sql: "SELECT id FROM admins;", json: true }, {
      spawn: (_executable, args) => {
        assert.ok(args.includes("--json"));
        assert.ok(args.includes("--remote"));
        assert.ok(args.includes("production"));
        return { status: 0, stdout: output, stderr: "" };
      },
      stdout: { write: () => assert.fail("JSON transport must not echo raw output") }
    });
    if (output.startsWith('[{"success":true')) assert.deepEqual(await operation, [{ id: 7 }]);
    else await assert.rejects(operation, /query results/);
  }
});

test("short, mismatched or cancelled hidden password input cannot bind the admin", async (t) => {
  for (const reason of ["short", "mismatch", "cancel"]) {
    await t.test(reason, async (t) => {
      const { database, dependencies } = fixture(t);
      const entries = reason === "short" ? ["short", "short"] : ["Bind8abc", "Different8"];
      await assert.rejects(() => runCli([...argv, "--execute"], {
        ...dependencies,
        passwordReader: () => readConfirmedPassword({ prompt: async () => {
          if (reason === "cancel") throw new Error("Password entry cancelled.");
          return entries.shift();
        } })
      }), /at least 8|does not match|cancelled/);
      assert.equal(database.raw.prepare("SELECT username FROM admins WHERE id = 7").get().username, null);
      assert.equal(database.raw.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n, 0);
    });
  }
});

test("a binding race returns a safe actionable error and redacts credentials from transport logs", async () => {
  let output = "";
  await assert.rejects(() => executeSql({
    target: "remote", sql: "SELECT json('BIND_LOCAL_TARGET_CHANGED');",
    sensitive: true, sensitiveValues: ["private-hash", "private-password"]
  }, {
    sensitiveFile: async (_sql, callback) => callback("/private/mutation.sql"),
    spawn: () => ({ status: 1, stdout: "", stderr: "malformed JSON private-hash private-password" }),
    stderr: { write(value) { output += value; } }
  }), /Binding refused.*Re-run the dry-run/);
  assert.doesNotMatch(output, /private-hash|private-password/);
});
