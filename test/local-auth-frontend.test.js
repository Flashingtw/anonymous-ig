import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const projectRoot = resolve(import.meta.dirname, "..");

test("admin login offers accessible local credentials alongside GitHub", async () => {
  const html = await readFile(resolve(projectRoot, "frontend/admin/index.html"), "utf8");

  assert.match(html, /id="local-auth-form"/);
  assert.match(html, /for="local-username"/);
  assert.match(html, /id="local-username"[\s\S]*autocomplete="username"/);
  assert.match(html, /for="local-password"/);
  assert.match(html, /id="local-password"[\s\S]*autocomplete="current-password"/);
  assert.match(html, /id="auth-divider"[\s\S]*>或</);
  assert.match(html, /id="github-sign-in"/);
  assert.match(html, /id="admin-auth-form"/);
  assert.match(html, /id="auth-error"[\s\S]*aria-live="assertive"/);
});

test("admin script discovers providers and reuses the opaque session", async () => {
  const [script, authScript] = await Promise.all([
    readFile(resolve(projectRoot, "frontend/assets/admin.js"), "utf8"),
    readFile(resolve(projectRoot, "frontend/assets/admin-auth.js"), "utf8")
  ]);

  assert.match(script, /apiRequest\("\/api\/auth\/providers"\)/);
  assert.match(script, /apiRequest\("\/api\/auth\/login"/);
  assert.match(script, /adminAuth\.setSession\(session\)/);
  assert.match(script, /identity\?\.username \?\? identity\?\.githubUsername/);
  assert.doesNotMatch(script, /console\.(?:log|info|warn|error)\([^)]*password/i);
  assert.match(authScript, /"X-CSRF-Token": sessionState\.csrfToken/);
});

test("local identities can rotate their password with CSRF", async () => {
  const [html, script] = await Promise.all([
    readFile(resolve(projectRoot, "frontend/admin/index.html"), "utf8"),
    readFile(resolve(projectRoot, "frontend/assets/admin.js"), "utf8")
  ]);

  assert.match(html, /id="password-form-toggle"/);
  assert.match(html, /id="current-password"[\s\S]*autocomplete="current-password"/);
  assert.match(html, /id="new-password"[\s\S]*autocomplete="new-password"/);
  assert.match(html, /id="confirm-password"[\s\S]*autocomplete="new-password"/);
  assert.match(script, /authMethods\?\.includes\("local"\)/);
  assert.match(script, /apiRequest\("\/api\/admin\/account\/password"/);
  assert.match(script, /adminAuth\.requestHeaders\(\{ mutation: true \}\)/);
  assert.match(script, /adminAuth\.setSession\(session\)/);
  assert.match(script, /clearPasswordFields\(\)/);
});
