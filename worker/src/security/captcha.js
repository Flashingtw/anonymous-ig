import { HttpError } from "../errors.js";

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

async function verifyTurnstile(token, request, env) {
  const secret = env.CAPTCHA_SECRET?.trim();
  if (!secret) {
    throw new HttpError(
      503,
      "CAPTCHA_NOT_CONFIGURED",
      "CAPTCHA 尚未設定完成。"
    );
  }

  if (typeof token !== "string" || !token.trim()) {
    throw new HttpError(400, "CAPTCHA_REQUIRED", "請完成 CAPTCHA 驗證。")
  }

  const body = new FormData();
  body.set("secret", secret);
  body.set("response", token.trim());

  const clientAddress = request.headers.get("CF-Connecting-IP");
  if (clientAddress) {
    body.set("remoteip", clientAddress);
  }

  let response;
  try {
    response = await fetch(TURNSTILE_VERIFY_URL, { method: "POST", body });
  } catch {
    throw new HttpError(503, "CAPTCHA_UNAVAILABLE", "CAPTCHA 服務暫時無法使用。")
  }

  if (!response.ok) {
    throw new HttpError(503, "CAPTCHA_UNAVAILABLE", "CAPTCHA 服務暫時無法使用。")
  }

  const result = await response.json();
  if (!result.success) {
    throw new HttpError(400, "CAPTCHA_FAILED", "CAPTCHA 驗證失敗，請再試一次。")
  }
}

export async function verifySubmissionCaptcha(token, request, env) {
  if (env.CAPTCHA_ENABLED !== "true") {
    return;
  }

  const provider = env.CAPTCHA_PROVIDER?.trim().toLowerCase() || "turnstile";
  if (provider !== "turnstile") {
    throw new HttpError(503, "CAPTCHA_NOT_CONFIGURED", "不支援指定的 CAPTCHA 服務。")
  }

  await verifyTurnstile(token, request, env);
}
