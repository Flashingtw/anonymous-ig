import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticateAdmin,
  getAdminAuthProviders,
  __testables
} from "../worker/src/auth.js";
import { corsDecision, handlePreflight } from "../worker/src/http.js";
import worker, { handleApiRequest } from "../worker/src/index.js";
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

test("multi-provider config preserves GitHub and requires an explicit local-auth switch", () => {
  assert.deepEqual(
    [...getAdminAuthProviders({
      ADMIN_AUTH_PROVIDER: "github",
      ADMIN_AUTH_PROVIDERS: "github,local",
      LOCAL_AUTH_ENABLED: "false"
    })],
    ["github"]
  );
  assert.deepEqual(
    [...getAdminAuthProviders({
      ADMIN_AUTH_PROVIDER: "github",
      ADMIN_AUTH_PROVIDERS: "github,local",
      LOCAL_AUTH_ENABLED: "true"
    })],
    ["github", "local"]
  );
  assert.deepEqual(
    [...getAdminAuthProviders({
      ADMIN_AUTH_PROVIDER: "github"
    })],
    ["github"]
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

test("production CORS accepts exactly one configured public HTTPS origin", () => {
  const env = {
    APP_ENV: "production",
    PUBLIC_SITE_URL: "https://flashingtw.github.io/anonymous-ig/",
    ALLOWED_ORIGINS: "https://flashingtw.github.io"
  };

  assert.equal(corsDecision(new Request("https://anonymous.example.workers.dev/api/health", {
    headers: { Origin: "https://flashingtw.github.io" }
  }), env).allowed, true);
  assert.equal(corsDecision(new Request("https://anonymous.example.workers.dev/api/health", {
    headers: { Origin: "https://evil.github.io" }
  }), env).allowed, false);
  assert.equal(corsDecision(new Request("https://anonymous.example.workers.dev/api/health", {
    headers: { Origin: "http://localhost:8000" }
  }), env).allowed, false);

  const ambiguous = {
    APP_ENV: "production",
    PUBLIC_SITE_URL: "https://flashingtw.github.io/anonymous-ig/",
    ALLOWED_ORIGINS: "https://flashingtw.github.io,https://other.example"
  };
  assert.equal(corsDecision(new Request("https://anonymous.example.workers.dev/api/health", {
    headers: { Origin: "https://flashingtw.github.io" }
  }), ambiguous).allowed, false);

  const mismatchedPublicSite = {
    APP_ENV: "production",
    PUBLIC_SITE_URL: "https://someone-else.github.io/project/",
    ALLOWED_ORIGINS: "https://flashingtw.github.io"
  };
  assert.equal(corsDecision(new Request("https://anonymous.example.workers.dev/api/health", {
    headers: { Origin: "https://flashingtw.github.io" }
  }), mismatchedPublicSite).allowed, false);
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
    PUBLIC_SITE_URL: "https://app.example.com/",
    ALLOWED_ORIGINS: "http://localhost:8000"
  }).allowed, false);

  const secureLoopback = new Request("https://api.example.com/api/health", {
    headers: { Origin: "https://localhost:8000" }
  });
  assert.equal(corsDecision(secureLoopback, {
    APP_ENV: "production",
    FRONTEND_URL: "https://localhost:8000/",
    PUBLIC_SITE_URL: "https://localhost:8000/",
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
    PUBLIC_SITE_URL: "https://flashingtw.github.io/anonymous-ig/",
    ALLOWED_ORIGINS: "https://flashingtw.github.io"
  };
  const response = await handleApiRequest(new Request(
    "https://anonymous.example.workers.dev/api/health",
    { headers: { Origin: "https://flashingtw.github.io" } }
  ), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://flashingtw.github.io"
  );
  assert.equal(response.headers.get("Access-Control-Allow-Credentials"), null);
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
    PUBLIC_SITE_URL: "https://app.example.com/",
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
    PUBLIC_SITE_URL: "https://flashingtw.github.io/anonymous-ig/",
    ALLOWED_ORIGINS: "https://flashingtw.github.io"
  };
  const preflightHeaders = {
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "Content-Type, X-CSRF-Token"
  };
  const allowed = await handleApiRequest(new Request(
    "https://api.example.com/api/admin/submissions/1/approve",
    {
      method: "OPTIONS",
      headers: { ...preflightHeaders, Origin: "https://flashingtw.github.io" }
    }
  ), env);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "https://flashingtw.github.io");
  assert.equal(allowed.headers.get("Access-Control-Allow-Credentials"), null);
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

test("production Worker serves only the same-origin admin surface with security headers", async (t) => {
  const database = createTestDatabase();
  t.after(() => database.close());
  const assetRequests = [];
  const env = {
    DB: database.DB,
    APP_ENV: "production",
    PUBLIC_SITE_URL: "https://flashingtw.github.io/anonymous-ig/",
    ALLOWED_ORIGINS: "https://flashingtw.github.io",
    ASSETS: {
      async fetch(request) {
        assetRequests.push(new URL(request.url).pathname);
        return new Response("<!doctype html><title>Admin</title>", {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
    }
  };

  const admin = await worker.fetch(
    new Request("https://anonymous.example.workers.dev/admin/"),
    env
  );
  assert.equal(admin.status, 200);
  assert.deepEqual(assetRequests, ["/admin/"]);
  assert.equal(admin.headers.get("Cache-Control"), "no-store");
  assert.equal(admin.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(admin.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(admin.headers.get("X-Frame-Options"), "DENY");
  assert.match(admin.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
  assert.match(admin.headers.get("Content-Security-Policy"), /connect-src 'self'/);

  const root = await worker.fetch(
    new Request("https://anonymous.example.workers.dev/"),
    env
  );
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("Location"), "https://flashingtw.github.io/anonymous-ig/");

  const unrelated = await worker.fetch(
    new Request("https://anonymous.example.workers.dev/og.png"),
    env
  );
  assert.equal(unrelated.status, 404);

  const health = await worker.fetch(
    new Request("https://anonymous.example.workers.dev/api/health"),
    env
  );
  assert.equal(health.status, 200);
  assert.deepEqual(assetRequests, ["/admin/"]);
});
