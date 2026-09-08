import { verifyAdminCsrf } from "../auth.js";
import { HttpError } from "../errors.js";
import { jsonResponse } from "../http.js";
import { RenderError } from "../rendering/errors.js";
import { classicCanvaTemplate } from "../rendering/templates/classic-canva.js";
import {
  beginSubmissionRender,
  completeSubmissionRender,
  failSubmissionRender,
  findReadySubmissionPreview
} from "../repositories/submissions.js";
import { resolveImageStorage } from "../storage/image-storage.js";
import { parsePositiveInteger } from "../validation.js";

const MAX_RENDERED_IMAGE_BYTES = 16 * 1024 * 1024;
const SAFE_RENDER_ERROR_CODES = new Set([
  "CONTENT_TOO_LONG_TO_RENDER",
  "RENDER_FONT_ASSET_MISSING",
  "RENDER_BACKGROUND_ASSET_MISSING",
  "RENDER_UNSUPPORTED_GLYPH",
  "IMAGE_STORAGE_NOT_CONFIGURED",
  "RENDERER_NOT_CONFIGURED"
]);

function auditEntry(principal, action, submissionId, renderVersion) {
  if (principal.provider === "dev") {
    return null;
  }
  return {
    adminId: principal.adminId,
    action,
    submissionId,
    metadata: {
      template_id: classicCanvaTemplate.id,
      renderer_version: classicCanvaTemplate.rendererVersion,
      render_version: renderVersion
    }
  };
}

function renderMethod(renderer) {
  if (typeof renderer === "function") {
    return renderer;
  }
  if (typeof renderer?.render === "function") {
    return renderer.render.bind(renderer);
  }
  throw new RenderError(
    "RENDERER_NOT_CONFIGURED",
    "貼文圖片 renderer 尚未設定。"
  );
}

function normalizeRenderedImage(result) {
  const value = result?.bytes ?? result;
  const bytes = value instanceof Uint8Array
    ? value
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : null;
  const contentType = result?.contentType ?? "image/png";

  if (
    !bytes?.byteLength
    || bytes.byteLength > MAX_RENDERED_IMAGE_BYTES
    || contentType !== "image/png"
  ) {
    throw new RenderError("RENDER_FAILED", "Renderer 回傳無效的圖片。");
  }

  return { bytes, contentType };
}

function renderFailureCode(error) {
  return error instanceof RenderError && SAFE_RENDER_ERROR_CODES.has(error.code)
    ? error.code
    : "RENDER_FAILED";
}

function publicRenderError(error, code) {
  if (code === "CONTENT_TOO_LONG_TO_RENDER") {
    return new HttpError(
      422,
      code,
      "投稿內容太長，無法產生貼文圖片。"
    );
  }
  if (new Set([
    "RENDER_FONT_ASSET_MISSING",
    "RENDER_BACKGROUND_ASSET_MISSING",
    "IMAGE_STORAGE_NOT_CONFIGURED",
    "RENDERER_NOT_CONFIGURED"
  ]).has(code)) {
    return new HttpError(503, code, "貼文圖片功能尚未設定完成。");
  }
  if (code === "RENDER_UNSUPPORTED_GLYPH") {
    return new HttpError(422, code, "投稿含有目前模板無法顯示的字元。");
  }
  return new HttpError(500, "RENDER_FAILED", "貼文圖片產生失敗，請稍後再試。");
}

function imageKey(submissionId, renderVersion) {
  return `submissions/${submissionId}/${classicCanvaTemplate.id}/v${renderVersion}.png`;
}

export async function renderSubmissionHandler(
  request,
  env,
  principal,
  rawId,
  dependencies = {}
) {
  await verifyAdminCsrf(request, principal, env);
  const id = parsePositiveInteger(rawId);
  let storage;
  let render;
  try {
    storage = resolveImageStorage(env, dependencies.imageStorage);
    render = renderMethod(dependencies.renderer);
  } catch (error) {
    const code = renderFailureCode(error);
    throw publicRenderError(error, code);
  }
  const started = await beginSubmissionRender(env.DB, id, {
    templateId: classicCanvaTemplate.id,
    rendererVersion: classicCanvaTemplate.rendererVersion
  });

  if (started.outcome === "not_found") {
    throw new HttpError(404, "SUBMISSION_NOT_FOUND", "找不到這篇投稿。");
  }
  if (started.outcome === "not_approved") {
    throw new HttpError(
      409,
      "SUBMISSION_NOT_APPROVED",
      "只有已核准的投稿可以產生貼文圖片。"
    );
  }
  if (started.outcome === "already_rendering") {
    throw new HttpError(
      409,
      "RENDER_ALREADY_IN_PROGRESS",
      "這篇投稿正在產生圖片。"
    );
  }

  const submission = started.submission;
  const renderVersion = submission.renderVersion;
  const nextImageKey = imageKey(id, renderVersion);
  const previousImageKey = submission.renderedImageKey;
  let stored = false;

  try {
    const image = normalizeRenderedImage(await render({
      id,
      content: submission.content,
      template: classicCanvaTemplate
    }));
    await storage.put(nextImageKey, image.bytes, {
      contentType: image.contentType
    });
    stored = true;

    const completion = await completeSubmissionRender(
      env.DB,
      id,
      renderVersion,
      {
        imageKey: nextImageKey,
        audit: auditEntry(
          principal,
          previousImageKey ? "regenerate_submission" : "render_submission",
          id,
          renderVersion
        )
      }
    );

    if (completion.outcome !== "updated") {
      await storage.delete(nextImageKey);
      throw new HttpError(
        409,
        "RENDER_STATE_CHANGED",
        "投稿狀態已變更，請重新整理。"
      );
    }

    if (previousImageKey && previousImageKey !== nextImageKey) {
      try {
        await storage.delete(previousImageKey);
      } catch {
        console.error("Old rendered image cleanup failed", JSON.stringify({
          submissionId: id,
          renderVersion
        }));
      }
    }

    return jsonResponse({
      ok: true,
      data: { submission: completion.submission }
    });
  } catch (error) {
    if (error instanceof HttpError && error.code === "RENDER_STATE_CHANGED") {
      throw error;
    }
    if (stored) {
      try {
        await storage.delete(nextImageKey);
      } catch {
        // The failed object is unreferenced; omit its key and error details.
      }
    }

    const code = renderFailureCode(error);
    await failSubmissionRender(env.DB, id, renderVersion, {
      errorCode: code,
      audit: auditEntry(principal, "render_failed", id, renderVersion)
    });
    throw publicRenderError(error, code);
  }
}

export async function previewSubmissionHandler(
  _request,
  env,
  _principal,
  rawId,
  dependencies = {}
) {
  const id = parsePositiveInteger(rawId);
  const result = await findReadySubmissionPreview(env.DB, id);
  if (result.outcome === "not_found") {
    throw new HttpError(404, "SUBMISSION_NOT_FOUND", "找不到這篇投稿。");
  }
  if (result.outcome !== "ready") {
    throw new HttpError(409, "PREVIEW_NOT_READY", "這篇投稿還沒有可預覽的圖片。");
  }

  const storage = resolveImageStorage(env, dependencies.imageStorage);
  const image = await storage.get(result.submission.renderedImageKey);
  if (!image) {
    throw new HttpError(404, "PREVIEW_NOT_FOUND", "找不到這張預覽圖片。");
  }

  return new Response(image.bytes, {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": "inline",
      "Content-Type": image.contentType === "image/jpeg" ? "image/jpeg" : "image/png",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
