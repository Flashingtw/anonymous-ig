import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PASSWORD_MIN_GRAPHEMES, PASSWORD_MAX_GRAPHEMES } from "../worker/src/security/passwords.js";
import { getAdminAuthProviders } from "../worker/src/auth.js";
import { loginRateLimitConfig } from "../worker/src/security/login-rate-limit.js";
import { usage } from "../scripts/manage-admin.js";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("password rules stay consistent across docs, examples, CLI, and UI", async () => {
  const range = `${PASSWORD_MIN_GRAPHEMES}–${PASSWORD_MAX_GRAPHEMES}`;
  const paths = ["README.md", "docs/local-auth-implementation.md", ".env.example",
    ".dev.vars.example", "frontend/content.json", "frontend/admin/index.html",
    "frontend/assets/admin.js", "worker/src/handlers/local-auth.js"];
  for (const path of paths) {
    const source = await read(path);
    assert.ok(source.includes(range), `${path} must use the backend password range`);
  }
  assert.ok(usage.includes(range));
  const script = await read("frontend/assets/admin.js");
  assert.equal(Number(script.match(/const MIN_PASSWORD_LENGTH = (\d+);/)[1]), PASSWORD_MIN_GRAPHEMES);
});

test("local env examples share provider, session, and independent login limiter defaults", async () => {
  const parse = (text) => Object.fromEntries([...text.matchAll(/^([A-Z_]+)="([^"]*)"$/gm)]
    .map((match) => [match[1], match[2]]));
  const development = parse(await read(".dev.vars.example"));
  assert.deepEqual(parse(await read(".env.example")), development);
  assert.equal(development.APP_ENV, "development");
  assert.equal(development.DEV_ADMIN_MODE, "false");
  assert.equal(development.SESSION_TTL_SECONDS, "28800");
  assert.deepEqual([...getAdminAuthProviders(development)], ["github", "local"]);
  assert.equal(development.RATE_LIMITING_ENABLED, "false");
  assert.deepEqual(loginRateLimitConfig(development), loginRateLimitConfig({}));
});

test("production rollout docs and config keep local login off until explicitly enabled", async () => {
  // These keys occur once in the production-only vars section of wrangler.jsonc.
  const config = await read("wrangler.jsonc");
  assert.match(config, /"LOCAL_AUTH_ENABLED": "false"/);
  assert.match(config, /"ADMIN_AUTH_PROVIDERS": "github,local"/);
  assert.match(config, /"DEV_ADMIN_MODE": "false"/);
  for (const path of ["README.md", "docs/local-auth-implementation.md"]) {
    const source = await read(path);
    assert.ok(source.includes("LOCAL_AUTH_ENABLED=false"));
    assert.ok(source.includes("部署狀態快照"));
  }
});
