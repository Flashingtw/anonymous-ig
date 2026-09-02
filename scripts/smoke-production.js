import assert from "node:assert/strict";

function requireHttpsUrl(name, value, { originOnly = true } = {}) {
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS origin.`);
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
    || (originOnly && url.pathname !== "/")
  ) {
    throw new Error(`${name} must be an HTTPS origin without a path, query, or hash.`);
  }
  return url.origin;
}

const apiOrigin = requireHttpsUrl(
  "SMOKE_API_BASE_URL",
  process.env.SMOKE_API_BASE_URL
);
const frontendOrigin = requireHttpsUrl(
  "SMOKE_FRONTEND_ORIGIN",
  process.env.SMOKE_FRONTEND_ORIGIN
);
if (apiOrigin === frontendOrigin) {
  throw new Error("Production frontend and API must be different origins.");
}

async function request(path, options = {}) {
  const response = await fetch(`${apiOrigin}${path}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    ...options
  });
  const contentType = response.headers.get("Content-Type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : null;
  return { payload, response };
}

const health = await request("/api/health");
assert.equal(health.response.status, 200, "health endpoint must return 200");
assert.deepEqual(health.payload, { ok: true });

// GET verifies that the public route is reachable without creating a submission.
const publicConnectivity = await request("/api/submissions");
assert.equal(publicConnectivity.response.status, 405);
assert.equal(publicConnectivity.response.headers.get("Allow"), "POST");

const unauthenticatedAdmin = await request("/api/admin/submissions");
assert.equal(unauthenticatedAdmin.response.status, 401);
assert.equal(unauthenticatedAdmin.payload?.error?.code, "UNAUTHORIZED");

const allowedPreflight = await request("/api/submissions", {
  method: "OPTIONS",
  headers: {
    Origin: frontendOrigin,
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "Content-Type"
  }
});
assert.equal(allowedPreflight.response.status, 204);
assert.equal(
  allowedPreflight.response.headers.get("Access-Control-Allow-Origin"),
  frontendOrigin
);
assert.equal(
  allowedPreflight.response.headers.get("Access-Control-Allow-Credentials"),
  null
);
assert.notEqual(
  allowedPreflight.response.headers.get("Access-Control-Allow-Origin"),
  "*"
);

const deniedPreflight = await request("/api/submissions", {
  method: "OPTIONS",
  headers: {
    Origin: "https://not-allowed.invalid",
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "Content-Type"
  }
});
assert.equal(deniedPreflight.response.status, 403);
assert.equal(deniedPreflight.response.headers.get("Access-Control-Allow-Origin"), null);
assert.equal(
  deniedPreflight.response.headers.get("Access-Control-Allow-Credentials"),
  null
);

const adminSurface = await request("/admin/");
assert.equal(adminSurface.response.status, 200);
assert.equal(adminSurface.response.headers.get("Cache-Control"), "no-store");
assert.equal(adminSurface.response.headers.get("X-Content-Type-Options"), "nosniff");
assert.match(
  adminSurface.response.headers.get("Content-Security-Policy") ?? "",
  /frame-ancestors 'none'/
);

console.log("Read-only production smoke checks passed. No submission was created.");
console.log("Manual checks still required:");
console.log("1. Complete GitHub OAuth and confirm the callback returns to /admin/.");
console.log("2. Submit clearly labelled test content, then approve and reject it.");
console.log("3. Log out and confirm the admin API returns 401.");
console.log("4. Confirm the configured session expires at the expected time.");
