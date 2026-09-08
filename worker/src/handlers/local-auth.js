import {
  authorizeAdmin,
  getSessionTtlSeconds,
  isAdminAuthProviderEnabled,
  requireSessionSecret,
  verifyAdminCsrf
} from "../auth.js";
import { HttpError } from "../errors.js";
import { jsonResponse } from "../http.js";
import {
  findAdminById,
  findAdminByNormalizedUsername
} from "../repositories/admins.js";
import { writeAuditLog } from "../repositories/audit-logs.js";
import {
  createAdminSession,
  replaceSessionsAfterPasswordChange
} from "../repositories/sessions.js";
import { SESSION_COOKIE_NAME, parseCookies, sessionCookie } from "../security/cookies.js";
import { hmacBase64Url, randomBase64Url, sha256Hex } from "../security/crypto.js";
import {
  loginRateLimitKeys,
  resolveLoginRateLimiter,
  tooManyLoginAttempts
} from "../security/login-rate-limit.js";
import {
  DUMMY_PASSWORD_HASH,
  PasswordPolicyError,
  assertPasswordPolicy,
  hashPassword,
  normalizeUsername,
  verifyPassword
} from "../security/passwords.js";
import { parseJsonObject } from "../validation.js";

const LOGIN_BODY_MAX_BYTES = 4 * 1024;

function publicUser(admin) {
  return {
    username: admin.username ?? null,
    githubUsername: admin.githubUsername ?? null,
    role: admin.role,
    authMethods: [...admin.authMethods]
  };
}

async function sessionPayload(admin, rawSessionToken, expiresAt, env) {
  return {
    user: publicUser(admin),
    csrfToken: await hmacBase64Url(
      requireSessionSecret(env),
      `csrf:${rawSessionToken}`
    ),
    expiresAt
  };
}

function invalidCredentials() {
  return new HttpError(
    401,
    "INVALID_CREDENTIALS",
    "帳號或密碼錯誤。"
  );
}

function ensureLocalAuthEnabled(env) {
  if (!isAdminAuthProviderEnabled(env, "local")) {
    throw new HttpError(
      503,
      "LOCAL_AUTH_DISABLED",
      "帳號密碼登入尚未啟用。"
    );
  }
}

export function verifyLocalLoginOrigin(request, env) {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite && fetchSite !== "same-origin") {
    throw new HttpError(403, "LOGIN_ORIGIN_INVALID", "登入來源驗證失敗。")
  }
  if (origin !== requestOrigin) {
    const allowMissingForDevelopment = env.APP_ENV === "development" && !origin;
    if (!allowMissingForDevelopment) {
      throw new HttpError(403, "LOGIN_ORIGIN_INVALID", "登入來源驗證失敗。")
    }
  }
}

async function bestEffortFailedLoginAudit(db, adminId) {
  try {
    await writeAuditLog(db, {
      adminId,
      action: "local_login_failed",
      metadata: { result: "invalid_credentials" }
    });
  } catch {
    console.error("Local login failure audit failed", JSON.stringify({
      code: "AUDIT_LOG_FAILED"
    }));
  }
}

function normalizedLoginUsername(value) {
  try {
    return { ...normalizeUsername(value), valid: true };
  } catch {
    return { username: "", normalized: "invalid", valid: false };
  }
}

export async function authProvidersHandler(_request, env) {
  return jsonResponse({
    ok: true,
    data: {
      providers: {
        github: isAdminAuthProviderEnabled(env, "github"),
        local: isAdminAuthProviderEnabled(env, "local"),
        dev: env.APP_ENV === "development"
          && isAdminAuthProviderEnabled(env, "dev")
      }
    }
  });
}

