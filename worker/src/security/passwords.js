import { timingSafeEqual } from "./crypto.js";
import { graphemeLength } from "../../../frontend/assets/graphemes.js";

export const PASSWORD_ALGORITHM = "pbkdf2_sha256";
export const PASSWORD_ITERATIONS = 600_000;
export const PASSWORD_MIN_GRAPHEMES = 8;
export const PASSWORD_MAX_GRAPHEMES = 128;

const SALT_BYTES = 16;
const DERIVED_KEY_BYTES = 32;
const MAX_PASSWORD_BYTES = 1024;
const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/;
const encoder = new TextEncoder();

// Public and intentionally non-secret. It exists only to equalize the costly
// verification path when a username is absent from the database.
export const DUMMY_PASSWORD_HASH =
  "pbkdf2_sha256$600000$AAAAAAAAAAAAAAAAAAAAAA$ugOc1PYTYVrYARTBAxO2PaLIrS8ZrmgPBiK21-ydJRs";

export class PasswordPolicyError extends Error {
  constructor(code) {
    super(code === "PASSWORD_TOO_SHORT"
      ? `Password must contain at least ${PASSWORD_MIN_GRAPHEMES} characters.`
      : code);
    this.name = "PasswordPolicyError";
    this.code = code;
  }
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9_-]+$/.test(value)
    || value.length % 4 === 1
  ) {
    return null;
  }

  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export function normalizeUsername(value) {
  if (typeof value !== "string") {
    throw new TypeError("Username must be a string.");
  }

  const username = value.trim();
  if (!USERNAME_PATTERN.test(username)) {
    throw new TypeError("Username must contain 3-32 safe ASCII characters.");
  }

  return Object.freeze({
    username,
    normalized: username.toLowerCase()
  });
}

export function assertPasswordPolicy(password) {
  if (typeof password !== "string") {
    throw new PasswordPolicyError("PASSWORD_MUST_BE_STRING");
  }

  const byteLength = encoder.encode(password).byteLength;
  const length = graphemeLength(password);
  if (length < PASSWORD_MIN_GRAPHEMES) {
    throw new PasswordPolicyError("PASSWORD_TOO_SHORT");
  }
  if (length > PASSWORD_MAX_GRAPHEMES || byteLength > MAX_PASSWORD_BYTES) {
    throw new PasswordPolicyError("PASSWORD_TOO_LONG");
  }
  if (!password.trim()) {
    throw new PasswordPolicyError("PASSWORD_WHITESPACE_ONLY");
  }

  return password;
}

async function derive(password, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations
    },
    keyMaterial,
    DERIVED_KEY_BYTES * 8
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password, { salt } = {}) {
  assertPasswordPolicy(password);
  const saltBytes = salt === undefined
    ? crypto.getRandomValues(new Uint8Array(SALT_BYTES))
    : new Uint8Array(salt);
  if (saltBytes.byteLength !== SALT_BYTES) {
    throw new TypeError(`Password salt must be ${SALT_BYTES} bytes.`);
  }

  const derived = await derive(password, saltBytes, PASSWORD_ITERATIONS);
  return [
    PASSWORD_ALGORITHM,
    String(PASSWORD_ITERATIONS),
    bytesToBase64Url(saltBytes),
    bytesToBase64Url(derived)
  ].join("$");
}

function parsePasswordHash(encodedHash) {
  if (typeof encodedHash !== "string" || encodedHash.length > 512) {
    return null;
  }
  const parts = encodedHash.split("$");
  if (parts.length !== 4 || parts[0] !== PASSWORD_ALGORITHM) {
    return null;
  }
  if (!/^\d{1,8}$/.test(parts[1])) {
    return null;
  }
  const iterations = Number(parts[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 100_000 || iterations > 2_000_000) {
    return null;
  }
  const salt = base64UrlToBytes(parts[2]);
  const derived = base64UrlToBytes(parts[3]);
  if (salt?.byteLength !== SALT_BYTES || derived?.byteLength !== DERIVED_KEY_BYTES) {
    return null;
  }
  return { iterations, salt, derived: parts[3] };
}

export async function verifyPassword(password, encodedHash) {
  const parsed = parsePasswordHash(encodedHash);
  if (!parsed || typeof password !== "string") {
    return false;
  }
  if (encoder.encode(password).byteLength > MAX_PASSWORD_BYTES) {
    return false;
  }

  try {
    const derived = await derive(password, parsed.salt, parsed.iterations);
    return timingSafeEqual(bytesToBase64Url(derived), parsed.derived);
  } catch {
    return false;
  }
}

export const __testables = Object.freeze({
  base64UrlToBytes,
  bytesToBase64Url,
  graphemeLength,
  parsePasswordHash
});
