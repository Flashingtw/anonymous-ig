import { prepareAuditLog } from "./audit-logs.js";

function mapSubmission(row) {
  return {
    id: row.id,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function createSubmission(db, content) {
  const row = await db
    .prepare(`
      INSERT INTO submissions (content)
      VALUES (?)
      RETURNING id, content, status, created_at, updated_at
    `)
    .bind(content)
    .first();

  return mapSubmission(row);
}

export async function listPendingSubmissions(db, limit) {
  const result = await db
    .prepare(`
      SELECT id, content, status, created_at, updated_at
      FROM submissions
      WHERE status = 'pending'
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `)
    .bind(limit)
    .all();

  return result.results.map(mapSubmission);
}

export async function updatePendingSubmissionStatus(db, id, nextStatus) {
  const row = await db
    .prepare(`
      UPDATE submissions
      SET status = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND status = 'pending'
      RETURNING id, content, status, created_at, updated_at
    `)
    .bind(nextStatus, id)
    .first();

  if (row) {
    return { outcome: "updated", submission: mapSubmission(row) };
  }

  const existing = await db
    .prepare(`
      SELECT id, content, status, created_at, updated_at
      FROM submissions
      WHERE id = ?
      LIMIT 1
    `)
    .bind(id)
    .first();

  if (!existing) {
    return { outcome: "not_found" };
  }

  return { outcome: "conflict", submission: mapSubmission(existing) };
}

export async function updatePendingSubmissionStatusWithAudit(
  db,
  id,
  nextStatus,
  audit
) {
  const updateSubmission = db.prepare(`
    UPDATE submissions
    SET status = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND status = 'pending'
    RETURNING id, content, status, created_at, updated_at
  `).bind(nextStatus, id);

  const [updateResult] = await db.batch([
    updateSubmission,
    prepareAuditLog(db, audit, { onlyIfPreviousStatementChanged: true })
  ]);
  const row = updateResult.results?.[0];

  if (row) {
    return { outcome: "updated", submission: mapSubmission(row) };
  }

  const existing = await db
    .prepare(`
      SELECT id, content, status, created_at, updated_at
      FROM submissions
      WHERE id = ?
      LIMIT 1
    `)
    .bind(id)
    .first();

  if (!existing) {
    return { outcome: "not_found" };
  }

  return { outcome: "conflict", submission: mapSubmission(existing) };
}
