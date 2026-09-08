import assert from "node:assert/strict";
import test from "node:test";

import { handleApiRequest } from "../worker/src/index.js";
import { RenderError } from "../worker/src/rendering/errors.js";
import { SESSION_COOKIE_NAME } from "../worker/src/security/cookies.js";
import { hmacBase64Url, sha256Hex } from "../worker/src/security/crypto.js";
import { MemoryImageStorage } from "../worker/src/storage/image-storage.js";
import { createTestDatabase } from "./helpers/d1.js";

const ORIGIN = "https://anonymous.example.workers.dev";
const SESSION_SECRET = "render-test-session-secret-is-long-enough";

async function authenticatedFixture(t, { status = "approved" } = {}) {
  const database = createTestDatabase();
  t.after(() => database.close());
  database.raw.prepare(`
    INSERT INTO admins (github_user_id, github_username, role, enabled)
    VALUES ('123456', 'render-admin', 'admin', 1)
  `).run();
  const adminId = Number(database.raw.prepare("SELECT id FROM admins").get().id);
  const sessionToken = "render-session-token-with-enough-entropy-123456";
  database.raw.prepare(`
    INSERT INTO admin_sessions (token_hash, admin_id, expires_at)
    VALUES (?, ?, '2099-01-01T00:00:00.000Z')
  `).run(await sha256Hex(sessionToken), adminId);
  const submissionId = Number(database.raw.prepare(`
    INSERT INTO submissions (content, status)
    VALUES ('測試投稿內容', ?)
    RETURNING id
  `).get(status).id);
  const csrfToken = await hmacBase64Url(SESSION_SECRET, `csrf:${sessionToken}`);
  const env = {
    APP_ENV: "production",
    ADMIN_AUTH_PROVIDER: "github",
    DB: database.DB,
    SESSION_SECRET
  };
  const headers = {
    Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
    "X-CSRF-Token": csrfToken
  };
  return { ...database, adminId, submissionId, env, headers };
}

async function json(response) {
  return response.json();
}

test("render and preview routes require an authenticated admin", async (t) => {
  const database = createTestDatabase();
  t.after(() => database.close());
  const storage = new MemoryImageStorage();
  let calls = 0;
  const env = {
    APP_ENV: "production",
    ADMIN_AUTH_PROVIDER: "github",
    DB: database.DB,
    SESSION_SECRET
  };

  for (const [method, path] of [
    ["POST", "/api/admin/submissions/1/render"],
    ["GET", "/api/admin/submissions/1/preview"]
  ]) {
    const response = await handleApiRequest(
      new Request(`${ORIGIN}${path}`, { method }),
      env,
      {
        imageStorage: storage,
        renderer: async () => {
          calls += 1;
          return new Uint8Array([1]);
        }
      }
    );
    assert.equal(response.status, 401);
  }
  assert.equal(calls, 0);
});

test("render requires CSRF and only accepts approved submissions", async (t) => {
  const fixture = await authenticatedFixture(t, { status: "pending" });
  const storage = new MemoryImageStorage();
  let calls = 0;
  const dependencies = {
    imageStorage: storage,
    renderer: async () => {
      calls += 1;
      return new Uint8Array([1]);
    }
  };

  const missingCsrf = await handleApiRequest(
    new Request(`${ORIGIN}/api/admin/submissions/${fixture.submissionId}/render`, {
      method: "POST",
      headers: { Cookie: fixture.headers.Cookie }
    }),
    fixture.env,
    dependencies
  );
  assert.equal(missingCsrf.status, 403);

  const pending = await handleApiRequest(
    new Request(`${ORIGIN}/api/admin/submissions/${fixture.submissionId}/render`, {
      method: "POST",
      headers: fixture.headers
    }),
    fixture.env,
    dependencies
  );
  assert.equal(pending.status, 409);
  assert.equal((await json(pending)).error.code, "SUBMISSION_NOT_APPROVED");
  assert.equal(calls, 0);
});

test("an unconfigured renderer returns a safe setup error without changing the submission", async (t) => {
  const fixture = await authenticatedFixture(t);
  const response = await handleApiRequest(
    new Request(`${ORIGIN}/api/admin/submissions/${fixture.submissionId}/render`, {
      method: "POST",
      headers: fixture.headers
    }),
    fixture.env,
    { imageStorage: new MemoryImageStorage() }
  );
  const payload = await json(response);

  assert.equal(response.status, 503);
  assert.equal(payload.error.code, "RENDERER_NOT_CONFIGURED");
  assert.equal(payload.error.message, "服務暫時發生錯誤，請稍後再試。");
  assert.deepEqual(
    { ...fixture.raw.prepare(`
      SELECT render_status, render_version, render_error
      FROM submissions
      WHERE id = ?
    `).get(fixture.submissionId) },
    { render_status: "not_rendered", render_version: 0, render_error: null }
  );
});

