import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { accessEnv, accessToken, jwk } from "./helpers/access.js";

test("Worker WebCrypto validates Access RSA JWT and creates the existing D1 session offline", async (t) => {
  const root = resolve(import.meta.dirname, "..");
  // The only substituted boundary is the external JWKS, never the validator.
  const bundle = await build({ stdin: { contents: `
    import { handleApiRequest } from './worker/src/index.js';
    import { createLocalJWKSet } from 'jose';
    const accessJwks = createLocalJWKSet(${JSON.stringify({ keys: [jwk] })});
    export default { fetch(request, env) { return handleApiRequest(request, env, { accessJwks }); } };
  `, resolveDir: root }, bundle: true, format: "esm", platform: "browser", write: false });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-08-31", d1Databases: ["DB"], bindings: { ...accessEnv,
      APP_ENV: "production", ACCESS_AUTH_ENABLED: "true", LOCAL_AUTH_ENABLED: "false",
      SESSION_SECRET: "isolated-runtime-access-test-secret-32-characters" } }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  for (const name of ["0001_create_submissions", "0002_create_admin_auth", "0004_add_local_admin_auth", "0005_add_access_email"]) {
    const sql = await readFile(resolve(root, `migrations/${name}.sql`), "utf8");
    await db.exec(sql.replace(/^--.*$/gm, "").replace(/[\r\n]/g, " "));
  }
  await db.prepare("INSERT INTO admins(id,github_user_id,github_username,role,access_email) VALUES(1,'101','owner','owner','owner@example.com')").run();
  const origin = "https://admin.example.test";
  const login = await mf.dispatchFetch(`${origin}/api/auth/access`, { redirect: "manual", headers: { "Cf-Access-Jwt-Assertion": await accessToken() } });
  assert.equal(login.status, 302);
  assert.match(login.headers.get("set-cookie"), /HttpOnly/);
  assert.equal(await db.prepare("SELECT admin_id FROM admin_sessions").first("admin_id"), 1);
  assert.equal(await db.prepare("SELECT action FROM audit_logs").first("action"), "access_login_success");
  const bad = await mf.dispatchFetch(`${origin}/api/auth/access`, { headers: { "Cf-Access-Jwt-Assertion": "forged", "Cf-Access-Authenticated-User-Email": "owner@example.com" } });
  assert.equal(bad.status, 403);
  assert.equal((await bad.json()).error.code, "ACCESS_AUTH_FAILED");
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM admin_sessions").first("n"), 1);
  // Exercise the shared Segmenter in workerd, not only Node/browser fixtures.
  for (const unit of ["字", "👨‍👩‍👧‍👦", "e\u0301"]) {
    for (const count of [99, 100, 101]) {
      const submitted = await mf.dispatchFetch(`${origin}/api/submissions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: unit.repeat(count) })
      });
      assert.equal(submitted.status, count <= 100 ? 201 : 400);
    }
  }
});
