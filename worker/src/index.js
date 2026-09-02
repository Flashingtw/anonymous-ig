import { authenticateAdmin, authorizeAdmin } from "./auth.js";
import { HttpError } from "./errors.js";
import {
  applyCorsHeaders,
  corsDecision,
  errorResponse,
  handlePreflight,
  jsonResponse,
  methodNotAllowed
} from "./http.js";
import {
  createSubmissionHandler,
  listPendingSubmissionsHandler,
  moderateSubmissionHandler
} from "./handlers/submissions.js";
import {
  authMeHandler,
  githubCallbackHandler,
  githubLoginHandler,
  logoutHandler
} from "./handlers/auth.js";
import { healthHandler } from "./handlers/health.js";

export async function routeApi(request, env, dependencies = {}) {
  const url = new URL(request.url);
  const pathname = url.pathname.length > 1
    ? url.pathname.replace(/\/+$/, "")
    : url.pathname;

  if (pathname === "/api/health") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }

    return healthHandler(env);
  }

  if (pathname === "/api/auth/github") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }

    return githubLoginHandler(request, env);
  }

  if (pathname === "/api/auth/github/callback") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }

    return githubCallbackHandler(request, env, dependencies);
  }

  if (pathname === "/api/auth/me") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }

    const principal = authorizeAdmin(await authenticateAdmin(request, env));
    return authMeHandler(request, env, principal);
  }

  if (pathname === "/api/auth/logout") {
    if (request.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }

    const principal = authorizeAdmin(await authenticateAdmin(request, env));
    return logoutHandler(request, env, principal);
  }

  if (pathname === "/api/submissions") {
    if (request.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }

    return createSubmissionHandler(request, env);
  }

  const isAdminRoute = pathname === "/api/admin" || pathname.startsWith("/api/admin/");
  let principal;

  if (isAdminRoute) {
    principal = authorizeAdmin(await authenticateAdmin(request, env));
  }

  if (pathname === "/api/admin/submissions") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }

    return listPendingSubmissionsHandler(request, env, principal);
  }

  const moderationMatch = pathname.match(
    /^\/api\/admin\/submissions\/([^/]+)\/(approve|reject)$/
  );

  if (moderationMatch) {
    if (request.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }

    const [, rawId, action] = moderationMatch;
    return moderateSubmissionHandler(request, env, principal, rawId, action);
  }

  throw new HttpError(404, "NOT_FOUND", "找不到指定的 API。");
}

export async function handleApiRequest(request, env, dependencies = {}) {
  const cors = corsDecision(request, env);

  if (!cors.allowed) {
    return errorResponse(
      new HttpError(403, "ORIGIN_NOT_ALLOWED", "此來源不允許存取 API。")
    );
  }

  if (request.method === "OPTIONS") {
    return applyCorsHeaders(handlePreflight(request), cors.origin);
  }

  try {
    const response = await routeApi(request, env, dependencies);
    return applyCorsHeaders(response, cors.origin);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status >= 500) {
      const url = new URL(request.url);
      // Intentionally omit query, headers, cookies, bodies, messages, and stack traces.
      console.error("API request failed", JSON.stringify({
        method: request.method,
        pathname: url.pathname,
        status: error instanceof HttpError ? error.status : 500,
        code: error instanceof HttpError ? error.code : "INTERNAL_ERROR",
        errorName: error?.name ?? "UnknownError"
      }));
    }

    return applyCorsHeaders(errorResponse(error, {
      exposeInternalDetails: env.APP_ENV === "development"
    }), cors.origin);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, env);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return jsonResponse(
      { ok: false, error: { code: "NOT_FOUND", message: "找不到指定資源。" } },
      { status: 404 }
    );
  }
};
