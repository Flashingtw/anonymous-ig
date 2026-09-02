export const SESSION_COOKIE_NAME = "anonymous_admin_session";
export const OAUTH_REQUEST_COOKIE_NAME = "anonymous_oauth_request";

export function parseCookies(request) {
  const cookies = new Map();
  const header = request.headers.get("Cookie") ?? "";

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && !cookies.has(name)) {
      cookies.set(name, value);
    }
  }

  return cookies;
}

function cookieSecurity(env) {
  return env.APP_ENV === "development" ? "" : "; Secure";
}

export function sessionCookie(value, maxAgeSeconds, env) {
  const expires = new Date(Date.now() + maxAgeSeconds * 1000).toUTCString();
  return `${SESSION_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax${cookieSecurity(env)}; Max-Age=${maxAgeSeconds}; Expires=${expires}`;
}

export function clearSessionCookie(env) {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax${cookieSecurity(env)}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export function oauthRequestCookie(value, maxAgeSeconds, env) {
  const expires = new Date(Date.now() + maxAgeSeconds * 1000).toUTCString();
  return `${OAUTH_REQUEST_COOKIE_NAME}=${value}; Path=/api/auth/github/callback; HttpOnly; SameSite=Lax${cookieSecurity(env)}; Max-Age=${maxAgeSeconds}; Expires=${expires}`;
}

export function clearOauthRequestCookie(env) {
  return `${OAUTH_REQUEST_COOKIE_NAME}=; Path=/api/auth/github/callback; HttpOnly; SameSite=Lax${cookieSecurity(env)}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
