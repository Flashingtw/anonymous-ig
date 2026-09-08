import assert from "node:assert/strict";
import test from "node:test";

import { handleApiRequest } from "../worker/src/index.js";
import {
  D1LoginRateLimiter,
  MemoryLoginRateLimiter,
  loginRateLimitConfig,
  loginRateLimitKeys
} from "../worker/src/security/login-rate-limit.js";
import {
  PASSWORD_ALGORITHM,
  PASSWORD_ITERATIONS,
  PasswordPolicyError,
  __testables as passwordTestables,
  assertPasswordPolicy,
  hashPassword,
  verifyPassword
} from "../worker/src/security/passwords.js";
import { createTestDatabase } from "./helpers/d1.js";
import { createAdminSession, replaceSessionsAfterPasswordChange } from "../worker/src/repositories/sessions.js";

const ORIGIN = "https://admin.example.test";
const SESSION_SECRET = "test-session-secret-with-more-than-thirty-two-characters";
const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "new correct horse battery staple";
const FIXED_SALT = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
const deterministicPasswordHash = hashPassword(PASSWORD, { salt: FIXED_SALT });

test("concurrent attempts reserve at most the configured budget before password verification", async (t) => {
  const database = createTestDatabase();
  t.after(() => database.close());
  let now = 1_800_000_000;
  const config = loginRateLimitConfig(testEnv(database.DB));
  for (const limiter of [
    new MemoryLoginRateLimiter(config, { now: () => now }),
    new D1LoginRateLimiter(database.DB, config, { now: () => now })
  ]) {
    const keys = ["ip:concurrent-test-identifier", "username:concurrent-test-identifier"];
    const results = await Promise.all(Array.from({ length: 12 }, () => limiter.reserve(keys)));
    assert.equal(results.filter((result) => result.allowed).length, 3);
    assert.ok(results.filter((result) => !result.allowed).every((result) => result.retryAfterSeconds > 0));
    await limiter.reset([keys[1]]);
    assert.equal((await limiter.reserve([keys[0], "username:another-test-identifier"])).allowed, false);
    now += config.blockSeconds + 1;
    assert.equal((await limiter.reserve(keys)).allowed, true);
  }
});

test("stale password verification cannot create a session or revoke the existing browser session", async (t) => {
  const database = createTestDatabase();
  t.after(() => database.close());
  const adminId = await seedLocalAdmin(database.DB);
  const previousHash = "b".repeat(64);
  await createAdminSession(database.DB, { adminId, tokenHash: previousHash, expiresAt: "2099-01-01T00:00:00.000Z" });
  const expectedPasswordHash = await deterministicPasswordHash;
  const newPasswordHash = await hashPassword(NEW_PASSWORD);
  database.raw.prepare("UPDATE admins SET password_hash = ? WHERE id = ?").run(newPasswordHash, adminId);
  const created = await createAdminSession(database.DB, {
    adminId, tokenHash: "c".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z"
  }, { expectedPasswordHash, replaceTokenHash: previousHash,
    audit: { adminId, action: "local_login_success" } });
  assert.equal(created, false);
  assert.equal(database.raw.prepare("SELECT COUNT(*) AS n FROM admin_sessions WHERE token_hash = ?").get(previousHash).n, 1);
  assert.equal(database.raw.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n, 0);

  const replaced = await replaceSessionsAfterPasswordChange(database.DB, {
    adminId, expectedPasswordHash: newPasswordHash, newPasswordHash: expectedPasswordHash,
    currentSessionTokenHash: "revoked-session", passwordUpdatedAt: new Date().toISOString(),
    tokenHash: "d".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z"
  }, { audit: { adminId, action: "password_changed" } });
  assert.equal(replaced, false);
  assert.equal(database.raw.prepare("SELECT password_hash FROM admins WHERE id = ?").get(adminId).password_hash, newPasswordHash);
});

function testEnv(DB, overrides = {}) {
  return {
    DB,
    APP_ENV: "production",
    ADMIN_AUTH_PROVIDERS: "github,local",
    LOCAL_AUTH_ENABLED: "true",
    SESSION_SECRET,
    SESSION_TTL_SECONDS: "3600",
    LOGIN_RATE_LIMIT_MAX_ATTEMPTS: "3",
    LOGIN_RATE_LIMIT_WINDOW_SECONDS: "60",
    LOGIN_RATE_LIMIT_BLOCK_SECONDS: "120",
    ALLOWED_ORIGINS: "",
    ...overrides
  };
}

