import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  executeSql,
  listSql,
  mutationSql,
  parseArguments,
  promptHidden,
  readConfirmedPassword,
  runCli,
  sqlLiteral,
  withSensitiveSqlFile,
  wranglerArguments
} from "../scripts/manage-admin.js";
import { createTestDatabase } from "./helpers/d1.js";

test("hidden password prompt accepts Unicode without echo and restores the terminal on cancel", async () => {
  const input = Object.assign(new EventEmitter(), {
    isTTY: true, isRaw: false,
    setRawMode(value) { this.isRaw = value; },
    setEncoding() {}, resume() {}, pause() {}
  });
  let outputText = "";
  const output = { isTTY: true, write(value) { outputText += value; } };
  const entered = promptHidden("Password: ", { input, output });
  input.emit("data", "中文 passphrase 🔑\r");
  assert.equal(await entered, "中文 passphrase 🔑");
  assert.equal(outputText, "Password: \n");
  assert.equal(input.isRaw, false);
  const cancelled = promptHidden("Password: ", { input, output });
  input.emit("data", "do not echo\u0003");
  await assert.rejects(cancelled, /cancelled/);
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount("data"), 0);
  assert.doesNotMatch(outputText, /do not echo/);
});

test("Windows ACL failure stops before any sensitive SQL is written", async () => {
  let writes = 0;
  let removed = false;
  await assert.rejects(() => withSensitiveSqlFile("secret", () => assert.fail(), {
    platform: "win32", makeTemporaryDirectory: async () => "unused-test-path",
    protectWindows() { throw new Error("ACL unavailable"); },
    write: async () => { writes += 1; },
    remove: async () => { removed = true; }
  }), /ACL unavailable/);
  assert.equal(writes, 0);
  assert.equal(removed, true);
});

test("argument parsing accepts every command and normalizes local usernames", () => {
  assert.deepEqual(parseArguments([
    "add-local", "--username", "Alice.Admin", "--local"
  ]), {
    command: "add-local",
    execute: false,
    role: "moderator",
    target: "local",
    username: "Alice.Admin",
    usernameNormalized: "alice.admin"
  });
  assert.equal(parseArguments([
    "set-role", "--username", "Alice", "--role", "owner", "--remote", "--execute"
  ]).execute, true);
  assert.equal(parseArguments(["disable", "--username", "alice", "--local"]).command, "disable");
  assert.equal(parseArguments(["enable", "--username", "alice", "--remote"]).target, "remote");
  assert.equal(parseArguments([
    "set-password", "--username", "alice", "--local"
  ]).usernameNormalized, "alice");
  assert.equal(parseArguments(["list", "--local"]).command, "list");
});

test("argument parsing is strict and requires exactly one target", () => {
  const rejected = [
    ["list"],
    ["list", "--local", "--remote"],
    ["list", "--local", "--local"],
    ["list", "--local", "--execute"],
    ["disable", "--username", "alice", "--local", "extra"],
    ["enable", "--username", "alice", "--username", "bob", "--local"],
    ["set-role", "--username", "alice", "--role", "superuser", "--local"],
    ["set-role", "--username", "alice", "--local"],
    ["set-password", "--local"],
    ["unknown", "--local"]
  ];
  for (const argv of rejected) {
    assert.throws(() => parseArguments(argv));
  }
});

test("password command-line arguments are always rejected", () => {
  assert.throws(
    () => parseArguments([
      "set-password", "--username", "alice", "--password", "not-a-secret", "--local"
    ]),
    /--password is forbidden/
  );
  assert.throws(
    () => parseArguments([
      "add-local", "--username", "alice", "--password=not-a-secret", "--local"
    ]),
    /--password is forbidden/
  );
  assert.throws(
    () => parseArguments([
      "set-password", "--username", "alice", "--local", "do-not-echo-this-password"
    ]),
    (error) => !error.message.includes("do-not-echo-this-password")
  );
});

