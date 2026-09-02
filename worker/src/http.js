import { HttpError } from "./errors.js";

const API_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff"
});

const RESPONSE_SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff"
});

const ALLOWED_CORS_METHODS = new Set(["GET", "POST", "OPTIONS"]);
const ALLOWED_CORS_HEADERS = new Set([
  "authorization",
  "content-type",
  "x-csrf-token"
]);

export function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...API_HEADERS, ...headers }
  });
}

export function errorResponse(error, { exposeInternalDetails = true } = {}) {
  const safeError = error instanceof HttpError
    ? error
    : new HttpError(500, "INTERNAL_ERROR", "服務暫時發生錯誤，請稍後再試。");

  const exposeServerError = safeError.status < 500 || exposeInternalDetails;
  const payload = {
    ok: false,
    error: {
      code: safeError.code,
      message: exposeServerError
        ? safeError.message
        : "服務暫時發生錯誤，請稍後再試。"
    }
  };

  if (
    safeError.details !== undefined
    && exposeServerError
  ) {
    payload.error.details = safeError.details;
  }

  return jsonResponse(payload, {
    status: safeError.status,
    headers: safeError.headers
  });
}

export function methodNotAllowed(methods) {
  return errorResponse(
    new HttpError(405, "METHOD_NOT_ALLOWED", "不支援此請求方式。", undefined, {
      Allow: methods.join(", ")
    })
  );
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function normalizeConfiguredOrigin(value, env) {
  const candidate = value.trim();
  if (!candidate || candidate === "*" || candidate === "null") {
    return null;
  }

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (
    url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    return null;
  }

  const isLoopback = LOOPBACK_HOSTS.has(url.hostname);
  if (isLoopback) {
    const localDevelopmentOrigin = env.APP_ENV === "development"
      && new Set(["http:", "https:"]).has(url.protocol);
    return localDevelopmentOrigin ? url.origin : null;
  }

  return url.protocol === "https:" ? url.origin : null;
}

function parseAllowedOrigins(env) {
  const configured = new Set(
    (env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => normalizeConfiguredOrigin(origin, env))
      .filter(Boolean)
  );

  if (env.APP_ENV !== "production") {
    return configured;
  }

  const frontendOrigin = normalizeConfiguredOrigin(env.FRONTEND_URL ?? "", env);
  return frontendOrigin && configured.has(frontendOrigin)
    ? new Set([frontendOrigin])
    : new Set();
}

function parseRequestOrigin(value) {
  if (!value || value === "null") {
    return null;
  }

  try {
    const url = new URL(value);
    return url.origin === value ? url.origin : null;
  } catch {
    return null;
  }
}

export function corsDecision(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) {
    return { allowed: true, origin: null };
  }

  if (origin === "null") {
    return { allowed: false, origin: null };
  }

  const requestOrigin = new URL(request.url).origin;
  const normalizedOrigin = parseRequestOrigin(origin);
  if (!normalizedOrigin) {
    return { allowed: false, origin: null };
  }

  const allowedOrigins = parseAllowedOrigins(env);
  const allowed = normalizedOrigin === requestOrigin
    || allowedOrigins.has(normalizedOrigin);

  return { allowed, origin: allowed ? normalizedOrigin : null };
}

export function handlePreflight(request) {
  const requestedMethod = request.headers.get("Access-Control-Request-Method")?.toUpperCase();
  const requestedHeaders = (request.headers.get("Access-Control-Request-Headers") ?? "")
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);

  if (!requestedMethod || !ALLOWED_CORS_METHODS.has(requestedMethod)) {
    return errorResponse(
      new HttpError(403, "CORS_METHOD_NOT_ALLOWED", "跨來源請求方式不允許。")
    );
  }

  if (requestedHeaders.some((header) => !ALLOWED_CORS_HEADERS.has(header))) {
    return errorResponse(
      new HttpError(403, "CORS_HEADERS_NOT_ALLOWED", "跨來源請求標頭不允許。")
    );
  }

  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-CSRF-Token",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Max-Age": "86400",
      "Cache-Control": "no-store"
    }
  });
}

export function applyCorsHeaders(response, origin) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(RESPONSE_SECURITY_HEADERS)) {
    if (!headers.has(name)) {
      headers.set(name, value);
    }
  }

  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.append("Vary", "Origin");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export const __testables = Object.freeze({
  normalizeConfiguredOrigin,
  parseAllowedOrigins,
  parseRequestOrigin
});
