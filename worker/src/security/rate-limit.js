import { HttpError } from "../errors.js";

async function hashKey(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function enforceSubmissionRateLimit(request, env) {
  if (env.RATE_LIMITING_ENABLED !== "true") {
    return;
  }

  if (!env.SUBMISSION_RATE_LIMITER?.limit) {
    throw new HttpError(
      503,
      "RATE_LIMIT_NOT_CONFIGURED",
      "投稿防護服務尚未設定完成。"
    );
  }

  const clientAddress = request.headers.get("CF-Connecting-IP")
    ?? (env.APP_ENV === "development" ? "local-development" : "");

  if (!clientAddress) {
    throw new HttpError(503, "CLIENT_ADDRESS_UNAVAILABLE", "無法驗證投稿來源。")
  }

  const result = await env.SUBMISSION_RATE_LIMITER.limit({ key: await hashKey(clientAddress) });
  if (!result.success) {
    const retryAfter = String(Number(env.RATE_LIMIT_RETRY_AFTER_SECONDS) || 60);
    throw new HttpError(429, "RATE_LIMITED", "送出得太頻繁了，請稍後再試。", undefined, {
      "Retry-After": retryAfter
    });
  }
}