test("wrangler target arguments cannot accidentally cross local and production", () => {
  assert.deepEqual(
    wranglerArguments("local", { command: "SELECT 1;" }),
    [
      "d1", "execute", "DB",
      "--local", "--config", "wrangler.dev.jsonc", "--command", "SELECT 1;"
    ]
  );
  assert.deepEqual(
    wranglerArguments("remote", { file: "/private/tmp/query.sql" }),
    [
      "d1", "execute", "DB",
      "--remote", "--env", "production", "--file", "/private/tmp/query.sql"
    ]
  );
});

test("SQL quotes values, audits mutations, and list never selects password hashes", () => {
  assert.equal(sqlLiteral("Ada's admin"), "'Ada''s admin'");
  assert.doesNotMatch(listSql(), /password/i);
  assert.match(listSql(), /AS auth_methods/);

  const add = mutationSql(parseArguments([
    "add-local", "--username", "alice", "--role", "admin", "--local", "--execute"
  ]), { passwordHash: "pbkdf2_sha256$600000$salt$hash" });
  assert.match(add, /admin_account_created/);
  assert.match(add, /INSERT INTO audit_logs/);
  assert.doesNotMatch(add, /\b(?:BEGIN|COMMIT)\b/i);
  assert.match(add, /NULL, 'admin_account_created'/);
  assert.match(add, /'target_admin_id', last_insert_rowid\(\)/);

  const setRole = mutationSql(parseArguments([
    "set-role", "--username", "alice", "--role", "owner", "--local", "--execute"
  ]));
  assert.match(setRole, /admin_role_changed/);
  assert.match(setRole, /username_normalized = 'alice'/);
  assert.match(setRole, /MANAGE_ADMIN_TARGET_NOT_FOUND/);
  assert.doesNotMatch(setRole, /\b(?:BEGIN|COMMIT)\b/i);

  const disable = mutationSql(parseArguments([
    "disable", "--username", "alice", "--local", "--execute"
  ]));
  assert.match(disable, /admin_account_disabled/);

  const enable = mutationSql(parseArguments([
    "enable", "--username", "alice", "--local", "--execute"
  ]));
  assert.match(enable, /admin_account_enabled/);

  const setPassword = mutationSql(parseArguments([
    "set-password", "--username", "alice", "--local", "--execute"
  ]), { passwordHash: "pbkdf2_sha256$600000$salt$newhash" });
  assert.match(setPassword, /password_changed/);
  assert.match(setPassword, /DELETE FROM admin_sessions/);
});

test("generated mutations apply cleanly and write CLI audit actions", () => {
  const database = createTestDatabase();
  try {
    const firstHash = `pbkdf2_sha256$600000$${"a".repeat(22)}$${"b".repeat(43)}`;
    const secondHash = `pbkdf2_sha256$600000$${"c".repeat(22)}$${"d".repeat(43)}`;
    database.raw.exec(mutationSql(parseArguments([
      "add-local", "--username", "Alice", "--role", "admin", "--local", "--execute"
    ]), { passwordHash: firstHash }));
    database.raw.exec(mutationSql(parseArguments([
      "set-role", "--username", "ALICE", "--role", "moderator", "--local", "--execute"
    ])));
    database.raw.exec(mutationSql(parseArguments([
      "disable", "--username", "alice", "--local", "--execute"
    ])));
    database.raw.exec(mutationSql(parseArguments([
      "enable", "--username", "alice", "--local", "--execute"
    ])));

    const adminId = database.raw.prepare(
      "SELECT id FROM admins WHERE username_normalized = 'alice'"
    ).get().id;
    database.raw.prepare(`
      INSERT INTO admin_sessions (token_hash, admin_id, expires_at)
      VALUES (?, ?, ?)
    `).run("e".repeat(64), adminId, "2099-01-01T00:00:00.000Z");
    database.raw.exec(mutationSql(parseArguments([
      "set-password", "--username", "alice", "--local", "--execute"
    ]), { passwordHash: secondHash }));

    const admin = database.raw.prepare(`
      SELECT username, username_normalized, password_hash, role, enabled
      FROM admins WHERE id = ?
    `).get(adminId);
    assert.deepEqual({ ...admin }, {
      username: "Alice",
      username_normalized: "alice",
      password_hash: secondHash,
      role: "moderator",
      enabled: 1
    });
    assert.equal(
      database.raw.prepare("SELECT COUNT(*) AS count FROM admin_sessions").get().count,
      0
    );
    assert.deepEqual(
      database.raw.prepare("SELECT admin_id, action, metadata FROM audit_logs ORDER BY id").all()
        .map(({ admin_id: actorId, action, metadata }) => ({
          action,
          actorId,
          metadata: JSON.parse(metadata)
        })),
      [
        "admin_account_created",
        "admin_role_changed",
        "admin_account_disabled",
        "admin_account_enabled",
        "password_changed"
      ].map((action) => ({
        action,
        actorId: null,
        metadata: {
          source: "manage-admin-cli",
          target_admin_id: adminId,
          ...(action === "admin_account_created"
            ? { auth_method: "local", role: "admin" }
            : {}),
          ...(action === "admin_role_changed" ? { role: "moderator" } : {})
        }
      }))
    );
  } finally {
    database.close();
  }
});

