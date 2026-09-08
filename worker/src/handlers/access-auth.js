import { authorizeAdmin, getSessionTtlSeconds, requireSessionSecret } from "../auth.js";
import { HttpError } from "../errors.js";
import { findAdminByAccessEmail } from "../repositories/admins.js";
import { createAdminSession } from "../repositories/sessions.js";
import { writeAuditLog } from "../repositories/audit-logs.js";
import { verifyAccessJwt } from "../security/cloudflare-access.js";
import { sessionCookie, parseCookies, SESSION_COOKIE_NAME } from "../security/cookies.js";
import { randomBase64Url, sha256Hex } from "../security/crypto.js";

async function denied(db, adminId = null) {
  try { await writeAuditLog(db, { adminId, action: "access_login_denied", metadata: { provider: "cloudflare_access" } }); }
  catch { console.error("Access denied audit unavailable"); }
}

export async function accessLoginHandler(request, env, { accessJwks } = {}) {
  if (env.ACCESS_AUTH_ENABLED !== "true") throw new HttpError(503, "ACCESS_AUTH_DISABLED", "Email 驗證碼登入尚未啟用。");
  let identity;
  try { identity = await verifyAccessJwt(request, env, { jwks: accessJwks }); }
  catch (error) { await denied(env.DB); throw error; }
  const admin = await findAdminByAccessEmail(env.DB, identity.email);
  if (!admin?.enabled) {
    await denied(env.DB, admin?.id ?? null);
    throw new HttpError(403, "NOT_ADMINISTRATOR", "此 Email 沒有管理權限。");
  }
  authorizeAdmin(admin);
  requireSessionSecret(env);
  const ttl = getSessionTtlSeconds(env);
  const token = randomBase64Url(32);
  const previous = parseCookies(request).get(SESSION_COOKIE_NAME);
  const created = await createAdminSession(env.DB, {
    adminId: admin.id, tokenHash: await sha256Hex(token), expiresAt: new Date(Date.now() + ttl * 1000).toISOString()
  }, {
    expectedAccessEmail: identity.email,
    replaceTokenHash: previous && previous.length <= 256 ? await sha256Hex(previous) : null,
    audit: { adminId: admin.id, action: "access_login_success", metadata: { provider: "cloudflare_access" } }
  });
  if (!created) {
    await denied(env.DB, admin.id);
    throw new HttpError(403, "NOT_ADMINISTRATOR", "此 Email 沒有管理權限。");
  }
  return new Response(null, { status: 302, headers: {
    Location: new URL("/admin/", request.url).href,
    "Set-Cookie": sessionCookie(token, ttl, env), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer"
  } });
}
