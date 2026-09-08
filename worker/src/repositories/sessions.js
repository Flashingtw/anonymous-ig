import { prepareAuditLog } from "./audit-logs.js";

function mapAuthenticatedSession(row) {
  if (!row) {
    return null;
  }

  return {
    tokenHash: row.token_hash,
    adminId: row.admin_id,
    expiresAt: row.expires_at,
    githubUserId: row.github_user_id ?? null,
    githubUsername: row.github_username ?? null,
    username: row.username ?? null,
    authMethods: [
      ...(row.github_user_id ? ["github"] : []),
      ...(row.has_local_identity === 1 ? ["local"] : [])
    ],
    role: row.role
  };
}

export async function createAdminSession(
  db,
  { tokenHash, adminId, expiresAt },
  { audit = null, replaceTokenHash = null, expectedPasswordHash = null } = {}
) {
  await db
    .prepare(`
      DELETE FROM admin_sessions
      WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `)
    .run();

  const insertSession = db.prepare(`
      INSERT INTO admin_sessions (token_hash, admin_id, expires_at)
      SELECT ?, id, ? FROM admins
      WHERE id = ? AND enabled = 1
        AND (? IS NULL OR password_hash = ?)
    `).bind(tokenHash, expiresAt, adminId, expectedPasswordHash, expectedPasswordHash);

  const statements = [insertSession];
  if (audit) {
    statements.push(prepareAuditLog(db, audit, { onlyIfPreviousStatementChanged: true }));
  }
  if (replaceTokenHash) {
    statements.push(db.prepare(`
      DELETE FROM admin_sessions
      WHERE token_hash = ?
        AND EXISTS (SELECT 1 FROM admin_sessions WHERE token_hash = ?)
    `).bind(replaceTokenHash, tokenHash));
  }
  if (statements.length > 1) {
    const [result] = await db.batch(statements);
    return (result.meta?.changes ?? 0) === 1;
  }

  return ((await insertSession.run()).meta?.changes ?? 0) === 1;
}

export async function findAuthenticatedSession(db, tokenHash) {
  const row = await db
    .prepare(`
      SELECT sessions.token_hash,
             sessions.admin_id,
             sessions.expires_at,
             admins.github_user_id,
             admins.github_username,
             admins.username,
             CASE WHEN admins.password_hash IS NOT NULL THEN 1 ELSE 0 END
               AS has_local_identity,
             admins.role
      FROM admin_sessions AS sessions
      INNER JOIN admins ON admins.id = sessions.admin_id
      WHERE sessions.token_hash = ?
        AND sessions.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND admins.enabled = 1
      LIMIT 1
    `)
    .bind(tokenHash)
    .first();

  return mapAuthenticatedSession(row);
}

export async function replaceSessionsAfterPasswordChange(
  db,
  {
    adminId,
    expectedPasswordHash,
    currentSessionTokenHash,
    newPasswordHash,
    passwordUpdatedAt,
    tokenHash,
    expiresAt
  },
  { audit }
) {
  const updatePassword = db.prepare(`
    UPDATE admins
    SET password_hash = ?,
        password_updated_at = ?,
        updated_at = ?
    WHERE id = ?
      AND password_hash = ?
      AND enabled = 1
      AND EXISTS (
        SELECT 1 FROM admin_sessions WHERE token_hash = ? AND admin_id = admins.id
          AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      )
    RETURNING id
  `).bind(
    newPasswordHash,
    passwordUpdatedAt,
    passwordUpdatedAt,
    adminId,
    expectedPasswordHash,
    currentSessionTokenHash
  );
  const deleteSessions = db.prepare(`
    DELETE FROM admin_sessions
    WHERE admin_id = ?
      AND EXISTS (
        SELECT 1 FROM admins
        WHERE id = ? AND password_hash = ?
      )
  `).bind(adminId, adminId, newPasswordHash);
  const createSession = db.prepare(`
    INSERT INTO admin_sessions (token_hash, admin_id, expires_at)
    SELECT ?, id, ?
    FROM admins
    WHERE id = ? AND password_hash = ?
    RETURNING token_hash
  `).bind(tokenHash, expiresAt, adminId, newPasswordHash);
  const auditStatement = db.prepare(`
    INSERT INTO audit_logs (admin_id, action, submission_id, metadata)
    SELECT ?, ?, NULL, ?
    FROM admins
    WHERE id = ? AND password_hash = ?
    RETURNING id
  `).bind(
    audit.adminId,
    audit.action,
    audit.metadata === undefined || audit.metadata === null
      ? null
      : JSON.stringify(audit.metadata),
    adminId,
    newPasswordHash
  );

  const results = await db.batch([
    updatePassword,
    deleteSessions,
    createSession,
    auditStatement
  ]);
  return (results[0]?.meta?.changes ?? 0) === 1
    && (results[2]?.meta?.changes ?? 0) === 1;
}

export async function deleteAdminSession(db, tokenHash, { audit = null } = {}) {
  const deleteSession = db.prepare(`
      DELETE FROM admin_sessions
      WHERE token_hash = ?
    `).bind(tokenHash);

  if (audit) {
    const [result] = await db.batch([
      deleteSession,
      prepareAuditLog(db, audit, { onlyIfPreviousStatementChanged: true })
    ]);
    return result.meta?.changes ?? 0;
  }

  const result = await deleteSession.run();

  return result.meta?.changes ?? 0;
}