test("mutations are dry-run by default and do not prompt or execute", async () => {
  const messages = [];
  let promptCount = 0;
  let executeCount = 0;
  await runCli(["add-local", "--username", "alice", "--remote"], {
    execute: async () => { executeCount += 1; },
    passwordReader: async () => { promptCount += 1; return "unused-password"; },
    logger: { log: (message) => messages.push(message) }
  });
  assert.equal(promptCount, 0);
  assert.equal(executeCount, 0);
  assert.match(messages.join("\n"), /Preview only/);
  assert.doesNotMatch(messages.join("\n"), /unused-password|password_hash/);
});

test("executed password mutations prompt, confirm, hash, and remain sensitive", async () => {
  const password = "correct horse battery staple";
  const encodedHash = "pbkdf2_sha256$600000$salt$derived";
  const prompts = [];
  const calls = [];
  const logs = [];

  const confirmed = await readConfirmedPassword({
    prompt: async (label) => {
      prompts.push(label);
      return password;
    }
  });
  assert.equal(confirmed, password);
  assert.deepEqual(prompts, ["Password: ", "Confirm password: "]);

  await runCli([
    "set-password", "--username", "Alice", "--local", "--execute"
  ], {
    passwordReader: async () => password,
    passwordHasher: async (candidate) => {
      assert.equal(candidate, password);
      return encodedHash;
    },
    execute: async (request) => calls.push(request),
    logger: { log: (message) => logs.push(message) }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].sensitive, true);
  assert.deepEqual(calls[0].sensitiveValues, [password, encodedHash]);
  assert.match(calls[0].sql, /password_changed/);
  assert.doesNotMatch(logs.join("\n"), new RegExp(password));
  assert.doesNotMatch(logs.join("\n"), /pbkdf2_sha256/);
});

test("account creation accepts eight characters and rejects seven before any write", async () => {
  const database = createTestDatabase();
  const argv = ["add-local", "--username", "boundary.user", "--local", "--execute"];
  const dependencies = {
    logger: { log() {} },
    execute: async ({ sql }) => database.raw.exec(sql)
  };
  try {
    await assert.rejects(() => runCli(argv, {
      ...dependencies,
      passwordReader: async () => "Test7ab"
    }), (error) => error.code === "PASSWORD_TOO_SHORT" && /8/.test(error.message));
    assert.equal(database.raw.prepare("SELECT COUNT(*) AS n FROM admins").get().n, 0);
    await runCli(argv, {
      ...dependencies,
      passwordReader: () => readConfirmedPassword({ prompt: async () => "Test8abc" })
    });
    assert.equal(database.raw.prepare("SELECT COUNT(*) AS n FROM admins").get().n, 1);
  } finally {
    database.close();
  }
});