export async function localLoginHandler(
  request,
  env,
  { loginRateLimiter } = {}
) {
  ensureLocalAuthEnabled(env);
  requireSessionSecret(env);
  verifyLocalLoginOrigin(request, env);
  const body = await parseJsonObject(request, {
    allowedKeys: ["username", "password"],
    maxBytes: LOGIN_BODY_MAX_BYTES
  });
  const suppliedUsername = normalizedLoginUsername(body.username);
  const password = typeof body.password === "string" ? body.password : "";
  const keys = await loginRateLimitKeys(
    request,
    env,
    suppliedUsername.normalized
  );
  const limiter = resolveLoginRateLimiter(env, loginRateLimiter);
  const limit = await limiter.reserve(keys);
  if (!limit.allowed) {
    throw tooManyLoginAttempts(limit.retryAfterSeconds);
  }

  const admin = suppliedUsername.valid
    ? await findAdminByNormalizedUsername(env.DB, suppliedUsername.normalized)
    : null;
  const passwordMatches = await verifyPassword(
    password,
    admin?.passwordHash ?? DUMMY_PASSWORD_HASH
  );
  const valid = Boolean(
    admin?.enabled
    && admin.authMethods.includes("local")
    && passwordMatches
  );

  if (!valid) {
    await bestEffortFailedLoginAudit(env.DB, admin?.id ?? null);
    throw invalidCredentials();
  }

  const rawSessionToken = randomBase64Url(32);
  const tokenHash = await sha256Hex(rawSessionToken);
  const ttlSeconds = getSessionTtlSeconds(env);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const previousRawToken = parseCookies(request).get(SESSION_COOKIE_NAME) ?? "";
  const replaceTokenHash = previousRawToken && previousRawToken.length <= 256
    ? await sha256Hex(previousRawToken)
    : null;

  const created = await createAdminSession(env.DB, {
    tokenHash,
    adminId: admin.id,
    expiresAt
  }, {
    replaceTokenHash,
    expectedPasswordHash: admin.passwordHash,
    audit: {
      adminId: admin.id,
      action: "local_login_success",
      metadata: { role: admin.role }
    }
  });
  if (!created) {
    await bestEffortFailedLoginAudit(env.DB, admin.id);
    throw invalidCredentials();
  }
  // Never erase an IP's attempts against other accounts after a valid login.
  await limiter.reset(keys.filter((key) => key.startsWith("username:")));

  return jsonResponse(
    {
      ok: true,
      data: await sessionPayload(admin, rawSessionToken, expiresAt, env)
    },
    { headers: { "Set-Cookie": sessionCookie(rawSessionToken, ttlSeconds, env) } }
  );
}

export async function changePasswordHandler(request, env, principal) {
  authorizeAdmin(principal);
  await verifyAdminCsrf(request, principal, env);
  if (!principal.authMethods?.includes("local")) {
    throw new HttpError(
      400,
      "LOCAL_IDENTITY_REQUIRED",
      "此管理員尚未設定帳號密碼登入。"
    );
  }

  const body = await parseJsonObject(request, {
    allowedKeys: ["currentPassword", "newPassword", "confirmPassword"],
    maxBytes: LOGIN_BODY_MAX_BYTES
  });
  if (
    typeof body.currentPassword !== "string"
    || typeof body.newPassword !== "string"
    || typeof body.confirmPassword !== "string"
  ) {
    throw new HttpError(400, "INVALID_PASSWORD_CHANGE", "密碼資料格式不正確。")
  }
  if (body.newPassword !== body.confirmPassword) {
    throw new HttpError(400, "PASSWORD_CONFIRMATION_MISMATCH", "新密碼與確認密碼不一致。")
  }
  try {
    assertPasswordPolicy(body.newPassword);
  } catch (error) {
    if (error instanceof PasswordPolicyError) {
      throw new HttpError(
        400,
        "PASSWORD_POLICY_INVALID",
        "新密碼需為 8–128 個字元，且不可只有空白。"
      );
    }
    throw error;
  }

  const admin = await findAdminById(env.DB, principal.adminId, {
    includePasswordHash: true
  });
  if (!admin?.enabled || !admin.passwordHash) {
    throw new HttpError(401, "UNAUTHORIZED", "管理員 session 已失效。")
  }
  if (!await verifyPassword(body.currentPassword, admin.passwordHash)) {
    throw new HttpError(401, "INVALID_CURRENT_PASSWORD", "目前密碼不正確。")
  }

  const newPasswordHash = await hashPassword(body.newPassword);
  const rawSessionToken = randomBase64Url(32);
  const tokenHash = await sha256Hex(rawSessionToken);
  const ttlSeconds = getSessionTtlSeconds(env);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const passwordUpdatedAt = new Date().toISOString();
  const replaced = await replaceSessionsAfterPasswordChange(env.DB, {
    adminId: admin.id,
    expectedPasswordHash: admin.passwordHash,
    currentSessionTokenHash: principal.sessionTokenHash,
    newPasswordHash,
    passwordUpdatedAt,
    tokenHash,
    expiresAt
  }, {
    audit: {
      adminId: admin.id,
      action: "password_changed"
    }
  });
  if (!replaced) {
    throw new HttpError(
      409,
      "PASSWORD_CHANGED_RETRY",
      "密碼已在其他地方更新，請重新登入後再試。"
    );
  }

  const updatedAdmin = {
    ...admin,
    passwordHash: undefined,
    passwordUpdatedAt,
    authMethods: [...admin.authMethods]
  };
  return jsonResponse(
    {
      ok: true,
      data: await sessionPayload(updatedAdmin, rawSessionToken, expiresAt, env)
    },
    { headers: { "Set-Cookie": sessionCookie(rawSessionToken, ttlSeconds, env) } }
  );
}

export const __testables = Object.freeze({
  invalidCredentials,
  normalizedLoginUsername,
  publicUser,
  sessionPayload
});
