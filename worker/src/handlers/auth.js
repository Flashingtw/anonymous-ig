import {
  authorizeAdmin,
  createCsrfToken,
  getAdminAuthProvider,
  getSessionTtlSeconds,
  requireSessionSecret,
  verifyAdminCsrf
} from "../auth.js";
import { HttpError } from "../errors.js";
import { jsonResponse } from "../http.js";
import {
  findAdminByGithubUserId,
  updateAdminGithubUsername
} from "../repositories/admins.js";
import {
  createAdminSession,
  deleteAdminSession
} from "../repositories/sessions.js";
import {
  OAUTH_REQUEST_COOKIE_NAME,
  clearOauthRequestCookie,
  clearSessionCookie,
  oauthRequestCookie,
  parseCookies,
  sessionCookie
} from "../security/cookies.js";
import {
  decodeBase64Url,
  encodeBase64Url,
  hmacBase64Url,
  randomBase64Url,
  sha256Base64Url,
  sha256Hex,
  timingSafeEqual
} from "../security/crypto.js";

const OAUTH_REQUEST_TTL_SECONDS = 10 * 60;
const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

function configurationError() {
  return new HttpError(
    503,
    "ADMIN_AUTH_NOT_CONFIGURED",
    "GitHub 管理員登入尚未設定完成。"
  );
}

function validatePublicUrl(value, env) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw configurationError();
  }

  if (url.username || url.password || url.search || url.hash) {
    throw configurationError();
  }

  if (env.APP_ENV !== "development" && url.protocol !== "https:") {
    throw configurationError();
  }

  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw configurationError();
  }

  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (url.protocol === "http:" && !loopbackHosts.has(url.hostname)) {
    throw configurationError();
  }

  return url;
}

function githubConfiguration(env) {
  if (getAdminAuthProvider(env) !== "github") {
    throw configurationError();
  }

  const clientId = env.GITHUB_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.GITHUB_CLIENT_SECRET?.trim() ?? "";
  const redirectUri = env.GITHUB_REDIRECT_URI?.trim() ?? "";
  const frontendUrl = env.FRONTEND_URL?.trim() ?? "";
  const sessionSecret = requireSessionSecret(env);

  if (!clientId || !clientSecret || !redirectUri || !frontendUrl) {
    throw configurationError();
  }

  const validatedRedirect = validatePublicUrl(redirectUri, env);
  const validatedFrontend = validatePublicUrl(frontendUrl, env);
  if (validatedRedirect.pathname !== "/api/auth/github/callback") {
    throw configurationError();
  }
  const frontendMatchesCallback = validatedFrontend.origin === validatedRedirect.origin
    && validatedFrontend.pathname === "/";
  if (!frontendMatchesCallback) {
    throw configurationError();
  }

  return {
    clientId,
    clientSecret,
    redirectUri: validatedRedirect.href,
    // OAuth always returns to the callback's trusted Worker origin. Never
    // derive this from request Host or the cross-origin GitHub Pages URL.
    frontendUrl: new URL("/", validatedRedirect).href,
    sessionSecret
  };
}

function redirectResponse(location, cookies = []) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    Location: location,
    "Referrer-Policy": "no-referrer"
  });
  for (const cookie of cookies) {
    headers.append("Set-Cookie", cookie);
  }

  return new Response(null, { status: 302, headers });
}

function adminFrontendUrl(configuration, authResult) {
  const publicResult = new Set([
    "success",
    "unauthorized",
    "cancelled",
    "error"
  ]).has(authResult)
    ? authResult
    : "error";
  const base = configuration.frontendUrl.endsWith("/")
    ? configuration.frontendUrl
    : `${configuration.frontendUrl}/`;
  const url = new URL("admin/", base);
  url.searchParams.set("auth", publicResult);
  return url.href;
}

async function createSignedOauthRequest(sessionSecret) {
  const payload = encodeBase64Url(JSON.stringify({
    state: randomBase64Url(32),
    verifier: randomBase64Url(32),
    expiresAt: Date.now() + OAUTH_REQUEST_TTL_SECONDS * 1000
  }));
  const signature = await hmacBase64Url(sessionSecret, `oauth:${payload}`);
  return `${payload}.${signature}`;
}

