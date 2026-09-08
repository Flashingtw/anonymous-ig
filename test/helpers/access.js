import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from "jose";
export const accessEnv = { ACCESS_TEAM_DOMAIN: "https://unit-test.cloudflareaccess.com", ACCESS_POLICY_AUD: "unit-test-app" };
export const keys = await generateKeyPair("RS256", { extractable: true });
export const jwk = { ...await exportJWK(keys.publicKey), kid: "test-key", alg: "RS256", use: "sig" };
export const accessJwks = createLocalJWKSet({ keys: [jwk] });
export async function accessToken(claims = {}, key = keys.privateKey, header = {}) {
  return new SignJWT({ email: " Owner@Example.com ", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-key", ...header })
    .setIssuer(claims.iss ?? accessEnv.ACCESS_TEAM_DOMAIN)
    .setAudience(claims.aud ?? accessEnv.ACCESS_POLICY_AUD)
    .setExpirationTime(claims.exp ?? Math.floor(Date.now() / 1000) + 300).sign(key);
}
