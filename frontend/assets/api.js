export class ApiClientError extends Error {
  constructor(message, { status = 0, code = "NETWORK_ERROR", details } = {}) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function apiUrl(path) {
  const baseUrl = window.APP_CONFIG?.API_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
  return `${baseUrl}${path}`;
}

async function request(path, options, accept) {
  const { headers = {}, ...requestOptions } = options;
  try {
    return await fetch(apiUrl(path), {
      credentials: "include",
      ...requestOptions,
      headers: { Accept: accept, ...headers }
    });
  } catch {
    throw new ApiClientError("無法連線到服務，請檢查網路後再試。");
  }
}

async function responseError(response) {
  const payload = await response.json().catch(() => null);
  return new ApiClientError(payload?.error?.message ?? "請求失敗。", {
    status: response.status,
    code: payload?.error?.code ?? "REQUEST_FAILED",
    details: payload?.error?.details
  });
}

export async function apiRequest(path, options = {}) {
  const response = await request(path, options, "application/json");

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ApiClientError("服務回應格式不正確。", {
      status: response.status,
      code: "INVALID_RESPONSE"
    });
  }

  if (!response.ok || payload.ok !== true) {
    throw new ApiClientError(payload?.error?.message ?? "請求失敗。", {
      status: response.status,
      code: payload?.error?.code ?? "REQUEST_FAILED",
      details: payload?.error?.details
    });
  }

  return payload.data;
}

export async function apiBinaryRequest(path, options = {}) {
  const response = await request(path, options, "image/png,image/jpeg");
  if (!response.ok) {
    throw await responseError(response);
  }

  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0] ?? "";
  if (!new Set(["image/png", "image/jpeg"]).has(contentType)) {
    throw new ApiClientError("服務回應的圖片格式不正確。", {
      status: response.status,
      code: "INVALID_IMAGE_RESPONSE"
    });
  }

  return response.blob();
}
