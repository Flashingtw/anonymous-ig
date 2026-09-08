import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

// A fixed production baseline, never the moving origin/main or source branch.
const baseline = "a5888345f8a1658c704237452d58111e4dec3f41";
const root = resolve(import.meta.dirname, "..");
const git = (...args) => execFileSync("git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, ...args], {
  cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024
});
const original = (path) => git("show", `${baseline}:${path}`);
const normalized = (text) => text.replaceAll("\r\n", "\n");
const unchanged = [
  "frontend/assets/app.js", "frontend/assets/api.js",
  "frontend/og-editable.svg", "worker/src/repositories/submissions.js",
  "migrations/0001_create_submissions.sql", "migrations/0002_create_admin_auth.sql"
];
for (const path of unchanged) {
  assert.equal(normalized(await readFile(join(root, path), "utf8")), normalized(original(path)), `${path} must remain at production baseline`);
}
const migrations = (await readdir(join(root, "migrations"))).filter((name) => !name.startsWith("._")).sort();
assert.deepEqual(migrations, ["0001_create_submissions.sql", "0002_create_admin_auth.sql", "0004_add_local_admin_auth.sql", "0005_add_access_email.sql", "0006_access_only_admins.sql"]);
assert.equal(normalized(await readFile(join(root, "migrations/0004_add_local_admin_auth.sql"), "utf8")), normalized(git("show", "98858477827a7076b0e43cde2ed7f9f252fe2076:migrations/0004_add_local_admin_auth.sql")), "0004 must remain unchanged");
const paths = git("ls-files", "--cached", "--others", "--exclude-standard").trim().split(/\r?\n/);
const forbidden = /(?:^|\/)(?:rendering|fonts|render-fixtures)(?:\/|\.)|0003|(?:^|\/)render[^/]*\.(?:js|mjs|json)$/i;
assert.deepEqual(paths.filter((path) => forbidden.test(path)), [], "no renderer, fonts or rendering schema may ship");
for (const path of ["worker/src/index.js", "frontend/assets/admin.js", "frontend/admin/index.html"]) {
  const source = await readFile(join(root, path), "utf8");
  assert.doesNotMatch(source, /handleRender|renderSubmissionImage|\/preview|\/render|render-panel|data-status-tab|queue-tabs/);
}
const config = await readFile(join(root, "wrangler.jsonc"), "utf8");
assert.doesNotMatch(config, /r2_buckets|RENDER/);
assert.match(config, /"LOCAL_AUTH_ENABLED": "false"/);
assert.match(config, /"ACCESS_AUTH_ENABLED": "false"/);
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
assert.deepEqual(manifest.dependencies ?? {}, { jose: "6.2.12" }, "only the reviewed JWT dependency may ship");
assert.doesNotMatch(await readFile(join(root, "package-lock.json"), "utf8"), /@resvg|opentype/);
console.log("Rollout boundary passed: public API retained; Phase 4.7 UI and migrations 0001+0002+0004+0005+0006.");

// Replay unmodified production tests against unmodified production Worker code,
// changing only the D1 fixture to apply the candidate's 0006 schema.
// CI must fetch history so the pinned baseline is available. No remote calls.
const temporaryRoot = await mkdtemp(join(tmpdir(), "anonymous-legacy-schema-"));
try {
  const workerPaths = git("ls-tree", "-r", "--name-only", baseline, "worker/src").trim().split(/\r?\n/);
  const testPaths = ["test/oauth.test.js", "test/security.test.js", "test/validation.test.js"];
  for (const path of [...workerPaths, ...testPaths]) {
    await mkdir(dirname(join(temporaryRoot, path)), { recursive: true });
    await writeFile(join(temporaryRoot, path), original(path));
  }
  for (const path of ["test/helpers/d1.js", ...migrations.map((name) => `migrations/${name}`)]) {
    await mkdir(dirname(join(temporaryRoot, path)), { recursive: true });
    await writeFile(join(temporaryRoot, path), await readFile(join(root, path)));
  }
  await writeFile(join(temporaryRoot, "package.json"), '{"type":"module"}');
  for (const [label, directory] of [["production baseline", temporaryRoot], ["rollout candidate", root]]) {
    const { handleApiRequest } = await import(pathToFileURL(join(directory, "worker/src/index.js")));
    const { createTestDatabase } = await import(pathToFileURL(join(directory, "test/helpers/d1.js")));
    const database = createTestDatabase();
    try {
      const response = await handleApiRequest(new Request("https://admin.example.test/api/submissions", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: "https://flashingtw.github.io" },
        body: JSON.stringify({ content: "Isolated schema compatibility probe" })
      }), {
        DB: database.DB, APP_ENV: "production", LOCAL_AUTH_ENABLED: "false",
        PUBLIC_SITE_URL: "https://flashingtw.github.io/anonymous-ig/",
        ALLOWED_ORIGINS: "https://flashingtw.github.io"
      });
      assert.equal(response.status, 201, `${label}: public submission remains available with local auth off`);
      const payload = await response.json();
      assert.equal(payload.data.submission.status, "pending");
      assert.equal(payload.data.submission.content, undefined);
      console.log(`${label}: public submission on schema 0006 passed.`);
    } finally {
      database.close();
    }
  }
  console.log(`Replaying production ${baseline} OAuth, moderation, logout and security tests on schema 0006.`);
  const result = spawnSync(process.execPath, ["--test", ...testPaths], {
    cwd: temporaryRoot, stdio: "inherit", timeout: 60_000
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, "production Worker must remain compatible after schema-only upgrade");
} finally {
  // Only the exact directory created by mkdtemp is eligible for cleanup.
  assert.ok(resolve(temporaryRoot).startsWith(resolve(tmpdir()) + sep + "anonymous-legacy-schema-"));
  await rm(temporaryRoot, { recursive: true, force: true });
}
