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

export async function apiRequest(path, options = {}) {
  let response;
  const { headers = {}, ...requestOptions } = options;

  try {
    response = await fetch(apiUrl(path), {
      credentials: "include",
      ...requestOptions,
      headers: {
        Accept: "application/json",
        ...headers
      }
    });
  } catch {
    throw new ApiClientError("無法連線到服務，請檢查網路後再試。");
  }

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
    throw new ApiClientError(payload.error?.message ?? "請求失敗。", {
      status: response.status,
      code: payload.error?.code ?? "REQUEST_FAILED",
      details: payload.error?.details
    });
  }

  return payload.data;
}
