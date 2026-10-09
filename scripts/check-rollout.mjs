import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

// A fixed production baseline, never the moving origin/main or source branch.
const baseline = "a5888345f8a1658c704237452d58111e4dec3f41";
const studioBaseline = "8ecfc805472a0c14e6b435d8aa584bca2b001d9c";
const root = resolve(import.meta.dirname, "..");
const git = (...args) => execFileSync("git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, ...args], {
  cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024
});
const original = (path) => git("show", `${baseline}:${path}`);
const normalized = (text) => text.replaceAll("\r\n", "\n");
const unchanged = [
  "frontend/assets/api.js",
  "frontend/og-editable.svg",
  "migrations/0001_create_submissions.sql", "migrations/0002_create_admin_auth.sql"
];
for (const path of unchanged) {
  assert.equal(normalized(await readFile(join(root, path), "utf8")), normalized(original(path)), `${path} must remain at production baseline`);
}
// Approved UI finalization replaces the old app.js byte-for-byte freeze.
// Keep API transport/storage frozen; assert the new shared submission contract.
const { MAX_CONTENT_LENGTH, contentLength } = await import("../frontend/assets/submission-content.js");
const { validateSubmissionContent } = await import("../worker/src/validation.js");
assert.equal(MAX_CONTENT_LENGTH, 100);
assert.equal(contentLength("👨‍👩‍👧‍👦e\u0301"), 2);
assert.equal(validateSubmissionContent("字".repeat(100)), "字".repeat(100));
assert.throws(() => validateSubmissionContent("字".repeat(101)), error => error.code === "CONTENT_TOO_LONG");
assert.match(await readFile(join(root, "frontend/assets/app.js"), "utf8"), /import \{ MAX_CONTENT_LENGTH, contentLength \} from "\.\/submission-content\.js"/);
const migrations = (await readdir(join(root, "migrations"))).filter((name) => !name.startsWith("._")).sort();
const priorMigrations = ["0001_create_submissions.sql", "0002_create_admin_auth.sql", "0004_add_local_admin_auth.sql", "0005_add_access_email.sql", "0006_access_only_admins.sql", "0007_image_drafts.sql", "0008_single_dispatch.sql", "0009_studio_removals.sql"];
const newMigrations = ["0010_instagram_publish_queue.sql", "0011_multiple_send_batches.sql", "0012_automatic_locked_batches.sql", "0013_instagram_preparation.sql", "0014_instagram_caption_edits.sql", "0015_send_layout_repairs.sql"];
assert.deepEqual(migrations, [...priorMigrations, ...newMigrations]);
for (const name of priorMigrations) assert.equal(normalized(await readFile(join(root, 'migrations', name), 'utf8')), normalized(git('show', `${studioBaseline}:migrations/${name}`)), `${name} must remain unchanged`);
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
assert.match(config, /"IG_PUBLISH_ENABLED": "false"/);
assert.doesNotMatch(config, /"crons"\s*:/, 'production Cron requires a separate rollout approval');
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
assert.deepEqual(manifest.dependencies ?? {}, { jose: "6.2.12" }, "only the reviewed JWT dependency may ship");
assert.doesNotMatch(await readFile(join(root, "package-lock.json"), "utf8"), /@resvg|opentype/);
// Pagination is approved: verify its observable behavior instead of freezing its source.
const pagination = spawnSync(process.execPath, ['--test', 'test/submission-pagination.test.js'], {cwd:root, stdio:'inherit', timeout:60_000});
if (pagination.error) throw pagination.error;
assert.equal(pagination.status, 0, 'pagination must retain all submissions');
console.log("Rollout boundary passed: transport retained, 100-grapheme limit, prior migrations frozen, IG disabled.");

