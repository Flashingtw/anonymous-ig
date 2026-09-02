import assert from "node:assert/strict";
import test from "node:test";

import { authenticateAdmin, __testables } from "../worker/src/auth.js";
import { corsDecision, handlePreflight } from "../worker/src/http.js";
import { handleApiRequest } from "../worker/src/index.js";
import { createTestDatabase } from "./helpers/d1.js";

const validToken = "this-is-a-long-local-development-token";

test("development auth returns an admin principal for a valid bearer token", async () => {
  const request = new Request("http://localhost/api/admin/submissions", {
    headers: { Authorization: `Bearer ${validToken}` }
  });
  const principal = await authenticateAdmin(request, {
    APP_ENV: "development",
    ADMIN_AUTH_PROVIDER: "dev",
    DEV_ADMIN_MODE: "true",
    DEV_ADMIN_TOKEN: validToken
  });
  assert.equal(principal.provider, "dev");
  assert.deepEqual(principal.roles, ["admin"]);
});

test("development auth fails closed outside development", async () => {
  const request = new Request("https://example.com/api/admin/submissions", {
    headers: { Authorization: `Bearer ${validToken}` }
  });

  await assert.rejects(
    () => authenticateAdmin(request, {
      APP_ENV: "production",
      ADMIN_AUTH_PROVIDER: "dev",
      DEV_ADMIN_MODE: "true",
      DEV_ADMIN_TOKEN: validToken
    }),
    (error) => error.code === "ADMIN_AUTH_NOT_CONFIGURED"
  );
});

test("development auth rejects missing and incorrect tokens", async () => {
  for (const token of ["", "incorrect-token-that-is-long-enough"]) {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const request = new Request("http://localhost/api/admin/submissions", { headers });

    await assert.rejects(
      () => authenticateAdmin(request, {
        APP_ENV: "development",
        ADMIN_AUTH_PROVIDER: "dev",
        DEV_ADMIN_MODE: "true",
        DEV_ADMIN_TOKEN: validToken
      }),
      (error) => error.code === "UNAUTHORIZED" && error.status === 401
    );
  }
});

test("bearer parsing and comparison helpers are deterministic", () => {
  const request = new Request("http://localhost", {
    headers: { Authorization: "Bearer abc123" }
  });
  assert.equal(__testables.extractBearerToken(request), "abc123");
  assert.equal(__testables.timingSafeEqual("same", "same"), true);
  assert.equal(__testables.timingSafeEqual("same", "different"), false);
});

test("CORS allows same-origin and exact allowlist entries only", () => {
  const env = { ALLOWED_ORIGINS: "https://example.github.io" };
  assert.equal(corsDecision(new Request("https://api.example.com/api", {
    headers: { Origin: "https://api.example.com" }
  }), env).allowed, true);
  assert.equal(corsDecision(new Request("https://api.example.com/api", {
    headers: { Origin: "https://example.github.io" }
  }), env).allowed, true);
  assert.equal(corsDecision(new Request("https://api.example.com/api", {
    headers: { Origin: "https://evil.example" }
  }), env).allowed, false);
  assert.equal(corsDecision(new Request("https://api.example.com/api", {
    headers: { Origin: "null" }
  }), env).allowed, false);
});

test("production CORS only accepts the configured HTTPS frontend origin", () => {
  const env = {
    APP_ENV: "production",
    FRONTEND_URL: "https://app.example.com/",
    ALLOWED_ORIGINS: [
      "https://app.example.com",
      "https://other.example.com",
      "http://localhost:8000",
      "*"
    ].join(",")
  };

  assert.equal(corsDecision(new Request("https://api.example.com/api/health", {
    headers: { Origin: "https://app.example.com" }
  }), env).allowed, true);
  assert.equal(corsDecision(new Request("https://api.example.com/api/health", {
    headers: { Origin: "https://other.example.com" }
  }), env).allowed, false);
  assert.equal(corsDecision(new Request("https://api.example.com/api/health", {
    headers: { Origin: "http://localhost:8000" }
  }), env).allowed, false);
});

