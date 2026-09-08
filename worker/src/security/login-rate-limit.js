import { HttpError } from "../errors.js";
import { hmacBase64Url } from "./crypto.js";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_SECONDS = 15 * 60;
const DEFAULT_BLOCK_SECONDS = 15 * 60;
const MIN_RETENTION_SECONDS = 24 * 60 * 60;

function integerSetting(value, fallback, { min, max }) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

export function loginRateLimitConfig(env) {
  const maxAttempts = integerSetting(
    env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
    DEFAULT_MAX_ATTEMPTS,
    { min: 3, max: 20 }
  );
  const windowSeconds = integerSetting(
    env.LOGIN_RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_WINDOW_SECONDS,
    { min: 60, max: 24 * 60 * 60 }
  );
  const blockSeconds = integerSetting(
    env.LOGIN_RATE_LIMIT_BLOCK_SECONDS,
    DEFAULT_BLOCK_SECONDS,
    { min: 60, max: 24 * 60 * 60 }
  );
  return Object.freeze({
    maxAttempts,
    windowSeconds,
    blockSeconds,
    retentionSeconds: Math.max(
      MIN_RETENTION_SECONDS,
      windowSeconds + blockSeconds
    )
  });
}

export class MemoryLoginRateLimiter {
  constructor(config, { now = () => Math.floor(Date.now() / 1000) } = {}) {
    this.config = config;
    this.now = now;
    this.entries = new Map();
  }

  prune(now) {
    for (const [key, entry] of this.entries) {
      if (entry.updatedAt < now - this.config.retentionSeconds) {
        this.entries.delete(key);
      }
    }
  }

  async check(keys) {
    const now = this.now();
    this.prune(now);
    const blockedUntil = Math.max(
      0,
      ...keys.map((key) => this.entries.get(key)?.blockedUntil ?? 0)
    );
    return blockedUntil > now
      ? { allowed: false, retryAfterSeconds: blockedUntil - now }
      : { allowed: true, retryAfterSeconds: 0 };
  }

  async recordFailure(keys) {
    const now = this.now();
    this.prune(now);
    for (const key of keys) {
      const previous = this.entries.get(key);
      const withinWindow = previous
        && (!previous.blockedUntil || previous.blockedUntil > now)
        && now - previous.windowStartedAt < this.config.windowSeconds;
      const failureCount = withinWindow ? previous.failureCount + 1 : 1;
      this.entries.set(key, {
        failureCount,
        windowStartedAt: withinWindow ? previous.windowStartedAt : now,
        blockedUntil: failureCount >= this.config.maxAttempts
          ? now + this.config.blockSeconds
          : null,
        updatedAt: now
      });
    }
  }

  async reserve(keys) {
    const now = this.now();
    this.prune(now);
    const blockedUntil = Math.max(0, ...keys.map((key) => this.entries.get(key)?.blockedUntil ?? 0));
    if (blockedUntil > now) {
      return { allowed: false, retryAfterSeconds: blockedUntil - now };
    }
    // recordFailure mutates synchronously before its promise resolves, so other
    // requests cannot pass the check while this request is deriving a password.
    await this.recordFailure(keys);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  async reset(keys) {
    for (const key of keys) {
      this.entries.delete(key);
    }
  }
}

export class D1LoginRateLimiter {
  constructor(db, config, { now = () => Math.floor(Date.now() / 1000) } = {}) {
    this.db = db;
    this.config = config;
    this.now = now;
  }

  async prune(now) {
    await this.db.prepare(`
      DELETE FROM admin_login_rate_limits
      WHERE updated_at < ?
    `).bind(now - this.config.retentionSeconds).run();
  }

  async check(keys) {
    const now = this.now();
    await this.prune(now);
    const row = await this.db.prepare(`
      SELECT MAX(COALESCE(blocked_until, 0)) AS blocked_until
      FROM admin_login_rate_limits
      WHERE identifier_hash IN (?, ?)
    `).bind(keys[0], keys[1]).first();
    const blockedUntil = Number(row?.blocked_until) || 0;
    return blockedUntil > now
      ? { allowed: false, retryAfterSeconds: blockedUntil - now }
      : { allowed: true, retryAfterSeconds: 0 };
  }