async function seedLocalAdmin(DB, {
  username = "Alice.Admin",
  passwordHash,
  githubUserId = null,
  githubUsername = null,
  role = "admin",
  enabled = 1
} = {}) {
  const resolvedHash = passwordHash ?? await deterministicPasswordHash;
  return DB.prepare(`
    INSERT INTO admins (
      github_user_id,
      github_username,
      username,
      username_normalized,
      password_hash,
      password_updated_at,
      role,
      enabled
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).bind(
    githubUserId,
    githubUsername,
    username,
    username.toLowerCase(),
    resolvedHash,
    "2026-01-02T03:04:05.000Z",
    role,
    enabled
  ).first("id");
}

function cookiePair(response, name = "anonymous_admin_session") {
  const setCookie = response.headers.get("Set-Cookie") ?? "";
  const match = setCookie.match(new RegExp(`(?:^|, )${name}=([^;]*)`));
  return match ? `${name}=${match[1]}` : "";
}

function rawCookieValue(cookie) {
  return cookie.slice(cookie.indexOf("=") + 1);
}

async function login(env, {
  username = "Alice.Admin",
  password = PASSWORD,
  ip = "203.0.113.10",
  cookie = ""
} = {}, dependencies = {}) {
  const headers = {
    "CF-Connecting-IP": ip,
    "Content-Type": "application/json",
    Origin: ORIGIN,
    "Sec-Fetch-Site": "same-origin"
  };
  if (cookie) {
    headers.Cookie = cookie;
  }
  return handleApiRequest(new Request(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ username, password })
  }), env, dependencies);
}

async function authMe(env, cookie) {
  return handleApiRequest(new Request(`${ORIGIN}/api/auth/me`, {
    headers: { Cookie: cookie }
  }), env);
}

async function changePassword(env, cookie, csrfToken, body) {
  const headers = {
    "Content-Type": "application/json",
    Cookie: cookie,
    Origin: ORIGIN
  };
  if (csrfToken !== undefined) {
    headers["X-CSRF-Token"] = csrfToken;
  }
  return handleApiRequest(new Request(`${ORIGIN}/api/admin/account/password`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  }), env);
}

test("password hashing uses PBKDF2, random salts, and verifies only the right password", async () => {
  const first = await hashPassword(PASSWORD);
  const second = await hashPassword(PASSWORD);
  const firstParts = first.split("$");
  const secondParts = second.split("$");

  assert.equal(firstParts[0], PASSWORD_ALGORITHM);
  assert.equal(Number(firstParts[1]), PASSWORD_ITERATIONS);
  assert.notEqual(firstParts[2], secondParts[2]);
  assert.notEqual(first, second);
  assert.equal(passwordTestables.parsePasswordHash(first).salt.byteLength, 16);
  assert.equal(await verifyPassword(PASSWORD, first), true);
  assert.equal(await verifyPassword("definitely the wrong password", first), false);
});

test("password verification rejects malformed encodings without throwing", async () => {
  const valid = await deterministicPasswordHash;
  const malformed = [
    null,
    "",
    "not-a-password-hash",
    valid.replace(PASSWORD_ALGORITHM, "scrypt"),
    valid.replace(String(PASSWORD_ITERATIONS), "99999"),
    valid.replace(String(PASSWORD_ITERATIONS), "2000001"),
    `${PASSWORD_ALGORITHM}$${PASSWORD_ITERATIONS}$bad$bad`,
    `${valid}$extra`,
    "x".repeat(513)
  ];

  for (const encoded of malformed) {
    assert.equal(await verifyPassword(PASSWORD, encoded), false, String(encoded));
  }
  assert.equal(await verifyPassword(null, valid), false);
  assert.equal(await verifyPassword("x".repeat(1025), valid), false);
});

test("password policy enforces type, grapheme bounds, and whitespace-only rejection", async () => {
  assert.equal(assertPasswordPolicy("12345678"), "12345678");
  assert.equal(
    assertPasswordPolicy("👩‍💻".repeat(8)),
    "👩‍💻".repeat(8),
    "joined emoji count as graphemes rather than code points"
  );

  const cases = [
    [null, "PASSWORD_MUST_BE_STRING"],
    ["1234567", "PASSWORD_TOO_SHORT"],
    ["👩‍💻".repeat(7), "PASSWORD_TOO_SHORT"],
    [" ".repeat(8), "PASSWORD_WHITESPACE_ONLY"],
    ["a".repeat(129), "PASSWORD_TOO_LONG"]
  ];
  for (const [password, code] of cases) {
    assert.throws(
      () => assertPasswordPolicy(password),
      (error) => error instanceof PasswordPolicyError && error.code === code
    );
  }
  await assert.rejects(
    () => hashPassword(PASSWORD, { salt: new Uint8Array(15) }),
    /Password salt must be 16 bytes/
  );
});

test("auth provider discovery keeps GitHub available while local login has its own switch", async (t) => {
  const database = createTestDatabase();
  t.after(() => database.close());
  const enabledEnv = testEnv(database.DB);
  const enabled = await handleApiRequest(
    new Request(`${ORIGIN}/api/auth/providers`),
    enabledEnv
  );
  assert.equal(enabled.status, 200);
  assert.deepEqual((await enabled.json()).data.providers, {
    github: true,
    local: true,
    access: false,
    dev: false
  });

  const disabledEnv = testEnv(database.DB, { LOCAL_AUTH_ENABLED: "false" });
  const disabled = await handleApiRequest(
    new Request(`${ORIGIN}/api/auth/providers`),
    disabledEnv
  );
  assert.deepEqual((await disabled.json()).data.providers, {
    github: true,
    local: false,
    access: false,
    dev: false
  });
  const rejectedLogin = await login(disabledEnv);
  assert.equal(rejectedLogin.status, 503);
  assert.equal((await rejectedLogin.json()).error.code, "LOCAL_AUTH_DISABLED");
});

test("local login is case-insensitive and creates a secure, usable session", async (t) => {
  const database = createTestDatabase();
  t.after(() => database.close());
  const env = testEnv(database.DB);
  await seedLocalAdmin(database.DB, {
    username: "Alice.Admin",
    githubUserId: "101",
    githubUsername: "octocat"
  });

  const response = await login(env, { username: "  aLiCe.AdMiN  " });
  const payload = await response.json();
  const cookie = cookiePair(response);

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.data.user, {
    username: "Alice.Admin",
    githubUsername: "octocat",
    role: "admin",
    authMethods: ["github", "local"]
  });
  assert.equal(typeof payload.data.csrfToken, "string");
  assert.equal(payload.data.csrfToken.length > 30, true);
  assert.equal(typeof payload.data.expiresAt, "string");
  assert.match(response.headers.get("Set-Cookie"), /^anonymous_admin_session=[A-Za-z0-9_-]+;/);
  assert.match(response.headers.get("Set-Cookie"), /Path=\//);
  assert.match(response.headers.get("Set-Cookie"), /HttpOnly/);
  assert.match(response.headers.get("Set-Cookie"), /SameSite=Lax/);
  assert.match(response.headers.get("Set-Cookie"), /Secure/);
  assert.match(response.headers.get("Set-Cookie"), /Max-Age=3600/);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.match(response.headers.get("Content-Security-Policy"), /default-src 'none'/);
  assert.ok(cookie);

  const sessionRow = database.raw.prepare(`
    SELECT token_hash, admin_id FROM admin_sessions
  `).get();
  assert.equal(sessionRow.token_hash.length, 64);
  assert.equal(sessionRow.token_hash.includes(rawCookieValue(cookie)), false);

  const me = await authMe(env, cookie);
  assert.equal(me.status, 200);
  assert.deepEqual((await me.json()).data.user, payload.data.user);
});

test("unknown, wrong-password, and disabled local identities share one non-leaking 401", async (t) => {
  const database = createTestDatabase();
  t.after(() => database.close());
  const env = testEnv(database.DB);
  const enabledId = await seedLocalAdmin(database.DB, { username: "Known.User" });
  await seedLocalAdmin(database.DB, { username: "Disabled.User", enabled: 0 });
  const expected = {
    ok: false,
    error: {
      code: "INVALID_CREDENTIALS",
      message: "帳號或密碼錯誤。"
    }
  };

  const attempts = [
    { username: "missing.user", password: PASSWORD, ip: "203.0.113.21" },
    { username: "Known.User", password: "wrong password value", ip: "203.0.113.22" },
    { username: "Disabled.User", password: PASSWORD, ip: "203.0.113.23" },
    { username: "not valid!", password: PASSWORD, ip: "203.0.113.24" }
  ];
  for (const attempt of attempts) {
    const response = await login(env, attempt);
    const text = await response.text();
    assert.equal(response.status, 401);
    assert.deepEqual(JSON.parse(text), expected);
    assert.doesNotMatch(text, /missing|Known|Disabled|password_hash|pbkdf2/i);
    assert.equal(response.headers.get("Set-Cookie"), null);
  }

  const audits = database.raw.prepare(`
    SELECT admin_id, action, metadata FROM audit_logs ORDER BY id
  `).all();
  assert.equal(audits.length, 4);
  assert.equal(audits.every((row) => row.action === "local_login_failed"), true);
  assert.equal(audits.every((row) => row.metadata === '{"result":"invalid_credentials"}'), true);
  assert.equal(audits.some((row) => row.admin_id === enabledId), true);
  assert.equal(JSON.stringify(audits).includes(PASSWORD), false);
});

test("rate limiting combines IP and normalized username keys, returns 429, and resets on success", async (t) => {
  const database = createTestDatabase();
  t.after(() => database.close());
  const env = testEnv(database.DB);
  await seedLocalAdmin(database.DB);
  const config = loginRateLimitConfig(env);
  const now = 1_800_000_000;

  const aliceFromOneIp = await loginRateLimitKeys(
    new Request(`${ORIGIN}/`, { headers: { "CF-Connecting-IP": "203.0.113.30" } }),
    env,
    "alice"
  );
  const bobFromOneIp = await loginRateLimitKeys(
    new Request(`${ORIGIN}/`, { headers: { "CF-Connecting-IP": "203.0.113.30" } }),
    env,
    "bob"
  );
  const aliceFromAnotherIp = await loginRateLimitKeys(
    new Request(`${ORIGIN}/`, { headers: { "CF-Connecting-IP": "203.0.113.31" } }),
    env,
    "alice"
  );
  assert.equal(aliceFromOneIp[0], bobFromOneIp[0]);
  assert.notEqual(aliceFromOneIp[1], bobFromOneIp[1]);
  assert.notEqual(aliceFromOneIp[0], aliceFromAnotherIp[0]);
  assert.equal(aliceFromOneIp[1], aliceFromAnotherIp[1]);
  assert.doesNotMatch(aliceFromOneIp.join(" "), /203\.0\.113|alice/);

  const ipLimiter = new D1LoginRateLimiter(database.DB, config, { now: () => now });
  for (const username of ["one", "two", "three"]) {
    const keys = await loginRateLimitKeys(
      new Request(`${ORIGIN}/`, { headers: { "CF-Connecting-IP": "203.0.113.40" } }),
      env,
      username
    );
    await ipLimiter.recordFailure(keys);
  }
  const fourthOnIp = await loginRateLimitKeys(
    new Request(`${ORIGIN}/`, { headers: { "CF-Connecting-IP": "203.0.113.40" } }),
    env,
    "four"
  );
  assert.deepEqual(await ipLimiter.check(fourthOnIp), {
    allowed: false,
    retryAfterSeconds: 120
  });

  const usernameDatabase = createTestDatabase();
  t.after(() => usernameDatabase.close());
  const usernameEnv = testEnv(usernameDatabase.DB);
  const usernameLimiter = new D1LoginRateLimiter(usernameDatabase.DB, config, { now: () => now });
  let lastUsernameKeys;
  for (const ip of ["203.0.113.50", "203.0.113.51", "203.0.113.52"]) {
    lastUsernameKeys = await loginRateLimitKeys(
      new Request(`${ORIGIN}/`, { headers: { "CF-Connecting-IP": ip } }),
      usernameEnv,
      "shared.user"
    );
    await usernameLimiter.recordFailure(lastUsernameKeys);
  }
  const sameUsernameElsewhere = await loginRateLimitKeys(
    new Request(`${ORIGIN}/`, { headers: { "CF-Connecting-IP": "203.0.113.53" } }),
    usernameEnv,
    "shared.user"
  );
  assert.equal((await usernameLimiter.check(sameUsernameElsewhere)).allowed, false);
  await usernameLimiter.reset(lastUsernameKeys);
  assert.equal((await usernameLimiter.check(lastUsernameKeys)).allowed, true);

  const blockedResponse = await login(env, {}, {
    loginRateLimiter: {
      async reserve() {
        return { allowed: false, retryAfterSeconds: 17.2 };
      },
      async recordFailure() {
        assert.fail("a blocked request must not record another failure");
      },
      async reset() {
        assert.fail("a blocked request must not reset the limiter");
      }
    }
  });
  assert.equal(blockedResponse.status, 429);
  assert.equal(blockedResponse.headers.get("Retry-After"), "18");
  assert.equal((await blockedResponse.json()).error.code, "TOO_MANY_ATTEMPTS");

  let resetKeys = null;
  const successResponse = await login(env, {}, {
    loginRateLimiter: {
      async reserve() {
        return { allowed: true, retryAfterSeconds: 0 };
      },
      async recordFailure() {
        assert.fail("successful login must not record a failure");
      },
      async reset(keys) {
        resetKeys = keys;
      }
    }
  });
  assert.equal(successResponse.status, 200);
  assert.equal(resetKeys.length, 1);
  assert.match(resetKeys[0], /^username:/);
});

test("the login handler enforces repeated-failure limits and resets them after success", async (t) => {
  const usernameDatabase = createTestDatabase();
  t.after(() => usernameDatabase.close());
  const usernameEnv = testEnv(usernameDatabase.DB);
  await seedLocalAdmin(usernameDatabase.DB);

  for (const [index, ip] of [
    "203.0.113.80",
    "203.0.113.81",
    "203.0.113.82"
  ].entries()) {
    const response = await login(usernameEnv, {
      password: `wrong password value ${index}`,
      ip
    });
    assert.equal(response.status, 401);
  }
  const usernameBlocked = await login(usernameEnv, {
    ip: "203.0.113.83"
  });
  assert.equal(usernameBlocked.status, 429);
  assert.equal((await usernameBlocked.json()).error.code, "TOO_MANY_ATTEMPTS");

  const resetDatabase = createTestDatabase();
  t.after(() => resetDatabase.close());
  const resetEnv = testEnv(resetDatabase.DB);
  await seedLocalAdmin(resetDatabase.DB);
  for (let index = 0; index < 2; index += 1) {
    assert.equal((await login(resetEnv, {
      password: `wrong password value ${index}`,
      ip: "203.0.113.90"
    })).status, 401);
  }
  assert.equal((await login(resetEnv, { ip: "203.0.113.90" })).status, 200);
  assert.equal((await login(resetEnv, {
    password: "wrong password after reset",
    ip: "203.0.113.91"
  })).status, 401);
});

test("local login rejects cross-site login CSRF and rotates an existing browser session", async (t) => {
  const database = createTestDatabase();
  t.after(() => database.close());
  const env = testEnv(database.DB);
  await seedLocalAdmin(database.DB);

  const crossSite = await handleApiRequest(new Request(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: {
      "CF-Connecting-IP": "203.0.113.100",
      "Content-Type": "application/json",
      Origin: "https://attacker.example",
      "Sec-Fetch-Site": "cross-site"
    },
    body: JSON.stringify({ username: "Alice.Admin", password: PASSWORD })
  }), env);
  assert.equal(crossSite.status, 403);
  assert.equal(database.raw.prepare(
    "SELECT count(*) AS count FROM admin_sessions"
  ).get().count, 0);

  const first = await login(env, { ip: "203.0.113.101" });
  const firstCookie = cookiePair(first);
  const second = await login(env, {
    cookie: firstCookie,
    ip: "203.0.113.101"
  });
  const secondCookie = cookiePair(second);
  assert.equal(second.status, 200);
  assert.notEqual(secondCookie, firstCookie);
  assert.equal(database.raw.prepare(
    "SELECT count(*) AS count FROM admin_sessions"
  ).get().count, 1);
  assert.equal((await authMe(env, firstCookie)).status, 401);
  assert.equal((await authMe(env, secondCookie)).status, 200);
});

test("logout requires CSRF, revokes the session, and clears the secure cookie", async (t) => {
  const database = createTestDatabase();
  t.after(() => database.close());
  const env = testEnv(database.DB);
  await seedLocalAdmin(database.DB);
  const loginResponse = await login(env);
  const loginPayload = await loginResponse.json();
  const cookie = cookiePair(loginResponse);

  const missingCsrf = await handleApiRequest(new Request(`${ORIGIN}/api/auth/logout`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: ORIGIN }
  }), env);
  assert.equal(missingCsrf.status, 403);
  assert.equal((await missingCsrf.json()).error.code, "CSRF_INVALID");
  assert.equal(database.raw.prepare("SELECT count(*) AS count FROM admin_sessions").get().count, 1);

  const logout = await handleApiRequest(new Request(`${ORIGIN}/api/auth/logout`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: ORIGIN,
      "X-CSRF-Token": loginPayload.data.csrfToken
    }
  }), env);
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { ok: true, data: { loggedOut: true } });
  assert.match(responseCookie(logout), /^anonymous_admin_session=;/);
  assert.match(responseCookie(logout), /HttpOnly/);
  assert.match(responseCookie(logout), /SameSite=Lax/);
  assert.match(responseCookie(logout), /Secure/);
  assert.match(responseCookie(logout), /Max-Age=0/);
  assert.equal(database.raw.prepare("SELECT count(*) AS count FROM admin_sessions").get().count, 0);
  assert.equal(database.raw.prepare(`
    SELECT count(*) AS count FROM audit_logs WHERE action = 'logout'
  `).get().count, 1);

  const revoked = await authMe(env, cookie);
  assert.equal(revoked.status, 401);
  assert.equal((await revoked.json()).error.code, "UNAUTHORIZED");
  assert.match(responseCookie(revoked), /Max-Age=0/);
});

function responseCookie(response) {
  return response.headers.get("Set-Cookie") ?? "";
}

test("password change validates CSRF, current password, and policy before rotating all sessions", async (t) => {
  const database = createTestDatabase();
  t.after(() => database.close());
  const env = testEnv(database.DB);
  await seedLocalAdmin(database.DB);

  const firstLogin = await login(env, { ip: "203.0.113.70" });
  const firstPayload = await firstLogin.json();
  const firstCookie = cookiePair(firstLogin);
  const secondLogin = await login(env, { ip: "203.0.113.71" });
  const secondCookie = cookiePair(secondLogin);
  assert.equal(database.raw.prepare("SELECT count(*) AS count FROM admin_sessions").get().count, 2);

  const validBody = {
    currentPassword: PASSWORD,
    newPassword: NEW_PASSWORD,
    confirmPassword: NEW_PASSWORD
  };
  const noCsrf = await changePassword(env, firstCookie, undefined, validBody);
  assert.equal(noCsrf.status, 403);
  assert.equal((await noCsrf.json()).error.code, "CSRF_INVALID");

  const wrongCurrent = await changePassword(
    env,
    firstCookie,
    firstPayload.data.csrfToken,
    { ...validBody, currentPassword: "wrong current password" }
  );
  assert.equal(wrongCurrent.status, 401);
  assert.equal((await wrongCurrent.json()).error.code, "INVALID_CURRENT_PASSWORD");

  const shortPassword = await changePassword(
    env,
    firstCookie,
    firstPayload.data.csrfToken,
    { currentPassword: PASSWORD, newPassword: "short", confirmPassword: "short" }
  );
  assert.equal(shortPassword.status, 400);
  assert.equal((await shortPassword.json()).error.code, "PASSWORD_POLICY_INVALID");

  const mismatch = await changePassword(
    env,
    firstCookie,
    firstPayload.data.csrfToken,
    { ...validBody, confirmPassword: "different new password" }
  );
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).error.code, "PASSWORD_CONFIRMATION_MISMATCH");
  assert.equal(database.raw.prepare("SELECT count(*) AS count FROM admin_sessions").get().count, 2);

  const changed = await changePassword(
    env,
    firstCookie,
    firstPayload.data.csrfToken,
    validBody
  );
  const changedPayload = await changed.json();
  const replacementCookie = cookiePair(changed);
  assert.equal(changed.status, 200);
  assert.ok(replacementCookie);
  assert.notEqual(replacementCookie, firstCookie);
  assert.equal(changedPayload.data.user.username, "Alice.Admin");
  assert.equal(typeof changedPayload.data.csrfToken, "string");
  assert.equal(database.raw.prepare("SELECT count(*) AS count FROM admin_sessions").get().count, 1);
  assert.equal(database.raw.prepare(`
    SELECT count(*) AS count FROM audit_logs WHERE action = 'password_changed'
  `).get().count, 1);

  for (const oldCookie of [firstCookie, secondCookie]) {
    const response = await authMe(env, oldCookie);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "UNAUTHORIZED");
  }
  assert.equal((await authMe(env, replacementCookie)).status, 200);

  const oldPasswordLogin = await login(env, {
    password: PASSWORD,
    ip: "203.0.113.72"
  });
  assert.equal(oldPasswordLogin.status, 401);
  assert.equal((await oldPasswordLogin.json()).error.code, "INVALID_CREDENTIALS");

  const newPasswordLogin = await login(env, {
    password: NEW_PASSWORD,
    ip: "203.0.113.72"
  });
  assert.equal(newPasswordLogin.status, 200);
});
