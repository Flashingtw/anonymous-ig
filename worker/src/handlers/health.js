import { HttpError } from "../errors.js";
import { jsonResponse } from "../http.js";

export async function healthHandler(env) {
  try {
    const databaseReady = await env.DB.prepare("SELECT 1 AS ok").first("ok");
    if (databaseReady !== 1) {
      throw new Error("Unexpected health query result");
    }
  } catch {
    throw new HttpError(
      503,
      "SERVICE_UNAVAILABLE",
      "服務暫時無法使用，請稍後再試。"
    );
  }

  return jsonResponse({ ok: true });
}
