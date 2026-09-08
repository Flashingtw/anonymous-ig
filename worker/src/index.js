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
import { accessLoginHandler } from "./handlers/access-auth.js";
import { adminDirectoryHandler } from "./handlers/admin-directory.js";
import {
  authProvidersHandler,
  changePasswordHandler,
  localLoginHandler
} from "./handlers/local-auth.js";

const ADMIN_HTML_CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'"
].join("; ");

const ADMIN_SHARED_ASSETS = new Set([
  "/config.js",
  "/content.json",
  "/assets/styles.css",
  "/assets/admin.js",
  "/assets/admin-auth.js",
  "/assets/api.js",
  "/assets/content.js"
]);

function isAdminAssetPath(pathname) {
  return pathname === "/admin"
    || pathname.startsWith("/admin/")
    || ADMIN_SHARED_ASSETS.has(pathname);
}

function secureAdminAssetResponse(response, pathname) {
  const headers = new Headers(response.headers);
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");

  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    headers.set("Cache-Control", "no-store");
    headers.set("Content-Security-Policy", ADMIN_HTML_CSP);
    headers.set("X-Frame-Options", "DENY");
  } else if (pathname === "/config.js" || pathname === "/content.json") {
    headers.set("Cache-Control", "no-store");
  } else {
    headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function publicSiteRedirect(env) {
  try {
    const url = new URL(env.PUBLIC_SITE_URL ?? "");
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.search
      || url.hash
    ) {
      return null;
    }

    return new Response(null, {
      status: 302,
      headers: {
        "Cache-Control": "no-store",
        Location: url.href,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch {
    return null;
  }
}

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

  if (pathname === "/api/auth/access") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    return accessLoginHandler(request, env, dependencies);
  }

  if (pathname === "/api/auth/providers") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return authProvidersHandler(request, env);
  }

  if (pathname === "/api/auth/login") {
    if (request.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }
    return localLoginHandler(request, env, dependencies);
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

  if (pathname === "/api/admin/admins") {
    authorizeAdmin(principal, ["owner"]);
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    return adminDirectoryHandler(request, env, principal);
  }

  if (pathname === "/api/admin/submissions") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }

    return listPendingSubmissionsHandler(request, env, principal);
  }

  if (pathname === "/api/admin/account/password") {
    if (request.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }
    return changePasswordHandler(request, env, principal);
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
      if (env.APP_ENV !== "production") {
        return env.ASSETS.fetch(request);
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        const redirect = publicSiteRedirect(env);
        if (redirect) {
          return redirect;
        }
      }

      if (isAdminAssetPath(url.pathname)) {
        return secureAdminAssetResponse(
          await env.ASSETS.fetch(request),
          url.pathname
        );
      }
    }

    return jsonResponse(
      { ok: false, error: { code: "NOT_FOUND", message: "找不到指定資源。" } },
      { status: 404 }
    );
  }
};
