function mapAdmin(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    githubUserId: row.github_user_id,
    githubUsername: row.github_username,
    role: row.role,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function findAdminByGithubUserId(db, githubUserId) {
  const row = await db
    .prepare(`
      SELECT id, github_user_id, github_username, role, enabled,
             created_at, updated_at
      FROM admins
      WHERE github_user_id = ?
      LIMIT 1
    `)
    .bind(githubUserId)
    .first();

  return mapAdmin(row);
}

export async function updateAdminGithubUsername(db, adminId, githubUsername) {
  const row = await db
    .prepare(`
      UPDATE admins
      SET github_username = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
      RETURNING id, github_user_id, github_username, role, enabled,
                created_at, updated_at
    `)
    .bind(githubUsername, adminId)
    .first();

  return mapAdmin(row);
}
