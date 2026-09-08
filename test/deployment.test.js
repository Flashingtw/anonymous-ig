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
    apiBaseUrl: "https://anonymous-api.example.workers.dev",
    siteUrl: "https://flashingtw.github.io/anonymous-ig/",
    sourceDirectory: join(projectRoot, "frontend"),
    outputDirectory
  });

  const config = await readFile(join(outputDirectory, "config.js"), "utf8");
  assert.match(config, /API_BASE_URL: "https:\/\/anonymous-api\.example\.workers\.dev"/);
  assert.doesNotMatch(config, /GITHUB_CLIENT_SECRET|SESSION_SECRET|DEV_ADMIN_TOKEN/);

  const publicHtml = await readFile(join(outputDirectory, "index.html"), "utf8");
  assert.match(publicHtml, /connect-src 'self' https:\/\/anonymous-api\.example\.workers\.dev;/);
  assert.doesNotMatch(publicHtml, /connect-src[^;]*\shttps:;/);
  assert.match(publicHtml, /object-src 'none'/);

  const adminHandoff = await readFile(
    join(outputDirectory, "admin/index.html"),
    "utf8"
  );
  assert.match(adminHandoff, /https:\/\/anonymous-api\.example\.workers\.dev\/admin\//);
  assert.doesNotMatch(adminHandoff, /admin\.js|config\.js|api\/auth/);
  await assert.rejects(
    () => readFile(join(outputDirectory, "assets/admin.js"), "utf8"),
    /ENOENT/
  );
  await assert.rejects(
    () => readFile(join(outputDirectory, "assets/admin-auth.js"), "utf8"),
    /ENOENT/
  );

  const content = JSON.parse(await readFile(
    join(outputDirectory, "content.json"),
    "utf8"
  ));
  assert.equal(
    content.social.image,
    "https://flashingtw.github.io/anonymous-ig/og.png"
  );
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
  const publicClient = await readFile(join(projectRoot, "frontend/assets/app.js"), "utf8");
  const publicHtml = await readFile(join(projectRoot, "frontend/index.html"), "utf8");
  const adminHtml = await readFile(join(projectRoot, "frontend/admin/index.html"), "utf8");
  assert.match(apiClient, /credentials:\s*"include"/);
  assert.match(publicClient, /credentials:\s*"omit"/);
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

test("production Worker serves same-origin admin assets on workers.dev", async () => {
  const workerConfig = await readFile(join(projectRoot, "wrangler.jsonc"), "utf8");
  assert.match(workerConfig, /"workers_dev": true/);
  assert.match(workerConfig, /"preview_urls": false/);
  assert.match(workerConfig, /"directory": "\.\/frontend"/);
  assert.match(workerConfig, /"binding": "ASSETS"/);
  assert.match(workerConfig, /"run_worker_first": true/);
  assert.match(workerConfig, /"ADMIN_AUTH_PROVIDERS": "github,local"/);
  assert.match(workerConfig, /"LOCAL_AUTH_ENABLED": "false"/);
  assert.match(workerConfig, /"LOGIN_RATE_LIMIT_MAX_ATTEMPTS": "5"/);
  assert.match(workerConfig, /"PUBLIC_SITE_URL": "https:\/\/flashingtw\.github\.io\/anonymous-ig\/"/);
  assert.match(workerConfig, /"ALLOWED_ORIGINS": "https:\/\/flashingtw\.github\.io"/);
});
