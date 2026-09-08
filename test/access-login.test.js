import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { handleApiRequest } from "../worker/src/index.js";
import { createTestDatabase } from "./helpers/d1.js";
import { accessEnv, accessToken, accessJwks } from "./helpers/access.js";
import { sha256Hex } from "../worker/src/security/crypto.js";

const origin = "https://admin.example.test";
function fixture(t) {
  const db = createTestDatabase({ access: false }); t.after(() => db.close());
  db.raw.exec(readFileSync(new URL("../migrations/0005_add_access_email.sql", import.meta.url), "utf8"));
  db.raw.exec("INSERT INTO admins(id,github_user_id,github_username,role,access_email) VALUES(1,'101','original-owner','owner','owner@example.com')");
  const env = { ...accessEnv, DB: db.DB, APP_ENV: "production", SESSION_SECRET: "test-secret-more-than-thirty-two-characters", ACCESS_AUTH_ENABLED: "true", LOCAL_AUTH_ENABLED: "false", ADMIN_AUTH_PROVIDERS: "github,access" };
  const call = (path, options = {}, overrides = {}) => handleApiRequest(new Request(origin + path, options), { ...env, ...overrides }, { accessJwks });
  return { db, env, call };
}

test("Access bootstraps the original owner opaque session, audit, CSRF and app-only logout", async (t) => {
  const { db, call } = fixture(t);
  const response = await call("/api/auth/access", { headers: { "Cf-Access-Jwt-Assertion": await accessToken() } });
  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.get("location"), origin).pathname, "/admin/");
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/);
  const pair = cookie.split(";")[0];
  const tokenHash = await sha256Hex(pair.slice(pair.indexOf("=") + 1));
  const session = db.raw.prepare("SELECT * FROM admin_sessions WHERE token_hash=?").get(tokenHash);
  assert.equal(session.admin_id, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM admins").get().n, 1);
  const me = await call("/api/auth/me", { headers: { Cookie: pair } });
  assert.equal(me.status, 200);
  const identity = (await me.json()).data;
  assert.equal(identity.user.role, "owner");
  assert.equal(identity.user.githubUsername, "original-owner");
  assert.equal((await call("/api/admin/submissions", { headers: { Cookie: pair } })).status, 200);
  const noCsrf = await call("/api/auth/logout", { method: "POST", headers: { Cookie: pair, Origin: origin } });
  assert.equal(noCsrf.status, 403);
  assert.equal((await call("/api/auth/me", { headers: { Cookie: pair } })).status, 200);
  const audit = db.raw.prepare("SELECT * FROM audit_logs WHERE action='access_login_success'").get();
  assert.equal(audit.admin_id, 1);
  assert.deepEqual(JSON.parse(audit.metadata), { provider: "cloudflare_access" });
  const logout = await call("/api/auth/logout", { method: "POST", headers: { Cookie: pair, Origin: origin, "X-CSRF-Token": identity.csrfToken } });
  assert.equal(logout.status, 200);
  assert.equal(logout.headers.get("location"), null);
  assert.equal((await call("/api/auth/me", { headers: { Cookie: pair } })).status, 401);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM admin_sessions").get().n, 0);
});

test("Access disabled, unknown and disabled identities fail safely without creating sessions", async (t) => {
  const { db, call } = fixture(t);
  const token = await accessToken();
  const headers = { "Cf-Access-Jwt-Assertion": token };
  const disabled = await call("/api/auth/access", { headers }, { ACCESS_AUTH_ENABLED: "false" });
  assert.equal(disabled.status, 503);
  assert.equal((await disabled.json()).error.code, "ACCESS_AUTH_DISABLED");
  for (const [email, setup] of [["unknown@example.com", ""], ["disabled@example.com", "INSERT INTO admins(github_user_id,github_username,enabled,access_email) VALUES('202','disabled',0,'disabled@example.com')"]]) {
    if (setup) db.raw.exec(setup);
    const r = await call("/api/auth/access", { headers: { "Cf-Access-Jwt-Assertion": await accessToken({ email }) } });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error.code, "NOT_ADMINISTRATOR");
  }
  const bad = await call("/api/auth/access?email=owner@example.com", { headers: { "Cf-Access-Jwt-Assertion": "secret.bad.jwt", "Cf-Access-Authenticated-User-Email": "owner@example.com" } });
  assert.equal(bad.status, 403);
  assert.equal((await bad.json()).error.code, "ACCESS_AUTH_FAILED");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM admin_sessions").get().n, 0);
  const audits = db.raw.prepare("SELECT metadata FROM audit_logs").all();
  assert.equal(audits.length, 3);
  assert.doesNotMatch(JSON.stringify(audits), /owner@|unknown@|secret.bad.jwt/);
});