// Replay unmodified production tests against unmodified production Worker code,
// changing only the D1 fixture to apply the candidate's 0015 schema.
// CI must fetch history so the pinned baseline is available. No remote calls.
// Under the checkout so the recent Worker's jose import resolves locked dependencies.
const scratch = join(root, 'tmp');
await mkdir(scratch, {recursive:true});
for (const replayBaseline of [baseline, studioBaseline]) {
const temporaryRoot = await mkdtemp(join(scratch, "anonymous-legacy-schema-"));
try {
  const workerPaths = git("ls-tree", "-r", "--name-only", replayBaseline, "worker/src", "scripts", "test/helpers", "frontend").trim().split(/\r?\n/).filter(path=>/\.(?:js|mjs)$/.test(path));
  const testPaths = ["test/oauth.test.js", "test/security.test.js", "test/validation.test.js"];
  for (const path of [...workerPaths, ...testPaths]) {
    await mkdir(dirname(join(temporaryRoot, path)), { recursive: true });
    await writeFile(join(temporaryRoot, path), git('show', `${replayBaseline}:${path}`));
  }
  for (const path of ["test/helpers/d1.js", ...migrations.map((name) => `migrations/${name}`)]) {
    await mkdir(dirname(join(temporaryRoot, path)), { recursive: true });
    const contents = normalized(await readFile(join(root, path), 'utf8'));
    const upgraded = contents.replace('images = false', 'images = true').replace('singleSend = false', 'singleSend = true').replace('studioDelete = false', 'studioDelete = true').replace('  return {\n    DB:', `  for (const name of ${JSON.stringify(newMigrations)}) database.exec(readFileSync(new URL('../../migrations/' + name, import.meta.url), 'utf8'));\n  return {\n    DB:`);
    await writeFile(join(temporaryRoot, path), path === 'test/helpers/d1.js' ? upgraded : contents);
  }
  await writeFile(join(temporaryRoot, "package.json"), '{"type":"module"}');
  for (const [label, directory] of [["production baseline", temporaryRoot], ["rollout candidate", root]]) {
    const { handleApiRequest } = await import(pathToFileURL(join(directory, "worker/src/index.js")));
    const { createTestDatabase } = await import(pathToFileURL(join(directory, "test/helpers/d1.js")));
    const database = createTestDatabase({images:true,singleSend:true,studioDelete:true});
    try {
      if (directory === root) for (const name of newMigrations) database.raw.exec(await readFile(join(root, 'migrations', name), 'utf8'));
      assert.ok(database.raw.prepare('PRAGMA table_info(send_batches)').all().some(column=>column.name==='auto_publish'), 'compatibility fixture must actually apply 0012');
      assert.ok(database.raw.prepare('PRAGMA table_info(instagram_queue)').all().some(column=>column.name==='preparation_status'), 'compatibility fixture must actually apply 0013');
      assert.ok(database.raw.prepare('PRAGMA table_info(instagram_caption_edits)').all().some(column=>column.name==='before_caption'), 'compatibility fixture must actually apply 0014');
      assert.ok(database.raw.prepare('PRAGMA table_info(send_layout_repairs)').all().some(column=>column.name==='before_layout'), 'compatibility fixture must actually apply 0015');
      assert.deepEqual(database.raw.prepare('PRAGMA foreign_key_check').all(), []);
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
      console.log(`${label}: public submission on schema 0015 passed.`);
    } finally {
      database.close();
    }
  }
  console.log(`Replaying baseline ${replayBaseline} OAuth, moderation, logout and security tests on schema 0015.`);
  const result = spawnSync(process.execPath, ["--test", ...testPaths], {
    cwd: temporaryRoot, stdio: "inherit", timeout: 60_000
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, "production Worker must remain compatible after schema-only upgrade");
} finally {
  // Only the exact directory created by mkdtemp is eligible for cleanup.
  assert.ok(resolve(temporaryRoot).startsWith(resolve(scratch) + sep + "anonymous-legacy-schema-"));
  await rm(temporaryRoot, { recursive: true, force: true });
}
}