test("approved render, preview, regeneration, and audit form a safe flow", async (t) => {
  const fixture = await authenticatedFixture(t);
  const storage = new MemoryImageStorage();
  let renderCall = 0;
  const dependencies = {
    imageStorage: storage,
    renderer: async () => {
      renderCall += 1;
      return {
        bytes: new Uint8Array([137, 80, 78, 71, renderCall]),
        contentType: "image/png"
      };
    }
  };
  const renderUrl = `${ORIGIN}/api/admin/submissions/${fixture.submissionId}/render`;

  const first = await handleApiRequest(
    new Request(renderUrl, { method: "POST", headers: fixture.headers }),
    fixture.env,
    dependencies
  );
  assert.equal(first.status, 200);
  const firstPayload = await json(first);
  assert.equal(firstPayload.data.submission.renderStatus, "ready");
  assert.equal(firstPayload.data.submission.renderVersion, 1);
  assert.equal(firstPayload.data.submission.hasPreview, true);
  assert.equal("renderedImageKey" in firstPayload.data.submission, false);

  const preview = await handleApiRequest(
    new Request(`${ORIGIN}/api/admin/submissions/${fixture.submissionId}/preview`, {
      headers: { Cookie: fixture.headers.Cookie }
    }),
    fixture.env,
    dependencies
  );
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("Content-Type"), "image/png");
  assert.match(preview.headers.get("Cache-Control"), /no-store/);
  assert.deepEqual([...new Uint8Array(await preview.arrayBuffer())], [137, 80, 78, 71, 1]);

  const second = await handleApiRequest(
    new Request(renderUrl, { method: "POST", headers: fixture.headers }),
    fixture.env,
    dependencies
  );
  assert.equal(second.status, 200);
  assert.equal((await json(second)).data.submission.renderVersion, 2);
  assert.equal(
    await storage.get(`submissions/${fixture.submissionId}/classic-canva/v1.png`),
    null
  );
  assert.ok(await storage.get(`submissions/${fixture.submissionId}/classic-canva/v2.png`));

  const logs = fixture.raw.prepare(`
    SELECT action, metadata
    FROM audit_logs
    WHERE submission_id = ?
    ORDER BY id
  `).all(fixture.submissionId);
  assert.deepEqual(logs.map(({ action }) => action), [
    "render_submission",
    "regenerate_submission"
  ]);
  for (const log of logs) {
    assert.deepEqual(Object.keys(JSON.parse(log.metadata)).sort(), [
      "render_version",
      "renderer_version",
      "template_id"
    ]);
    assert.doesNotMatch(log.metadata, /測試投稿內容|submissions\//);
  }
});

test("too-long rendering records a safe failed status and audit", async (t) => {
  const fixture = await authenticatedFixture(t);
  const response = await handleApiRequest(
    new Request(`${ORIGIN}/api/admin/submissions/${fixture.submissionId}/render`, {
      method: "POST",
      headers: fixture.headers
    }),
    fixture.env,
    {
      imageStorage: new MemoryImageStorage(),
      renderer: async () => {
        throw new RenderError(
          "CONTENT_TOO_LONG_TO_RENDER",
          "private renderer details"
        );
      }
    }
  );
  const payload = await json(response);
  assert.equal(response.status, 422);
  assert.equal(payload.error.code, "CONTENT_TOO_LONG_TO_RENDER");
  assert.equal(payload.error.message, "投稿內容太長，無法產生貼文圖片。");

  const submission = fixture.raw.prepare(`
    SELECT render_status, render_error, rendered_image_key
    FROM submissions
    WHERE id = ?
  `).get(fixture.submissionId);
  assert.deepEqual({ ...submission }, {
    render_status: "failed",
    render_error: "CONTENT_TOO_LONG_TO_RENDER",
    rendered_image_key: null
  });
  const audit = fixture.raw.prepare(`
    SELECT action, metadata
    FROM audit_logs
    WHERE submission_id = ?
  `).get(fixture.submissionId);
  assert.equal(audit.action, "render_failed");
  assert.doesNotMatch(audit.metadata, /private renderer details|測試投稿內容/);
});

test("admin list filters by status and never exposes the storage key", async (t) => {
  const fixture = await authenticatedFixture(t);
  fixture.raw.prepare(`
    UPDATE submissions
    SET render_status = 'ready',
        rendered_image_key = 'private/key.png',
        rendered_at = '2026-09-04T00:00:00.000Z',
        template_id = 'classic-canva',
        renderer_version = 'classic-canva-v1',
        render_version = 1
    WHERE id = ?
  `).run(fixture.submissionId);

  const response = await handleApiRequest(
    new Request(`${ORIGIN}/api/admin/submissions?status=approved&limit=100`, {
      headers: { Cookie: fixture.headers.Cookie }
    }),
    fixture.env
  );
  const payload = await json(response);
  assert.equal(response.status, 200);
  assert.equal(payload.data.meta.status, "approved");
  assert.equal(payload.data.submissions.length, 1);
  assert.equal(payload.data.submissions[0].hasPreview, true);
  assert.equal("renderedImageKey" in payload.data.submissions[0], false);
  assert.doesNotMatch(JSON.stringify(payload), /private\/key\.png/);
});
