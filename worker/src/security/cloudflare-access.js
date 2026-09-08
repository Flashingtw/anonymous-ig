import { HttpError } from "../errors.js";
import { createRemoteJWKSet, jwtVerify, customFetch } from "jose";
import { normalizeAccessEmail } from "./access-email.js";

function configuration(env) {
  const issuer = env.ACCESS_TEAM_DOMAIN;
  if (typeof issuer !== "string" || !/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(issuer)) {
    throw new Error("Invalid Access issuer configuration");
  }
  const audience = env.ACCESS_POLICY_AUD;
  if (typeof audience !== "string" || !audience.trim() || audience !== audience.trim() || audience.length > 256) {
    throw new Error("Invalid Access audience configuration");
  }
  return { issuer, audience };
}

// Injectable network boundary for offline key-rotation/failure tests. Not HTTP input.
export function createAccessJwks(env, { fetcher, cooldownDuration = 30_000, cacheMaxAge = 600_000 } = {}) {
  const { issuer } = configuration(env);
  return createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
    timeoutDuration: 3_000, cooldownDuration, cacheMaxAge,
    ...(fetcher ? { [customFetch]: fetcher } : {})
  });
}

// One configured issuer per deployed Worker; retain the resolver across requests.
let cachedIssuer;
let cachedJwks;
function productionKeys(env) {
  if (cachedIssuer !== env.ACCESS_TEAM_DOMAIN || !cachedJwks) {
    cachedJwks = createAccessJwks(env);
    cachedIssuer = env.ACCESS_TEAM_DOMAIN;
  }
  return cachedJwks;
}

export async function verifyAccessJwt(request, env, { jwks } = {}) {
  try {
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token || token.length > 16_384) throw new Error("Missing or oversized JWT");
    const { issuer, audience } = configuration(env);
    const { payload } = await jwtVerify(token, jwks ?? productionKeys(env), {
      issuer, audience, algorithms: ["RS256"],
      requiredClaims: ["iss", "aud", "exp", "email"]
    });
    return Object.freeze({ email: normalizeAccessEmail(payload.email) });
  } catch {
    // Never return/log jose errors, tokens, keys or unverified claims.
    throw new HttpError(403, "ACCESS_AUTH_FAILED", "Email 登入驗證失敗。");
  }
}
