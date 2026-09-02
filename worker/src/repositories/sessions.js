import { prepareAuditLog } from "./audit-logs.js";

function mapAuthenticatedSession(row) {
  if (!row) {
    return null;
  }

  return {
    tokenHash: row.token_hash,
    adminId: row.admin_id,
    expiresAt: row.expires_at,
    githubUserId: row.github_user_id,
    githubUsername: row.github_username,
    role: row.role
  };
}

export async function createAdminSession(
  db,
  { tokenHash, adminId, expiresAt },
  { audit = null } = {}
) {
  await db
    .prepare(`
      DELETE FROM admin_sessions
      WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `)
    .run();

  const insertSession = db.prepare(`
      INSERT INTO admin_sessions (token_hash, admin_id, expires_at)
      VALUES (?, ?, ?)
    `).bind(tokenHash, adminId, expiresAt);

  if (audit) {
    await db.batch([insertSession, prepareAuditLog(db, audit)]);
    return;
  }

  await insertSession.run();
}

export async function findAuthenticatedSession(db, tokenHash) {
  const row = await db
    .prepare(`
      SELECT sessions.token_hash,
             sessions.admin_id,
             sessions.expires_at,
             admins.github_user_id,
             admins.github_username,
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
