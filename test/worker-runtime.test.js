import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { hashPassword, verifyPassword } from "../worker/src/security/passwords.js";
import { mutationSql, parseArguments } from "../scripts/manage-admin.js";

const root = resolve(import.meta.dirname, "..");
const origin = "https://admin.example.test";
const password = "Test8abc";

test("actual Worker runtime supports migrations, PBKDF2 login, password rotation, and CLI SQL", async (t) => {
  const bundled = await build({
    entryPoints: [resolve(root, "worker/src/index.js")],
    bundle: true, format: "esm", platform: "browser", write: false
  });
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-08-31", d1Databases: ["DB"],
    bindings: {
      APP_ENV: "production", LOCAL_AUTH_ENABLED: "true",
      ADMIN_AUTH_PROVIDERS: "github,local",
      SESSION_SECRET: "isolated-runtime-test-session-secret-32-characters",
      LOGIN_RATE_LIMIT_MAX_ATTEMPTS: "5"
    }
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  async function exec(sql) {
    // D1 exec treats newlines as separate queries. These repository migrations
    // have no line comments; keep complete statements and trigger bodies intact.
    await db.exec(sql.replaceAll("\n", " ").replaceAll("\r", " "));
  }
  for (const name of ["0001_create_submissions", "0002_create_admin_auth", "0003_add_submission_rendering"]) {
    await exec(await readFile(resolve(root, `migrations/${name}.sql`), "utf8"));
  }
  await db.prepare("INSERT INTO admins (github_user_id, github_username, role) VALUES ('123', 'legacy', 'owner')").run();
  await db.prepare("INSERT INTO admin_sessions (token_hash, admin_id, expires_at) VALUES (?, 1, '2099-01-01T00:00:00.000Z')").bind("a".repeat(64)).run();
  await db.prepare("INSERT INTO audit_logs (admin_id, action) VALUES (1, 'login')").run();
  await exec(await readFile(resolve(root, "migrations/0004_add_local_admin_auth.sql"), "utf8"));
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM admin_sessions").first("n"), 1);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM audit_logs").first("n"), 1);
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);

  const options = (command, extra = []) => parseArguments([command, "--username", "Runtime.User", "--local", "--execute", ...extra]);
  await exec(mutationSql(options("add-local"), { passwordHash: await hashPassword(password) }));
  const request = (path, body, cookie, csrf) => mf.dispatchFetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.5",
      ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const loggedIn = await request("/api/auth/login", { username: "rUNTIME.uSER", password });
  assert.equal(loggedIn.status, 200, await loggedIn.clone().text());
  const session = (await loggedIn.json()).data;
  const cookie = loggedIn.headers.get("Set-Cookie").split(";")[0];
  assert.match(loggedIn.headers.get("Set-Cookie"), /HttpOnly/);
  const nextPassword = "Next8xyz";
  const changed = await request("/api/admin/account/password", {
    currentPassword: password, newPassword: nextPassword, confirmPassword: nextPassword
  }, cookie, session.csrfToken);
  assert.equal(changed.status, 200, await changed.clone().text());
  const workerHash = await db.prepare("SELECT password_hash FROM admins WHERE id = 2").first("password_hash");
  assert.equal(await verifyPassword(nextPassword, workerHash), true);
  assert.equal((await request("/api/auth/me", null, cookie)).status, 401);
  assert.equal((await request("/api/auth/login", { username: "Runtime.User", password })).status, 401);
  assert.equal((await request("/api/auth/login", { username: "Runtime.User", password: nextPassword })).status, 200);
  for (const command of ["disable", "enable", "set-role"]) {
    await exec(mutationSql(options(command, command === "set-role" ? ["--role", "admin"] : [])));
  }
  await assert.rejects(() => exec(mutationSql({ ...options("disable"), usernameNormalized: "missing.user" })), /malformed JSON/);
  await assert.rejects(() => exec(mutationSql(options("add-local"), { passwordHash: workerHash })), /UNIQUE constraint/);
  await assert.rejects(() => db.prepare("UPDATE admins SET enabled = 0 WHERE id = 1").run(), /LAST_ENABLED_OWNER/);
  await exec(mutationSql(options("set-password"), { passwordHash: await hashPassword(password) }));
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM admin_sessions WHERE admin_id = 2").first("n"), 0);

  const concurrent = await Promise.all(Array.from({ length: 12 }, () => mf.dispatchFetch(`${origin}/api/auth/login`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.77" },
    body: JSON.stringify({ username: "concurrent.user", password: "incorrect concurrent password" })
  })));
  assert.equal(concurrent.filter((response) => response.status === 401).length, 5);
  assert.equal(concurrent.filter((response) => response.status === 429).length, 7);
  await Promise.all(concurrent.map((response) => response.arrayBuffer()));
});
