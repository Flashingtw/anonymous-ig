import assert from "node:assert/strict";
import test from "node:test";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import { accessEnv, keys, jwk, accessJwks, accessToken } from "./helpers/access.js";
import { verifyAccessJwt, createAccessJwks } from "../worker/src/security/cloudflare-access.js";

test("missing Access JWT fails closed with a masked error", async () => {
  await assert.rejects(verifyAccessJwt(new Request("https://admin.example.test/api/auth/access"), {}),
    { status: 403, code: "ACCESS_AUTH_FAILED", message: "Email 登入驗證失敗。" });
});

const request = (token) => new Request("https://admin.example.test/api/auth/access?email=attacker@example.com", {
  headers: { "Cf-Access-Jwt-Assertion": token, "Cf-Access-Authenticated-User-Email": "attacker@example.com", "X-User-Email": "attacker@example.com" }
});

test("a signed Access JWT yields only normalized verified email, ignoring client email", async () => {
  assert.deepEqual(await verifyAccessJwt(request(await accessToken()), accessEnv, { jwks: accessJwks }), { email: "owner@example.com" });
});

test("invalid JWTs and claims uniformly fail closed", async (t) => {
  const other = await generateKeyPair("RS256");
  const good = await accessToken();
  const cases = {
    malformed: "not-a-jwt", unsigned: good.split(".").slice(0, 2).join(".") + ".",
    signature: await accessToken({}, other.privateKey),
    issuer: await accessToken({ iss: "https://other.cloudflareaccess.com" }),
    audience: await accessToken({ aud: "another-app" }),
    expired: await accessToken({ exp: 1 }),
    future: await accessToken({ nbf: Math.floor(Date.now() / 1000) + 3600 }),
    missingEmail: await accessToken({ email: undefined }),
    numericEmail: await accessToken({ email: 123 }), blankEmail: await accessToken({ email: " " }),
    wrongAlgorithm: await new SignJWT({ email: "owner@example.com" }).setProtectedHeader({ alg: "HS256" }).sign(new Uint8Array(32)),
    missingExpiry: await new SignJWT({ email: "owner@example.com", iss: accessEnv.ACCESS_TEAM_DOMAIN, aud: accessEnv.ACCESS_POLICY_AUD })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" }).sign(keys.privateKey)
  };
  for (const [name, token] of Object.entries(cases)) await t.test(name, async () => {
    await assert.rejects(verifyAccessJwt(request(token), accessEnv, { jwks: accessJwks }), { status: 403, code: "ACCESS_AUTH_FAILED" });
  });
  for (const domain of ["http://unit-test.cloudflareaccess.com", "https://evil.example", "https://unit-test.cloudflareaccess.com/extra", "https://unit-test.cloudflareaccess.com@evil.example"]) {
    await assert.rejects(verifyAccessJwt(request(good), { ...accessEnv, ACCESS_TEAM_DOMAIN: domain }, { jwks: accessJwks }), { code: "ACCESS_AUTH_FAILED" });
  }
});

test("remote JWKS caches keys, rotates keys, and fails closed on network failure without Cloudflare calls", async () => {
  let calls = 0;
  let published = { keys: [jwk] };
  const jwks = createAccessJwks(accessEnv, { cooldownDuration: 0, fetcher: async (url, options) => {
    calls++;
    assert.equal(url, `${accessEnv.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    assert.equal(options.redirect, "manual");
    return Response.json(published);
  } });
  const token = await accessToken();
  await verifyAccessJwt(request(token), accessEnv, { jwks });
  await verifyAccessJwt(request(token), accessEnv, { jwks });
  assert.equal(calls, 1);
  const rotated = await generateKeyPair("RS256", { extractable: true });
  published = { keys: [{ ...await exportJWK(rotated.publicKey), kid: "rotated", alg: "RS256" }] };
  assert.deepEqual(await verifyAccessJwt(request(await accessToken({}, rotated.privateKey, { kid: "rotated" })), accessEnv, { jwks }), { email: "owner@example.com" });
  assert.equal(calls, 2);
  for (const fetcher of [async () => { throw new Error("network secret details"); }, async () => new Response("unavailable", { status: 503 }), async () => new Response("bad JSON")]) {
    await assert.rejects(verifyAccessJwt(request(token), accessEnv, { jwks: createAccessJwks(accessEnv, { fetcher }) }),
      { status: 403, code: "ACCESS_AUTH_FAILED", message: "Email 登入驗證失敗。" });
  }
});
