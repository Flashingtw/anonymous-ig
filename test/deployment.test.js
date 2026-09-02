import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { buildPages } from "../scripts/build-pages.js";
import {
  ownerInsertSql,
  ownerVerifySql
} from "../scripts/bootstrap-owner.js";

const projectRoot = resolve(import.meta.dirname, "..");

test("Pages build contains frontend only and injects one production API origin", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "anonymous-pages-"));
  const outputDirectory = join(temporaryRoot, "artifact");
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  await buildPages({
    apiBaseUrl: "https://api.example.com",
    siteUrl: "https://app.example.com/",
    sourceDirectory: join(projectRoot, "frontend"),
    outputDirectory
  });

  const config = await readFile(join(outputDirectory, "config.js"), "utf8");
  assert.match(config, /API_BASE_URL: "https:\/\/api\.example\.com"/);
  assert.doesNotMatch(config, /GITHUB_CLIENT_SECRET|SESSION_SECRET|DEV_ADMIN_TOKEN/);

  for (const relativePath of ["index.html", "admin/index.html"]) {
    const html = await readFile(join(outputDirectory, relativePath), "utf8");
    assert.match(html, /connect-src 'self' https:\/\/api\.example\.com;/);
    assert.doesNotMatch(html, /connect-src[^;]*\shttps:;/);
    assert.match(html, /object-src 'none'/);
  }

  const content = JSON.parse(await readFile(
    join(outputDirectory, "content.json"),
    "utf8"
  ));
  assert.equal(content.social.image, "https://app.example.com/og.png");
  await assert.rejects(
    () => readFile(join(outputDirectory, "worker/src/index.js"), "utf8"),
    /ENOENT/
  );
  await assert.rejects(
    () => readFile(join(outputDirectory, "migrations/0001_create_submissions.sql"), "utf8"),
    /ENOENT/
  );
});

test("Pages production URL validation rejects HTTP and API paths", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "anonymous-pages-invalid-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  await assert.rejects(() => buildPages({
    apiBaseUrl: "http://api.example.com",
    siteUrl: "https://app.example.com/",
    sourceDirectory: join(projectRoot, "frontend"),
    outputDirectory: join(temporaryRoot, "http")
  }), /public HTTPS URL/);
  await assert.rejects(() => buildPages({
    apiBaseUrl: "https://api.example.com/path",
    siteUrl: "https://app.example.com/",
    sourceDirectory: join(projectRoot, "frontend"),
    outputDirectory: join(temporaryRoot, "path")
  }), /origin without a path/);
});

test("owner bootstrap SQL uses numeric identity and a plain enabled owner insert", () => {
  const insert = ownerInsertSql({
    githubUserId: "12345678",
    githubUsername: "display-name"
  });
  assert.match(insert, /github_user_id/);
  assert.match(insert, /'12345678'/);
  assert.match(insert, /'display-name'/);
  assert.match(insert, /'owner', 1/);
  assert.doesNotMatch(insert, /REPLACE|OR\s+REPLACE/i);
  assert.match(ownerVerifySql("12345678"), /WHERE github_user_id = '12345678'/);
});

test("frontend fetches include credentials and source CSP has no HTTPS wildcard", async () => {
  const apiClient = await readFile(join(projectRoot, "frontend/assets/api.js"), "utf8");
  const publicHtml = await readFile(join(projectRoot, "frontend/index.html"), "utf8");
  const adminHtml = await readFile(join(projectRoot, "frontend/admin/index.html"), "utf8");
  assert.match(apiClient, /credentials:\s*"include"/);
  assert.doesNotMatch(publicHtml, /connect-src[^;]*\shttps:;/);
  assert.doesNotMatch(adminHtml, /connect-src[^;]*\shttps:;/);
});

test("Pages workflow deploys only the generated frontend artifact", async () => {
  const workflow = await readFile(
    join(projectRoot, ".github/workflows/deploy-pages.yml"),
    "utf8"
  );
  const localConfig = await readFile(
    join(projectRoot, "frontend/config.js"),
    "utf8"
  );

  assert.match(workflow, /push:\s*\n\s*branches:\s*\n\s*- main/);
  assert.match(workflow, /path: \.pages-dist/);
  assert.match(workflow, /PAGES_API_BASE_URL: \$\{\{ vars\.PAGES_API_BASE_URL \}\}/);
  assert.doesNotMatch(workflow, /GITHUB_CLIENT_SECRET|SESSION_SECRET|wrangler deploy/);
  assert.match(localConfig, /API_BASE_URL:\s*""/);
});
