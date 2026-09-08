function authMethods(row) {
  const methods = [];
  if (row?.github_user_id) {
    methods.push("github");
  }
  if (row?.username_normalized && row?.password_hash) {
    methods.push("local");
  }
  return methods;
}

function mapAdmin(row, { includePasswordHash = false } = {}) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    githubUserId: row.github_user_id ?? null,
    githubUsername: row.github_username ?? null,
    username: row.username ?? null,
    usernameNormalized: row.username_normalized ?? null,
    ...(includePasswordHash ? { passwordHash: row.password_hash ?? null } : {}),
    passwordUpdatedAt: row.password_updated_at ?? null,
    authMethods: authMethods(row),
    role: row.role,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const ADMIN_COLUMNS = `
  id,
  github_user_id,
  github_username,
  username,
  username_normalized,
  password_hash,
  password_updated_at,
  role,
  enabled,
  created_at,
  updated_at
`;

export async function findAdminByGithubUserId(db, githubUserId) {
  const row = await db
    .prepare(`
      SELECT ${ADMIN_COLUMNS}
      FROM admins
      WHERE github_user_id = ?
      LIMIT 1
    `)
    .bind(githubUserId)
    .first();

  return mapAdmin(row);
}

export async function findAdminByNormalizedUsername(db, normalizedUsername) {
  const row = await db
    .prepare(`
      SELECT ${ADMIN_COLUMNS}
      FROM admins
      WHERE username_normalized = ?
      LIMIT 1
    `)
    .bind(normalizedUsername)
    .first();

  return mapAdmin(row, { includePasswordHash: true });
}

export async function findAdminById(db, adminId, { includePasswordHash = false } = {}) {
  const row = await db
    .prepare(`
      SELECT ${ADMIN_COLUMNS}
      FROM admins
      WHERE id = ?
      LIMIT 1
    `)
    .bind(adminId)
    .first();

  return mapAdmin(row, { includePasswordHash });
}

export async function updateAdminGithubUsername(db, adminId, githubUsername) {
  const row = await db
    .prepare(`
      UPDATE admins
      SET github_username = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
      RETURNING ${ADMIN_COLUMNS}
    `)
    .bind(githubUsername, adminId)
    .first();

  return mapAdmin(row);
}

export const __testables = Object.freeze({ authMethods, mapAdmin });
