import assert from "node:assert/strict";
import test from "node:test";

import { handleApiRequest } from "../worker/src/index.js";
import { updatePendingSubmissionStatusWithAudit } from "../worker/src/repositories/submissions.js";
import { clearSessionCookie } from "../worker/src/security/cookies.js";
import { sha256Base64Url } from "../worker/src/security/crypto.js";
import { runCli } from "../scripts/manage-admin.js";
import { createTestDatabase } from "./helpers/d1.js";

const ORIGIN = "http://127.0.0.1:8787";
const CALLBACK_URL = `${ORIGIN}/api/auth/github/callback`;
const SESSION_SECRET = "test-session-secret-with-more-than-thirty-two-characters";
const MOCK_ACCESS_TOKEN = "github-test-access-token-never-persist";

test("CLI binding makes GitHub and local login resolve to the same existing owner", async (t) => {
  const database = createTestDatabase();
  t.after(() => database.close());
  const env = testEnv(database.DB, { ADMIN_AUTH_PROVIDERS: "github,local", LOCAL_AUTH_ENABLED: "true" });
  const adminId = await seedAdmin(database.DB, { role: "owner" });
  const password = "dual identity test passphrase";
  await runCli(["bind-local", "--github-user-id", "101", "--username", "Dual.User", "--local", "--execute"], {
    query: async ({ sql }) => database.raw.prepare(sql).all(),
    execute: async ({ sql }) => database.raw.exec(sql),
    passwordReader: async () => password,
    logger: { log() {} }
  });
  const github = await completeLogin(env, { id: 101, login: "renamed-on-github" });
  assert.equal(new URL(github.response.headers.get("Location")).searchParams.get("auth"), "success");
  const local = await handleApiRequest(new Request(`${ORIGIN}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ username: "DUAL.USER", password })
  }), env);
  assert.equal(local.status, 200);
  const data = (await local.json()).data;
  assert.deepEqual(data.user.authMethods, ["github", "local"]);
  assert.equal(data.user.githubUsername, "renamed-on-github");
  assert.equal(data.user.role, "owner");
  assert.equal(database.raw.prepare("SELECT COUNT(*) AS n FROM admins").get().n, 1);
  const sessions = database.raw.prepare("SELECT admin_id FROM admin_sessions").all();
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every((session) => session.admin_id === adminId));
});

function testEnv(DB, overrides = {}) {
  return {
    DB,
    APP_ENV: "development",
    ADMIN_AUTH_PROVIDER: "github",
    GITHUB_CLIENT_ID: "test-client-id",
    GITHUB_CLIENT_SECRET: "test-client-secret",
    GITHUB_REDIRECT_URI: CALLBACK_URL,
    FRONTEND_URL: `${ORIGIN}/`,
    SESSION_SECRET,
    SESSION_TTL_SECONDS: "3600",
    ALLOWED_ORIGINS: "",
    ...overrides
  };
}

function setCookies(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  const combined = response.headers.get("Set-Cookie");
  return combined ? [combined] : [];
}

function cookiePair(setCookie) {
  return setCookie.split(";", 1)[0];
}

function findCookie(response, name) {
  const match = setCookies(response).find((cookie) => cookie.startsWith(`${name}=`));
  return match ? cookiePair(match) : "";
}

async function responseJson(response) {
  return response.json();
}

async function seedAdmin(DB, {
  githubUserId = "101",
  githubUsername = "seed-name",
  role = "admin",
  enabled = 1
} = {}) {
  return DB.prepare(`
    INSERT INTO admins (github_user_id, github_username, role, enabled)
    VALUES (?, ?, ?, ?)
    RETURNING id
  `).bind(githubUserId, githubUsername, role, enabled).first("id");
}

async function seedSubmission(DB, content) {
  return DB.prepare(`
    INSERT INTO submissions (content)
    VALUES (?)
    RETURNING id
  `).bind(content).first("id");
}

async function beginLogin(env) {
  const apiOrigin = new URL(env.GITHUB_REDIRECT_URI).origin;
  const response = await handleApiRequest(
    new Request(`${apiOrigin}/api/auth/github`),
    env
  );
  assert.equal(response.status, 302);

  const authorizationUrl = new URL(response.headers.get("Location"));
  assert.equal(authorizationUrl.origin, "https://github.com");
  assert.equal(authorizationUrl.pathname, "/login/oauth/authorize");
  assert.equal(authorizationUrl.searchParams.get("scope"), null);
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");

  return {
    state: authorizationUrl.searchParams.get("state"),
    challenge: authorizationUrl.searchParams.get("code_challenge"),
    oauthCookie: findCookie(response, "anonymous_oauth_request")
  };
}

function githubFetchMock(profile, expectedChallenge, expectedRedirectUri) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });

    if (String(url) === "https://github.com/login/oauth/access_token") {
      const parameters = new URLSearchParams(options.body);
      assert.equal(parameters.get("client_secret"), "test-client-secret");
      assert.equal(parameters.get("redirect_uri"), expectedRedirectUri);
      assert.equal(
        await sha256Base64Url(parameters.get("code_verifier")),
        expectedChallenge
      );
      return Response.json({
        access_token: MOCK_ACCESS_TOKEN,
        token_type: "bearer",
        scope: ""
      });
    }

    if (String(url) === "https://api.github.com/user") {
      assert.equal(options.headers.Authorization, `Bearer ${MOCK_ACCESS_TOKEN}`);
      assert.equal(options.headers["X-GitHub-Api-Version"], "2026-03-10");
      return Response.json(profile);
    }

    throw new Error(`Unexpected GitHub request: ${url}`);
  };

  return { calls, fetchImpl };
}

async function completeLogin(env, profile) {
  const started = await beginLogin(env);
  const github = githubFetchMock(
    profile,
    started.challenge,
    env.GITHUB_REDIRECT_URI
  );
  const response = await handleApiRequest(
    new Request(
      `${env.GITHUB_REDIRECT_URI}?code=test-code&state=${encodeURIComponent(started.state)}`,
      { headers: { Cookie: started.oauthCookie } }
    ),
    env,
    { fetchImpl: github.fetchImpl }
  );

  return {
    ...started,
    calls: github.calls,
    response,
    sessionCookie: findCookie(response, "anonymous_admin_session")
  };
}

async function getSession(env, sessionCookie) {
  const response = await handleApiRequest(
    new Request(`${ORIGIN}/api/auth/me`, {
      headers: { Cookie: sessionCookie }
    }),
    env
  );
  return { response, payload: await responseJson(response) };
}

test("unauthenticated requests cannot read any admin route", async (t) => {
  const database = createTestDatabase();
  t.after(() => database.close());
  const env = testEnv(database.DB);

  for (const path of ["/api/admin/submissions", "/api/admin/not-a-route"]) {
    const response = await handleApiRequest(new Request(`${ORIGIN}${path}`), env);
    assert.equal(response.status, 401);
    assert.equal((await responseJson(response)).error.code, "UNAUTHORIZED");
  }
});

test("a GitHub user missing from the allowlist is rejected", async (t) => {
  const database = createTestDatabase();
  t.after(() => database.close());
  const env = testEnv(database.DB);

  const login = await completeLogin(env, { id: 999, login: "outsider" });
  assert.equal(login.response.status, 302);
  assert.equal(new URL(login.response.headers.get("Location")).searchParams.get("auth"), "unauthorized");
  assert.equal(login.sessionCookie, "");
  assert.equal(database.raw.prepare("SELECT count(*) AS count FROM admin_sessions").get().count, 0);
  assert.equal(database.raw.prepare("SELECT count(*) AS count FROM audit_logs").get().count, 0);
});

test("a disabled allowlisted admin is rejected", async (t) => {
  const database = createTestDatabase();
  t.after(() => database.close());
  const env = testEnv(database.DB);
  await seedAdmin(database.DB, {
    githubUserId: "202",
    githubUsername: "disabled-user",
    enabled: 0
  });

  const login = await completeLogin(env, { id: 202, login: "disabled-user" });
  assert.equal(login.response.status, 302);
  assert.equal(new URL(login.response.headers.get("Location")).searchParams.get("auth"), "unauthorized");
  assert.equal(login.sessionCookie, "");
});

test("disabling an admin invalidates an already-issued session at middleware", async (t) => {
  const database = createTestDatabase();
  t.after(() => database.close());
  const env = testEnv(database.DB);
  const adminId = await seedAdmin(database.DB, {
    githubUserId: "212",
    githubUsername: "soon-disabled"
  });
  const login = await completeLogin(env, { id: 212, login: "soon-disabled" });
  assert.ok(login.sessionCookie);

  database.raw.prepare(`
    UPDATE admins SET enabled = 0 WHERE id = ?
  `).run(adminId);
  const response = await handleApiRequest(
    new Request(`${ORIGIN}/api/admin/submissions`, {
      headers: { Cookie: login.sessionCookie }
    }),
    env
  );

  assert.equal(response.status, 401);
  assert.equal((await responseJson(response)).error.code, "UNAUTHORIZED");
});

test("an incorrect OAuth state redirects safely before GitHub is called", async (t) => {
  const database = createTestDatabase();
  t.after(() => database.close());
  const env = testEnv(database.DB);
  const started = await beginLogin(env);
  let githubCalled = false;
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...values) => logged.push(values.join(" "));

  let response;
  try {
    response = await handleApiRequest(
      new Request(`${CALLBACK_URL}?code=test-code&state=wrong-state`, {
        headers: { Cookie: started.oauthCookie }
      }),
      env,
      { fetchImpl: async () => {
        githubCalled = true;
        throw new Error("must not be called");
      } }
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("Location"));
  assert.equal(location.origin, ORIGIN);
  assert.equal(location.pathname, "/admin/");
  assert.equal(location.searchParams.get("auth"), "error");
  assert.equal(location.searchParams.has("code"), false);
  assert.equal(location.searchParams.has("state"), false);
  assert.equal(githubCalled, false);
  assert.match(response.headers.get("Set-Cookie"), /Max-Age=0/);
  assert.match(logged.join("\n"), /"stage":"oauth_state"/);
  assert.match(logged.join("\n"), /"code":"OAUTH_STATE_INVALID"/);
  assert.doesNotMatch(logged.join("\n"), /wrong-state|test-code/);
  assert.doesNotMatch(logged.join("\n"), /errorName/);
});

test("a missing OAuth request cookie logs only a fixed safe stage", async (t) => {
  const database = createTestDatabase();
  t.after(() => database.close());
  const env = testEnv(database.DB);
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...values) => logged.push(values.join(" "));

  let response;
  try {
    response = await handleApiRequest(
      new Request(`${CALLBACK_URL}?code=private-code&state=private-state`),
      env
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.status, 302);
  assert.equal(
    new URL(response.headers.get("Location")).search,
    "?auth=error"
  );
  assert.match(logged.join("\n"), /"stage":"oauth_request_cookie"/);
  assert.match(logged.join("\n"), /"code":"OAUTH_REQUEST_COOKIE_INVALID"/);
  assert.doesNotMatch(logged.join("\n"), /private-code|private-state/);
  assert.doesNotMatch(logged.join("\n"), /errorName/);
});

test("OAuth callback failures and cancellation return only fixed frontend results", async (t) => {
  const database = createTestDatabase();
  t.after(() => database.close());
  const env = testEnv(database.DB);

  const missingCode = await beginLogin(env);
  const missingCodeLogged = [];
  const originalMissingCodeConsoleError = console.error;
  console.error = (...values) => missingCodeLogged.push(values.join(" "));
  let missingCodeResponse;
  try {
    missingCodeResponse = await handleApiRequest(
      new Request(`${CALLBACK_URL}?state=${encodeURIComponent(missingCode.state)}`, {
        headers: { Cookie: missingCode.oauthCookie }
      }),
      env
    );
  } finally {
    console.error = originalMissingCodeConsoleError;
  }
  assert.equal(missingCodeResponse.status, 302);
  assert.equal(
    new URL(missingCodeResponse.headers.get("Location")).searchParams.get("auth"),
    "error"
  );
  assert.match(missingCodeLogged.join("\n"), /"stage":"authorization_code"/);
  assert.match(missingCodeLogged.join("\n"), /"code":"OAUTH_CODE_INVALID"/);
  assert.doesNotMatch(missingCodeLogged.join("\n"), new RegExp(missingCode.state));

  const cancelled = await beginLogin(env);
  const cancelledResponse = await handleApiRequest(
    new Request(
      `${CALLBACK_URL}?error=access_denied&error_description=sensitive&state=${encodeURIComponent(cancelled.state)}`,
      { headers: { Cookie: cancelled.oauthCookie } }
    ),
    env
  );
  const cancelledLocation = new URL(cancelledResponse.headers.get("Location"));
  assert.equal(cancelledResponse.status, 302);
  assert.equal(cancelledLocation.searchParams.get("auth"), "cancelled");
  assert.equal(cancelledLocation.searchParams.has("error_description"), false);
  assert.equal(cancelledLocation.searchParams.has("state"), false);

  const githubFailure = await beginLogin(env);
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...values) => logged.push(values.join(" "));
  try {
    const githubFailureResponse = await handleApiRequest(
      new Request(
        `${CALLBACK_URL}?code=secret-code&state=${encodeURIComponent(githubFailure.state)}`,
        { headers: { Cookie: githubFailure.oauthCookie } }
      ),
      env,
      { fetchImpl: async () => new Response(null, { status: 502 }) }
    );
    const githubFailureLocation = new URL(
      githubFailureResponse.headers.get("Location")
    );
    assert.equal(githubFailureResponse.status, 302);
    assert.equal(githubFailureLocation.searchParams.get("auth"), "error");
    assert.equal(githubFailureLocation.href.includes("secret-code"), false);
    assert.equal(logged.join("\n").includes("secret-code"), false);
    assert.match(logged.join("\n"), /"stage":"token_exchange"/);
    assert.match(logged.join("\n"), /"code":"GITHUB_OAUTH_FAILED"/);
  } finally {
    console.error = originalConsoleError;
  }

});

test("a callback configuration error still returns to a valid frontend URL", async (t) => {
  const database = createTestDatabase();
  t.after(() => database.close());
  const env = testEnv(database.DB, { GITHUB_CLIENT_SECRET: "" });
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const response = await handleApiRequest(
      new Request(`${CALLBACK_URL}?code=must-not-be-forwarded&state=also-private`),
      env
    );
    const location = new URL(response.headers.get("Location"));
    assert.equal(response.status, 302);
    assert.equal(location.origin, ORIGIN);
    assert.equal(location.pathname, "/admin/");
    assert.equal(location.search, "?auth=error");
  } finally {
    console.error = originalConsoleError;
  }
});

test("a failed moderation audit rolls back the submission status change", async (t) => {
  const database = createTestDatabase();
  t.after(() => database.close());
  const adminId = await seedAdmin(database.DB, {
    githubUserId: "252",
    githubUsername: "atomic-admin"
  });
  const submissionId = await seedSubmission(database.DB, "must stay pending");

  database.raw.exec(`
    CREATE TRIGGER fail_moderation_audit
    BEFORE INSERT ON audit_logs
    WHEN NEW.action IN ('approve_submission', 'reject_submission')
    BEGIN
      SELECT RAISE(ABORT, 'forced audit failure');
    END;
  `);

  await assert.rejects(
    () => updatePendingSubmissionStatusWithAudit(
      database.DB,
      submissionId,
      "approved",
      {
        adminId,
        action: "approve_submission",
        submissionId,
        metadata: { next_status: "approved" }
      }
    ),
    /forced audit failure/
  );

  assert.equal(
    database.raw.prepare("SELECT status FROM submissions WHERE id = ?").get(submissionId).status,
    "pending"
  );
  assert.equal(
    database.raw.prepare(`
      SELECT count(*) AS count
      FROM audit_logs
      WHERE action = 'approve_submission'
    `).get().count,
    0
  );
});

test("logout still revokes the session when its audit write fails", async (t) => {
  const database = createTestDatabase();
  t.after(() => database.close());
  const env = testEnv(database.DB);
  await seedAdmin(database.DB, {
    githubUserId: "262",
    githubUsername: "logout-failsafe"
  });
  const login = await completeLogin(env, { id: 262, login: "logout-failsafe" });
  const me = await getSession(env, login.sessionCookie);

  database.raw.exec(`
    CREATE TRIGGER fail_logout_audit
    BEFORE INSERT ON audit_logs
    WHEN NEW.action = 'logout'
    BEGIN
      SELECT RAISE(ABORT, 'forced logout audit failure');
    END;
  `);

  const logout = await handleApiRequest(
    new Request(`${ORIGIN}/api/auth/logout`, {
      method: "POST",
      headers: {
        Cookie: login.sessionCookie,
        "X-CSRF-Token": me.payload.data.csrfToken
      }
    }),
    env
  );
  assert.equal(logout.status, 500);
  assert.equal((await responseJson(logout)).error.code, "AUDIT_LOG_FAILED");
  assert.match(logout.headers.get("Set-Cookie"), /Max-Age=0/);

  const afterLogout = await handleApiRequest(
    new Request(`${ORIGIN}/api/auth/me`, {
      headers: { Cookie: login.sessionCookie }
    }),
    env
  );
  assert.equal(afterLogout.status, 401);
});

test("admin login, approve, reject, audit, and logout form one valid session flow", async (t) => {
  const database = createTestDatabase();
  t.after(() => database.close());
  const env = testEnv(database.DB);
  const adminId = await seedAdmin(database.DB, {
    githubUserId: "303",
    githubUsername: "old-name",
    role: "admin"
  });
  const approveId = await seedSubmission(database.DB, "approve candidate");
  const rejectId = await seedSubmission(database.DB, "reject candidate");

  const login = await completeLogin(env, { id: 303, login: "current-name" });
  assert.equal(login.response.status, 302);
  assert.equal(new URL(login.response.headers.get("Location")).searchParams.get("auth"), "success");
  assert.ok(login.sessionCookie);
  assert.equal(login.calls.length, 2);

  const storedSession = database.raw.prepare(`
    SELECT token_hash, expires_at FROM admin_sessions WHERE admin_id = ?
  `).get(adminId);
  const rawToken = login.sessionCookie.slice(login.sessionCookie.indexOf("=") + 1);
  assert.equal(storedSession.token_hash.length, 64);
  assert.notEqual(storedSession.token_hash, rawToken);
  assert.ok(Date.parse(storedSession.expires_at) > Date.now());

  const me = await getSession(env, login.sessionCookie);
  assert.equal(me.response.status, 200);
  assert.deepEqual(me.payload.data.user, {
    username: null,
    githubUsername: "current-name",
    role: "admin",
    authMethods: ["github"]
  });
  assert.ok(me.payload.data.csrfToken);

  const missingCsrf = await handleApiRequest(
    new Request(`${ORIGIN}/api/admin/submissions/${approveId}/approve`, {
      method: "POST",
      headers: { Cookie: login.sessionCookie }
    }),
    env
  );
  assert.equal(missingCsrf.status, 403);
  assert.equal((await responseJson(missingCsrf)).error.code, "CSRF_INVALID");

  const mutationHeaders = {
    Cookie: login.sessionCookie,
    "X-CSRF-Token": me.payload.data.csrfToken
  };
  const approved = await handleApiRequest(
    new Request(`${ORIGIN}/api/admin/submissions/${approveId}/approve`, {
      method: "POST",
      headers: mutationHeaders
    }),
    env
  );
  assert.equal(approved.status, 200);
  assert.equal((await responseJson(approved)).data.submission.status, "approved");

  const rejected = await handleApiRequest(
    new Request(`${ORIGIN}/api/admin/submissions/${rejectId}/reject`, {
      method: "POST",
      headers: mutationHeaders
    }),
    env
  );
  assert.equal(rejected.status, 200);
  assert.equal((await responseJson(rejected)).data.submission.status, "rejected");

  const logout = await handleApiRequest(
    new Request(`${ORIGIN}/api/auth/logout`, {
      method: "POST",
      headers: mutationHeaders
    }),
    env
  );
  assert.equal(logout.status, 200);
  assert.equal((await responseJson(logout)).data.loggedOut, true);
  assert.match(logout.headers.get("Set-Cookie"), /Max-Age=0/);

  const afterLogout = await handleApiRequest(
    new Request(`${ORIGIN}/api/admin/submissions`, {
      headers: { Cookie: login.sessionCookie }
    }),
    env
  );
  assert.equal(afterLogout.status, 401);

  const auditLogs = database.raw.prepare(`
    SELECT admin_id, action, submission_id, metadata
    FROM audit_logs
    ORDER BY id
  `).all();
  assert.deepEqual(auditLogs.map((log) => log.action), [
    "login",
    "approve_submission",
    "reject_submission",
    "logout"
  ]);
  assert.deepEqual(auditLogs.map((log) => log.submission_id), [
    null,
    approveId,
    rejectId,
    null
  ]);
  assert.ok(auditLogs.every((log) => log.admin_id === adminId));
  assert.ok(auditLogs.every((log) => !String(log.metadata).includes(MOCK_ACCESS_TOKEN)));
  assert.ok(auditLogs.every((log) => !String(log.metadata).includes(rawToken)));
});

test("production OAuth and session cookies are HttpOnly, Secure, SameSite=Lax, and expiring", async (t) => {
  const database = createTestDatabase();
  t.after(() => database.close());
  const env = testEnv(database.DB, {
    APP_ENV: "production",
    GITHUB_REDIRECT_URI: "https://anonymous.example.workers.dev/api/auth/github/callback",
    FRONTEND_URL: "https://anonymous.example.workers.dev/"
  });
  await seedAdmin(database.DB, {
    githubUserId: "404",
    githubUsername: "secure-cookie-owner",
    role: "owner"
  });

  const loginStart = await handleApiRequest(
    new Request("https://anonymous.example.workers.dev/api/auth/github"),
    env
  );
  const oauthCookie = setCookies(loginStart)[0];
  assert.equal(loginStart.headers.get("Cache-Control"), "no-store");
  assert.equal(loginStart.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(loginStart.headers.get("X-Content-Type-Options"), "nosniff");
  assert.match(loginStart.headers.get("Content-Security-Policy"), /default-src 'none'/);
  assert.match(oauthCookie, /HttpOnly/);
  assert.match(oauthCookie, /Secure/);
  assert.match(oauthCookie, /SameSite=Lax/);
  assert.match(oauthCookie, /Max-Age=600/);

  const login = await completeLogin(env, {
    id: 404,
    login: "secure-cookie-owner"
  });
  const sessionCookieHeader = setCookies(login.response)
    .find((cookie) => cookie.startsWith("anonymous_admin_session="));
  assert.match(sessionCookieHeader, /HttpOnly/);
  assert.match(sessionCookieHeader, /Secure/);
  assert.match(sessionCookieHeader, /SameSite=Lax/);
  assert.match(sessionCookieHeader, /; Path=\/;/);
  assert.match(sessionCookieHeader, /Max-Age=3600/);
  assert.match(sessionCookieHeader, /Expires=[^;]+/);
  assert.doesNotMatch(sessionCookieHeader, /Domain=/i);

  const clearedSessionCookie = clearSessionCookie(env);
  assert.match(clearedSessionCookie, /; Path=\/;/);
  assert.match(clearedSessionCookie, /HttpOnly/);
  assert.match(clearedSessionCookie, /Secure/);
  assert.match(clearedSessionCookie, /SameSite=Lax/);
  assert.match(clearedSessionCookie, /Max-Age=0/);
  assert.match(clearedSessionCookie, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
  assert.doesNotMatch(clearedSessionCookie, /Domain=/i);
});

test("production OAuth rejects a cross-site admin frontend configuration", async (t) => {
  const database = createTestDatabase();
  t.after(() => database.close());
  const env = testEnv(database.DB, {
    APP_ENV: "production",
    GITHUB_REDIRECT_URI: "https://anonymous.example.workers.dev/api/auth/github/callback",
    FRONTEND_URL: "https://flashingtw.github.io/anonymous-ig/"
  });

  const response = await handleApiRequest(
    new Request("https://anonymous.example.workers.dev/api/auth/github"),
    env
  );
  assert.equal(response.status, 503);
  assert.equal((await responseJson(response)).error.code, "ADMIN_AUTH_NOT_CONFIGURED");

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const callback = await handleApiRequest(
      new Request(
        "https://anonymous.example.workers.dev/api/auth/github/callback?code=private&state=private"
      ),
      env
    );
    const location = new URL(callback.headers.get("Location"));
    assert.equal(callback.status, 302);
    assert.equal(location.origin, "https://anonymous.example.workers.dev");
    assert.equal(location.pathname, "/admin/");
    assert.equal(location.search, "?auth=error");

    const wrongCallbackPath = testEnv(database.DB, {
      APP_ENV: "production",
      GITHUB_REDIRECT_URI: "https://anonymous.example.workers.dev/not-the-callback",
      FRONTEND_URL: "https://anonymous.example.workers.dev/"
    });
    const wrongCallbackResponse = await handleApiRequest(
      new Request("https://anonymous.example.workers.dev/api/auth/github"),
      wrongCallbackPath
    );
    assert.equal(wrongCallbackResponse.status, 503);
  } finally {
    console.error = originalConsoleError;
  }
});
