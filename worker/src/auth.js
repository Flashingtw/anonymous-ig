import { HttpError } from "./errors.js";
import { findAuthenticatedSession } from "./repositories/sessions.js";
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  parseCookies
} from "./security/cookies.js";
import {
  hmacBase64Url,
  sha256Hex,
  timingSafeEqual
} from "./security/crypto.js";

export const ADMIN_ROLES = Object.freeze(["owner", "admin", "moderator"]);
const ADMIN_ROLE_SET = new Set(ADMIN_ROLES);
const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const MIN_SESSION_TTL_SECONDS = 15 * 60;
const MAX_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function extractBearerToken(request) {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

export function getAdminAuthProvider(env) {
  return env.ADMIN_AUTH_PROVIDER?.trim().toLowerCase() || "github";
}

export function requireSessionSecret(env) {
  const secret = env.SESSION_SECRET?.trim() ?? "";
  if (secret.length < 32 || secret.startsWith("replace-with-")) {
    throw new HttpError(
      503,
      "ADMIN_AUTH_NOT_CONFIGURED",
      "管理員登入尚未設定完成。"
    );
  }
  return secret;
}

export function getSessionTtlSeconds(env) {
  const configured = Number(env.SESSION_TTL_SECONDS);
  if (!Number.isInteger(configured)) {
    return DEFAULT_SESSION_TTL_SECONDS;
  }

  return Math.min(
    Math.max(configured, MIN_SESSION_TTL_SECONDS),
    MAX_SESSION_TTL_SECONDS
  );
}

async function authenticateDevAdmin(request, env) {
  if (env.APP_ENV !== "development" || env.DEV_ADMIN_MODE !== "true") {
    throw new HttpError(
      503,
      "ADMIN_AUTH_NOT_CONFIGURED",
      "管理員登入尚未設定完成。"
    );
  }

  const expectedToken = env.DEV_ADMIN_TOKEN?.trim() ?? "";
  if (expectedToken.length < 24 || expectedToken.startsWith("replace-with-")) {
    throw new HttpError(
      503,
      "ADMIN_AUTH_NOT_CONFIGURED",
      "開發管理模式缺少有效設定。"
    );
  }

  const suppliedToken = extractBearerToken(request);
  if (!suppliedToken || !timingSafeEqual(suppliedToken, expectedToken)) {
    throw new HttpError(401, "UNAUTHORIZED", "管理員憑證無效。", undefined, {
      "WWW-Authenticate": "Bearer"
    });
  }

  return Object.freeze({
    id: "local-dev-admin",
    adminId: null,
    provider: "dev",
    githubUserId: null,
    githubUsername: "local-development",
    role: "admin",
    roles: ["admin"]
  });
}

async function authenticateGithubAdmin(request, env) {
  const sessionToken = parseCookies(request).get(SESSION_COOKIE_NAME) ?? "";
  if (!sessionToken || sessionToken.length > 256) {
    throw new HttpError(401, "UNAUTHORIZED", "請先登入管理員帳號。");
  }

  const tokenHash = await sha256Hex(sessionToken);
  const session = await findAuthenticatedSession(env.DB, tokenHash);
  if (!session) {
    throw new HttpError(401, "UNAUTHORIZED", "管理員 session 已失效。", undefined, {
      "Set-Cookie": clearSessionCookie(env)
    });
  }

  return Object.freeze({
    id: session.adminId,
    adminId: session.adminId,
    provider: "github",
    githubUserId: session.githubUserId,
    githubUsername: session.githubUsername,
    role: session.role,
    roles: [session.role],
    sessionToken,
    sessionTokenHash: tokenHash,
    expiresAt: session.expiresAt
  });
}

const AUTH_PROVIDERS = Object.freeze({
  dev: authenticateDevAdmin,
  github: authenticateGithubAdmin
});

export async function authenticateAdmin(request, env) {
  const provider = AUTH_PROVIDERS[getAdminAuthProvider(env)];

  if (!provider) {
    throw new HttpError(
      503,
      "ADMIN_AUTH_NOT_CONFIGURED",
      "管理員登入尚未設定完成。"
    );
  }

  return provider(request, env);
}

export function authorizeAdmin(principal, allowedRoles = ADMIN_ROLES) {
  const role = principal?.role;
  if (!ADMIN_ROLE_SET.has(role) || !allowedRoles.includes(role)) {
    throw new HttpError(403, "FORBIDDEN", "此帳號沒有管理權限。");
  }

  return principal;
}

export async function createCsrfToken(principal, env) {
  if (principal.provider === "dev") {
    return null;
  }

  const secret = requireSessionSecret(env);
  return hmacBase64Url(secret, `csrf:${principal.sessionToken}`);
}

export async function verifyAdminCsrf(request, principal, env) {
  if (principal.provider === "dev") {
    // The development provider uses a non-ambient Authorization bearer token.
    return;
  }

  const supplied = request.headers.get("X-CSRF-Token") ?? "";
  if (!supplied || supplied.length > 256) {
    throw new HttpError(403, "CSRF_INVALID", "安全驗證失敗，請重新整理後再試。");
  }

  const expected = await createCsrfToken(principal, env);
  if (!timingSafeEqual(supplied, expected)) {
    throw new HttpError(403, "CSRF_INVALID", "安全驗證失敗，請重新整理後再試。");
  }
}

export const __testables = Object.freeze({
  extractBearerToken,
  timingSafeEqual,
  authenticateDevAdmin,
  authenticateGithubAdmin
});
