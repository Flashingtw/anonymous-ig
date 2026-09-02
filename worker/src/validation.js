import { HttpError } from "./errors.js";

export const MAX_CONTENT_LENGTH = 1000;
export const MAX_REQUEST_BYTES = 16 * 1024;

function contentLength(value) {
  return Array.from(value).length;
}

export function validateSubmissionContent(value) {
  if (typeof value !== "string") {
    throw new HttpError(400, "INVALID_CONTENT", "投稿內容必須是文字。")
  }

  const content = value.trim();
  if (!content) {
    throw new HttpError(400, "EMPTY_CONTENT", "請輸入投稿內容。")
  }

  const length = contentLength(content);
  if (length > MAX_CONTENT_LENGTH) {
    throw new HttpError(
      400,
      "CONTENT_TOO_LONG",
      `投稿內容最多 ${MAX_CONTENT_LENGTH} 字。`,
      { maxLength: MAX_CONTENT_LENGTH, actualLength: length }
    );
  }

  return content;
}

async function readTextWithLimit(request, maxBytes) {
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "請求內容過大。")
  }

  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "請求內容過大。")
    }

    text += decoder.decode(value, { stream: true });
  }

  return text + decoder.decode();
}

export async function parseJsonBody(request) {
  const contentType = request.headers.get("Content-Type") ?? "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new HttpError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "請使用 application/json 格式送出。"
    );
  }

  const rawBody = await readTextWithLimit(request, MAX_REQUEST_BYTES);
  let value;

  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new HttpError(400, "INVALID_JSON", "JSON 格式不正確。")
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_BODY", "請求內容格式不正確。")
  }

  const allowedKeys = new Set(["content", "captchaToken"]);
  const unexpectedKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpectedKeys.length > 0) {
    throw new HttpError(400, "UNEXPECTED_FIELDS", "請求包含不支援的欄位。")
  }

  return value;
}

export function parsePositiveInteger(value, label = "ID") {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new HttpError(400, "INVALID_ID", `${label} 必須是正整數。`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new HttpError(400, "INVALID_ID", `${label} 超出允許範圍。`);
  }

  return parsed;
}

export function parseLimit(value, { defaultValue = 50, max = 100 } = {}) {
  if (value === null || value === "") {
    return defaultValue;
  }

  const parsed = parsePositiveInteger(value, "limit");
  return Math.min(parsed, max);
}

export const __testables = Object.freeze({ contentLength, readTextWithLimit });