test("Access-only login/session works without GitHub configuration; provider flags are independent", async (t) => {
  const { call } = fixture(t);
  const overrides = { ADMIN_AUTH_PROVIDERS: "access" };
  const login = await call("/api/auth/access", { headers: { "Cf-Access-Jwt-Assertion": await accessToken() } }, overrides);
  assert.equal(login.status, 302);
  const me = await call("/api/auth/me", { headers: { Cookie: login.headers.get("set-cookie").split(";")[0] } }, overrides);
  assert.equal(me.status, 200);
  const providers = (await (await call("/api/auth/providers", {}, overrides)).json()).data.providers;
  assert.equal(providers.github, false); assert.equal(providers.access, true); assert.equal(providers.local, false);
});

test("audit failure cannot leave an authenticated Access session", async (t) => {
  const { db, call } = fixture(t);
  db.raw.exec("CREATE TRIGGER fail_login_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'private database detail'); END");
  const r = await call("/api/auth/access", { headers: { "Cf-Access-Jwt-Assertion": await accessToken() } });
  assert.equal(r.status, 500);
  assert.equal(r.headers.get("set-cookie"), null);
  assert.doesNotMatch(await r.text(), /private database|JWT|jose/);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM admin_sessions").get().n, 0);
});

test("Access sessions recheck current role and enabled status through existing authorization", async (t) => {
  const { db, call } = fixture(t);
  db.raw.exec("INSERT INTO admins(github_user_id,github_username,role) VALUES('303','backup-owner','owner')");
  const login = await call("/api/auth/access", { headers: { "Cf-Access-Jwt-Assertion": await accessToken() } });
  const headers = { Cookie: login.headers.get("set-cookie").split(";")[0] };
  db.raw.exec("UPDATE admins SET role='moderator' WHERE id=1");
  assert.equal((await (await call("/api/auth/me", { headers })).json()).data.user.role, "moderator");
  assert.equal((await call("/api/admin/submissions", { headers })).status, 200);
  db.raw.exec("UPDATE admins SET enabled=0 WHERE id=1");
  assert.equal((await call("/api/admin/submissions", { headers })).status, 401);
});

test("email mapping changed during login cannot create a session or revoke the old browser session", async (t) => {
  const { db, call } = fixture(t);
  const oldToken = "existing-browser-session";
  const oldHash = await sha256Hex(oldToken);
  db.raw.prepare("INSERT INTO admin_sessions(token_hash,admin_id,expires_at) VALUES(?,1,'2099-01-01')").run(oldHash);
  const racingDb = {
    prepare: sql => db.DB.prepare(sql),
    batch: statements => {
      db.raw.exec("UPDATE admins SET access_email='changed@example.com' WHERE id=1");
      return db.DB.batch(statements);
    }
  };
  const r = await call("/api/auth/access", { headers: {
    "Cf-Access-Jwt-Assertion": await accessToken(), Cookie: `anonymous_admin_session=${oldToken}`
  } }, { DB: racingDb });
  assert.equal(r.status, 403);
  assert.equal(r.headers.get("set-cookie"), null);
  assert.deepEqual(db.raw.prepare("SELECT token_hash FROM admin_sessions").all().map(row => row.token_hash), [oldHash]);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='access_login_success'").get().n, 0);
});