async function readSignedOauthRequest(cookieValue, sessionSecret) {
  if (!cookieValue || cookieValue.length > 2048) {
    return null;
  }

  const parts = cookieValue.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const [payload, signature] = parts;
  const expected = await hmacBase64Url(sessionSecret, `oauth:${payload}`);
  if (!timingSafeEqual(signature, expected)) {
    return null;
  }

  try {
    const parsed = JSON.parse(decodeBase64Url(payload));
    const validState = typeof parsed.state === "string" && parsed.state.length >= 32;
    const validVerifier = typeof parsed.verifier === "string" && parsed.verifier.length >= 43;
    const validExpiration = Number.isFinite(parsed.expiresAt) && parsed.expiresAt > Date.now();
    return validState && validVerifier && validExpiration ? parsed : null;
  } catch {
    return null;
  }
}

function callbackResultResponse(configuration, env, result, cookies = []) {
  return redirectResponse(adminFrontendUrl(configuration, result), [
    clearOauthRequestCookie(env),
    ...cookies
  ]);
}

function logOauthCallbackFailure(error) {
  // Never log the callback URL, authorization code, state, token, cookies, or SQL.
  console.error("OAuth callback failed", JSON.stringify({
    code: error instanceof HttpError ? error.code : "INTERNAL_ERROR",
    errorName: error?.name ?? "UnknownError"
  }));
}

async function exchangeGithubCode(configuration, code, verifier, fetchImpl) {
  const response = await fetchImpl(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "anonymous-submissions-worker"
    },
    body: new URLSearchParams({
      client_id: configuration.clientId,
      client_secret: configuration.clientSecret,
      code,
      redirect_uri: configuration.redirectUri,
      code_verifier: verifier
    })
  });

  if (!response.ok) {
    throw new HttpError(502, "GITHUB_OAUTH_FAILED", "GitHub 登入暫時失敗，請稍後再試。");
  }

  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload.access_token !== "string" || !payload.access_token) {
    throw new HttpError(502, "GITHUB_OAUTH_FAILED", "GitHub 登入暫時失敗，請稍後再試。");
  }

  return payload.access_token;
}

async function fetchGithubUser(accessToken, fetchImpl) {
  const response = await fetchImpl(GITHUB_USER_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "anonymous-submissions-worker",
      "X-GitHub-Api-Version": GITHUB_API_VERSION
    }
  });

  if (!response.ok) {
    throw new HttpError(502, "GITHUB_PROFILE_FAILED", "無法取得 GitHub 登入身份。");
  }

  const profile = await response.json().catch(() => null);
  const validId = Number.isSafeInteger(profile?.id) && profile.id > 0;
  const validLogin = typeof profile?.login === "string"
    && profile.login.length >= 1
    && profile.login.length <= 100;
  if (!validId || !validLogin) {
    throw new HttpError(502, "GITHUB_PROFILE_FAILED", "GitHub 登入身份格式不正確。");
  }

  return {
    githubUserId: String(profile.id),
    githubUsername: profile.login
  };
}