test("localhost CORS origins are accepted only during development", () => {
  const request = new Request("http://127.0.0.1:8787/api/health", {
    headers: { Origin: "http://localhost:8000" }
  });
  assert.equal(corsDecision(request, {
    APP_ENV: "development",
    ALLOWED_ORIGINS: "http://localhost:8000"
  }).allowed, true);
  assert.equal(corsDecision(request, {
    APP_ENV: "production",
    FRONTEND_URL: "https://app.example.com/",
    ALLOWED_ORIGINS: "http://localhost:8000"
  }).allowed, false);

  const secureLoopback = new Request("https://api.example.com/api/health", {
    headers: { Origin: "https://localhost:8000" }
  });
  assert.equal(corsDecision(secureLoopback, {
    APP_ENV: "production",
    FRONTEND_URL: "https://localhost:8000/",
    ALLOWED_ORIGINS: "https://localhost:8000"
  }).allowed, false);
});

test("preflight accepts required headers and rejects extras", () => {
  const allowed = handlePreflight(new Request("https://api.example.com/api", {
    method: "OPTIONS",
    headers: {
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Content-Type, Authorization, X-CSRF-Token"
    }
  }));
  assert.equal(allowed.status, 204);
  assert.match(
    allowed.headers.get("Access-Control-Allow-Headers"),
    /X-CSRF-Token/
  );

  const denied = handlePreflight(new Request("https://api.example.com/api", {
    method: "OPTIONS",
    headers: {
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "X-Unsafe"
    }
  }));
  assert.equal(denied.status, 403);
});

test("health checks D1 without exposing internals and carries API security headers", async (t) => {
  const database = createTestDatabase();
  t.after(() => database.close());
  const env = {
    DB: database.DB,
    APP_ENV: "production",
    FRONTEND_URL: "https://app.example.com/",
    ALLOWED_ORIGINS: "https://app.example.com"
  };
  const response = await handleApiRequest(new Request(
    "https://api.example.com/api/health",
    { headers: { Origin: "https://app.example.com" } }
  ), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://app.example.com"
  );
  assert.equal(response.headers.get("Access-Control-Allow-Credentials"), "true");
  assert.match(response.headers.get("Vary"), /Origin/);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.match(response.headers.get("Content-Security-Policy"), /default-src 'none'/);

  const wrongMethod = await handleApiRequest(new Request(
    "https://api.example.com/api/health",
    { method: "POST" }
  ), env);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("Allow"), "GET");
});

test("production health errors and logs omit SQL, bindings, stack, and secrets", async () => {
  const sensitiveText = "SQL SELECT secret_cookie FROM binding_DB";
  const env = {
    APP_ENV: "production",
    FRONTEND_URL: "https://app.example.com/",
    ALLOWED_ORIGINS: "https://app.example.com",
    DB: {
      prepare() {
        throw new Error(sensitiveText);
      }
    }
  };
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...values) => logged.push(values.join(" "));

  try {
    const response = await handleApiRequest(
      new Request("https://api.example.com/api/health"),
      env
    );
    const body = await response.text();
    assert.equal(response.status, 503);
    assert.doesNotMatch(body, /SQL|secret_cookie|binding_DB|stack/i);
    assert.doesNotMatch(logged.join("\n"), /secret_cookie|binding_DB/);
  } finally {
    console.error = originalConsoleError;
  }
});

test("allowed and denied preflight responses apply credentials safely", async () => {
  const env = {
    APP_ENV: "production",
    FRONTEND_URL: "https://app.example.com/",
    ALLOWED_ORIGINS: "https://app.example.com"
  };
  const preflightHeaders = {
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "Content-Type, X-CSRF-Token"
  };
  const allowed = await handleApiRequest(new Request(
    "https://api.example.com/api/admin/submissions/1/approve",
    {
      method: "OPTIONS",
      headers: { ...preflightHeaders, Origin: "https://app.example.com" }
    }
  ), env);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "https://app.example.com");
  assert.equal(allowed.headers.get("Access-Control-Allow-Credentials"), "true");
  assert.equal(allowed.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(allowed.headers.get("Referrer-Policy"), "no-referrer");

  const denied = await handleApiRequest(new Request(
    "https://api.example.com/api/admin/submissions/1/approve",
    {
      method: "OPTIONS",
      headers: { ...preflightHeaders, Origin: "https://evil.example" }
    }
  ), env);
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(denied.headers.get("Access-Control-Allow-Credentials"), null);
});
