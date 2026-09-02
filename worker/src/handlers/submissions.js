import { HttpError } from "../errors.js";
import { verifyAdminCsrf } from "../auth.js";
import { jsonResponse } from "../http.js";
import {
  createSubmission,
  listPendingSubmissions,
  updatePendingSubmissionStatus,
  updatePendingSubmissionStatusWithAudit
} from "../repositories/submissions.js";
import { verifySubmissionCaptcha } from "../security/captcha.js";
import { enforceSubmissionRateLimit } from "../security/rate-limit.js";
import {
  parseJsonBody,
  parseLimit,
  parsePositiveInteger,
  validateSubmissionContent
} from "../validation.js";

export async function createSubmissionHandler(request, env) {
  await enforceSubmissionRateLimit(request, env);

  const body = await parseJsonBody(request);
  const content = validateSubmissionContent(body.content);
  await verifySubmissionCaptcha(body.captchaToken, request, env);

  const submission = await createSubmission(env.DB, content);

  return jsonResponse(
    {
      ok: true,
      data: {
        submission: {
          id: submission.id,
          status: submission.status,
          createdAt: submission.createdAt
        }
      }
    },
    { status: 201 }
  );
}

export async function listPendingSubmissionsHandler(request, env) {
  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get("limit"));
  const submissions = await listPendingSubmissions(env.DB, limit);

  return jsonResponse({
    ok: true,
    data: {
      submissions,
      meta: { count: submissions.length, limit }
    }
  });
}

export async function moderateSubmissionHandler(
  request,
  env,
  principal,
  rawId,
  action
) {
  await verifyAdminCsrf(request, principal, env);
  const id = parsePositiveInteger(rawId);
  const nextStatus = action === "approve" ? "approved" : "rejected";
  const auditAction = action === "approve"
    ? "approve_submission"
    : "reject_submission";
  const result = principal.provider === "github"
    ? await updatePendingSubmissionStatusWithAudit(env.DB, id, nextStatus, {
      adminId: principal.adminId,
      action: auditAction,
      submissionId: id,
      metadata: { next_status: nextStatus }
    })
    : await updatePendingSubmissionStatus(env.DB, id, nextStatus);

  if (result.outcome === "not_found") {
    throw new HttpError(404, "SUBMISSION_NOT_FOUND", "找不到這篇投稿。");
  }

  if (result.outcome === "conflict") {
    throw new HttpError(
      409,
      "SUBMISSION_ALREADY_REVIEWED",
      "這篇投稿已經處理過。",
      { currentStatus: result.submission.status }
    );
  }

  return jsonResponse({ ok: true, data: { submission: result.submission } });
}