export async function githubLoginHandler(_request, env) {
  const configuration = githubConfiguration(env);
  const signedRequest = await createSignedOauthRequest(configuration.sessionSecret);
  const oauthRequest = await readSignedOauthRequest(
    signedRequest,
    configuration.sessionSecret
  );
  const authorizeUrl = new URL(GITHUB_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", configuration.clientId);
  authorizeUrl.searchParams.set("redirect_uri", configuration.redirectUri);
  authorizeUrl.searchParams.set("state", oauthRequest.state);
  authorizeUrl.searchParams.set(
    "code_challenge",
    await sha256Base64Url(oauthRequest.verifier)
  );
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  // No scope is requested: GET /user is sufficient for the public identity.
  return redirectResponse(authorizeUrl.href, [
    oauthRequestCookie(signedRequest, OAUTH_REQUEST_TTL_SECONDS, env)
  ]);
}

export async function githubCallbackHandler(
  request,
  env,
  { fetchImpl = fetch } = {}
) {
  let configuration;
  try {
    configuration = githubConfiguration(env);
  } catch (error) {
    try {
      const callbackUrl = validatePublicUrl(
        env.GITHUB_REDIRECT_URI?.trim() ?? "",
        env
      );
      const fallback = {
        frontendUrl: new URL("/", callbackUrl).href
      };
      logOauthCallbackFailure(error);
      return callbackResultResponse(fallback, env, "error");
    } catch {
      throw error;
    }
  }

  try {
    const url = new URL(request.url);
    const expectedCallback = new URL(configuration.redirectUri);
    const callbackMatches = url.origin === expectedCallback.origin
      && url.pathname === expectedCallback.pathname;
    const suppliedState = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const cookieValue = parseCookies(request).get(OAUTH_REQUEST_COOKIE_NAME) ?? "";
    const oauthRequest = await readSignedOauthRequest(
      cookieValue,
      configuration.sessionSecret
    );

    if (
      !callbackMatches
      || !oauthRequest
      || !suppliedState
      || suppliedState.length > 256
      || !timingSafeEqual(suppliedState, oauthRequest.state)
    ) {
      return callbackResultResponse(configuration, env, "error");
    }

    if (url.searchParams.has("error")) {
      return callbackResultResponse(configuration, env, "cancelled");
    }

    if (!code || code.length > 1024) {
      return callbackResultResponse(configuration, env, "error");
    }

    const accessToken = await exchangeGithubCode(
      configuration,
      code,
      oauthRequest.verifier,
      fetchImpl
    );
    const profile = await fetchGithubUser(accessToken, fetchImpl);
    // The short-lived variable is intentionally discarded here; it is never persisted.

    const allowlistedAdmin = await findAdminByGithubUserId(
      env.DB,
      profile.githubUserId
    );
    if (!allowlistedAdmin?.enabled) {
      return callbackResultResponse(configuration, env, "unauthorized");
    }

    const admin = await updateAdminGithubUsername(
      env.DB,
      allowlistedAdmin.id,
      profile.githubUsername
    );
    if (!admin?.enabled) {
      return callbackResultResponse(configuration, env, "unauthorized");
    }

    const rawSessionToken = randomBase64Url(32);
    const tokenHash = await sha256Hex(rawSessionToken);
    const ttlSeconds = getSessionTtlSeconds(env);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    await createAdminSession(env.DB, {
      tokenHash,
      adminId: admin.id,
      expiresAt
    }, {
      audit: {
        adminId: admin.id,
        action: "login",
        metadata: {
          github_username: admin.githubUsername,
          role: admin.role
        }
      }
    });

    return callbackResultResponse(configuration, env, "success", [
      sessionCookie(rawSessionToken, ttlSeconds, env)
    ]);
  } catch (error) {
    logOauthCallbackFailure(error);
    return callbackResultResponse(configuration, env, "error");
  }
}

export async function authMeHandler(_request, env, principal) {
  authorizeAdmin(principal);
  const csrfToken = await createCsrfToken(principal, env);
  return jsonResponse({
    ok: true,
    data: {
      user: {
        githubUsername: principal.githubUsername,
        role: principal.role
      },
      csrfToken,
      expiresAt: principal.expiresAt ?? null
    }
  });
}

export async function logoutHandler(request, env, principal) {
  authorizeAdmin(principal);
  await verifyAdminCsrf(request, principal, env);

  if (principal.provider === "github") {
    try {
      await deleteAdminSession(env.DB, principal.sessionTokenHash, {
        audit: {
          adminId: principal.adminId,
          action: "logout"
        }
      });
    } catch {
      try {
        // Session revocation takes priority if the audit table is unavailable.
        await deleteAdminSession(env.DB, principal.sessionTokenHash);
      } catch {
        throw new HttpError(
          503,
          "LOGOUT_FAILED",
          "暫時無法登出，請稍後再試。"
        );
      }

      throw new HttpError(
        500,
        "AUDIT_LOG_FAILED",
        "已登出，但稽核紀錄暫時無法寫入。",
        undefined,
        { "Set-Cookie": clearSessionCookie(env) }
      );
    }
  }

  return jsonResponse(
    { ok: true, data: { loggedOut: true } },
    { headers: { "Set-Cookie": clearSessionCookie(env) } }
  );
}

export const __testables = Object.freeze({
  adminFrontendUrl,
  createSignedOauthRequest,
  fetchGithubUser,
  githubConfiguration,
  readSignedOauthRequest
});
