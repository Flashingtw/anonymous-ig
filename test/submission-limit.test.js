import assert from "node:assert/strict";
import test from "node:test";
import { handleApiRequest } from "../worker/src/index.js";
import { createTestDatabase } from "./helpers/d1.js";
import { accessEnv, accessToken, accessJwks } from "./helpers/access.js";

test("new submissions accept 99/100 but reject 101 Unicode graphemes without truncation", async t => {
  const db = createTestDatabase();
  t.after(() => db.close());
  const env = { DB: db.DB };
  for (const unit of ["字", "🙂", "👨‍👩‍👧‍👦", "e\u0301", "🇹🇼", "👍🏽"]) {
    for (const length of [99, 100, 101]) {
      const response = await handleApiRequest(new Request("https://local.test/api/submissions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: unit.repeat(length) })
      }), env);
      assert.equal(response.status, length <= 100 ? 201 : 400, `${unit} × ${length}`);
      if (length === 101) assert.equal((await response.json()).error.code, "CONTENT_TOO_LONG");
    }
  }
});

test("older submissions over 100 graphemes remain readable and moderatable, roster stays read-only", async t => {
  const db = createTestDatabase();
  t.after(() => db.close());
  const legacy = "舊".repeat(150);
  db.raw.prepare("INSERT INTO submissions(content) VALUES(?)").run(legacy);
  db.raw.exec("INSERT INTO admins(access_email,role) VALUES('owner@example.com','owner')");
  const env = { ...accessEnv, DB: db.DB, ACCESS_AUTH_ENABLED: "true", SESSION_SECRET: "test-only-session-secret-with-32-characters" };
  const call = (path, options = {}) => handleApiRequest(new Request(`https://local.test${path}`, options), env, { accessJwks });
  const login = await call("/api/auth/access", { headers: { "Cf-Access-Jwt-Assertion": await accessToken({ email: "owner@example.com" }) } });
  const Cookie = login.headers.get("set-cookie").split(";")[0];
  const { data: me } = await (await call("/api/auth/me", { headers: { Cookie } })).json();
  const headers = { Cookie, "X-CSRF-Token": me.csrfToken };
  const listing = await (await call("/api/admin/submissions", { headers })).json();
  assert.equal(listing.data.submissions[0].content, legacy);
  const approved = await (await call("/api/admin/submissions/1/approve", { method: "POST", headers })).json();
  assert.equal(approved.data.submission.content, legacy);
  assert.equal(approved.data.submission.status, "approved");
  assert.equal((await call("/api/admin/admins", { method: "POST", headers })).status, 405);
  assert.equal((await call("/api/admin/accounts", { method: "POST", headers })).status, 404);
});