  async recordFailure(keys) {
    const now = this.now();
    const statements = keys.map((key) => this.db.prepare(`
      INSERT INTO admin_login_rate_limits (
        identifier_hash,
        failure_count,
        window_started_at,
        blocked_until,
        updated_at
      )
      VALUES (?, 1, ?, NULL, ?)
      ON CONFLICT(identifier_hash) DO UPDATE SET
        failure_count = CASE
          WHEN excluded.updated_at - admin_login_rate_limits.window_started_at >= ?
            THEN 1
          ELSE admin_login_rate_limits.failure_count + 1
        END,
        window_started_at = CASE
          WHEN excluded.updated_at - admin_login_rate_limits.window_started_at >= ?
            THEN excluded.updated_at
          ELSE admin_login_rate_limits.window_started_at
        END,
        blocked_until = CASE
          WHEN excluded.updated_at - admin_login_rate_limits.window_started_at >= ?
            THEN NULL
          WHEN admin_login_rate_limits.failure_count + 1 >= ?
            THEN excluded.updated_at + ?
          ELSE admin_login_rate_limits.blocked_until
        END,
        updated_at = excluded.updated_at
    `).bind(
      key,
      now,
      now,
      this.config.windowSeconds,
      this.config.windowSeconds,
      this.config.windowSeconds,
      this.config.maxAttempts,
      this.config.blockSeconds
    ));
    await this.db.batch(statements);
  }

  async reserve(keys) {
    const now = this.now();
    await this.prune(now);
    // D1 batch is a transaction. Each key's slot is reserved by the UPDATE,
    // including requests still awaiting PBKDF2. Blocked requests cannot extend
    // their own lockout. Expired blocks start a fresh window.
    const reset = `(excluded.updated_at - admin_login_rate_limits.window_started_at >= ?
      OR (admin_login_rate_limits.blocked_until IS NOT NULL
          AND admin_login_rate_limits.blocked_until <= excluded.updated_at))`;
    const results = await this.db.batch(keys.map((key) => this.db.prepare(`
      INSERT INTO admin_login_rate_limits
        (identifier_hash, failure_count, window_started_at, blocked_until, updated_at)
      VALUES (?, 1, ?, NULL, ?)
      ON CONFLICT(identifier_hash) DO UPDATE SET
        failure_count = CASE WHEN ${reset} THEN 1 ELSE failure_count + 1 END,
        window_started_at = CASE WHEN ${reset} THEN excluded.updated_at ELSE window_started_at END,
        blocked_until = CASE WHEN ${reset} THEN NULL
          WHEN failure_count + 1 >= ? THEN excluded.updated_at + ? ELSE blocked_until END,
        updated_at = excluded.updated_at
      WHERE COALESCE(admin_login_rate_limits.blocked_until, 0) <= excluded.updated_at
      RETURNING identifier_hash
    `).bind(key, now, now,
      this.config.windowSeconds, this.config.windowSeconds, this.config.windowSeconds,
      this.config.maxAttempts, this.config.blockSeconds)));
    if (results.every((result) => result.results?.length === 1)) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const blocked = await this.check(keys);
    // A simultaneous successful request may clear a username between reserve
    // and check. The denied request still does not proceed to password work.
    return { allowed: false, retryAfterSeconds: Math.max(1, blocked.retryAfterSeconds) };
  }

  async reset(keys) {
    if (keys.length === 0) return;
    await this.db.prepare(`
      DELETE FROM admin_login_rate_limits
      WHERE identifier_hash IN (${keys.map(() => "?").join(", ")})
    `).bind(...keys).run();
  }
}

const developmentLimiters = new WeakMap();

export function resolveLoginRateLimiter(env, provided) {
  if (provided) {
    return provided;
  }
  const config = loginRateLimitConfig(env);
  if (env.APP_ENV !== "development") {
    return new D1LoginRateLimiter(env.DB, config);
  }
  if (!developmentLimiters.has(env.DB)) {
    developmentLimiters.set(env.DB, new MemoryLoginRateLimiter(config));
  }
  return developmentLimiters.get(env.DB);
}

export async function loginRateLimitKeys(request, env, normalizedUsername) {
  const clientAddress = request.headers.get("CF-Connecting-IP")
    ?? (env.APP_ENV === "development" ? "local-development" : "");
  if (!clientAddress) {
    throw new HttpError(
      503,
      "CLIENT_ADDRESS_UNAVAILABLE",
      "暫時無法驗證登入來源。"
    );
  }

  const secret = env.SESSION_SECRET?.trim() ?? "";
  if (secret.length < 32) {
    throw new HttpError(
      503,
      "ADMIN_AUTH_NOT_CONFIGURED",
      "管理員登入尚未設定完成。"
    );
  }
  return [
    `ip:${await hmacBase64Url(secret, `local-login-ip:${clientAddress}`)}`,
    `username:${await hmacBase64Url(secret, `local-login-username:${normalizedUsername}`)}`
  ];
}

export function tooManyLoginAttempts(retryAfterSeconds) {
  return new HttpError(
    429,
    "TOO_MANY_ATTEMPTS",
    "登入嘗試次數過多，請稍後再試。",
    undefined,
    { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))) }
  );
}