test("password confirmation mismatch is rejected before hashing", async () => {
  const values = ["correct horse battery staple", "different passphrase here"];
  await assert.rejects(
    () => readConfirmedPassword({ prompt: async () => values.shift() }),
    /does not match/
  );
});

test("sensitive SQL has OS-level private permissions and is always cleaned up", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "anonymous-admin-test-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  let directory;
  let filename;
  await assert.rejects(
    () => withSensitiveSqlFile("SELECT 'secret';", async (path) => {
      filename = path;
      directory = dirname(path);
      if (process.platform === "win32") {
        const acl = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
          $acl = [System.IO.Directory]::GetAccessControl($env:ANONYMOUS_ADMIN_TEST_PATH)
          $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
          @{ protected = $acl.AreAccessRulesProtected; owner = $owner;
             rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) |
               ForEach-Object { @{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString() } }) } |
            ConvertTo-Json -Depth 4 -Compress
        `], { encoding: "utf8", windowsHide: true,
          env: { ...process.env, ANONYMOUS_ADMIN_TEST_PATH: directory,
            PSModulePath: join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/Modules") } }));
        assert.equal(acl.protected, true);
        assert.equal(acl.rules.length, 2);
        assert.ok(acl.rules.every((rule) => [acl.owner, "S-1-5-18"].includes(rule.sid) && rule.type === "Allow"));
      } else {
        assert.equal((await stat(directory)).mode & 0o777, 0o700);
        assert.equal((await stat(filename)).mode & 0o777, 0o600);
      }
      assert.equal(await readFile(filename, "utf8"), "SELECT 'secret';");
      throw new Error("simulated execution failure");
    }, { temporaryRoot: root }),
    /simulated execution failure/
  );
  await assert.rejects(() => access(filename));
  await assert.rejects(() => access(directory));
});

test("sensitive execution passes only a protected file path to wrangler", async () => {
  const secretHash = "pbkdf2_sha256$600000$private$sensitive";
  let spawnedArguments;
  let spawnedOptions;
  let sqlSeenInFile;
  await executeSql({
    target: "local",
    sql: `UPDATE admins SET password_hash = '${secretHash}';`,
    sensitive: true,
    sensitiveValues: [secretHash]
  }, {
    spawn: (executable, argumentsList, options) => {
      assert.equal(executable, process.execPath);
      spawnedOptions = options;
      spawnedArguments = argumentsList;
      return { status: 0, stdout: "", stderr: "" };
    },
    sensitiveFile: async (sql, callback) => {
      sqlSeenInFile = sql;
      return callback("/private/tmp/protected/mutation.sql");
    }
  });
  assert.match(sqlSeenInFile, /password_hash/);
  assert.doesNotMatch(spawnedArguments.join(" "), /pbkdf2_sha256|sensitive/);
  assert.deepEqual(spawnedArguments.slice(-2), ["--file", "/private/tmp/protected/mutation.sql"]);
  assert.equal(spawnedOptions.env.WRANGLER_LOG_PATH, dirname("/private/tmp/protected/mutation.sql"));
  assert.equal(spawnedOptions.env.WRANGLER_LOG_SANITIZE, "true");
});

test("last enabled owner trigger errors receive an actionable message", async () => {
  await assert.rejects(
    () => executeSql({ target: "local", sql: "UPDATE admins SET enabled = 0;" }, {
      spawn: () => ({
        status: 1,
        stdout: "",
        stderr: "D1_ERROR: LAST_ENABLED_OWNER"
      }),
      stderr: { write() {} }
    }),
    /keep at least one enabled owner.*another owner first/
  );
});

test("missing local usernames receive a clear failure instead of silent success", async () => {
  await assert.rejects(
    () => executeSql({ target: "local", sql: "UPDATE admins SET enabled = 0;" }, {
      spawn: () => ({
        status: 1,
        stdout: "",
        stderr: "CHECK constraint failed: MANAGE_ADMIN_TARGET_NOT_FOUND"
      }),
      stderr: { write() {} }
    }),
    /No matching local admin.*--username/
  );
});
