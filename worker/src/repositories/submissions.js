import { prepareAuditLog } from "./audit-logs.js";

const SUBMISSION_COLUMNS = `
  id,
  content,
  status,
  created_at,
  updated_at,
  render_status,
  rendered_image_key,
  rendered_at,
  render_error,
  template_id,
  renderer_version,
  render_version
`;

function mapSubmission(row, { includeImageKey = false } = {}) {
  if (!row) {
    return null;
  }

  const submission = {
    id: row.id,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    renderStatus: row.render_status,
    renderedAt: row.rendered_at,
    renderError: row.render_error,
    templateId: row.template_id,
    rendererVersion: row.renderer_version,
    renderVersion: row.render_version,
    hasPreview: row.render_status === "ready" && Boolean(row.rendered_image_key)
  };

  if (includeImageKey) {
    submission.renderedImageKey = row.rendered_image_key;
  }

  return submission;
}

export async function createSubmission(db, content) {
  const row = await db
    .prepare(`
      INSERT INTO submissions (content)
      VALUES (?)
      RETURNING ${SUBMISSION_COLUMNS}
    `)
    .bind(content)
    .first();

  return mapSubmission(row);
}

export async function listSubmissionsByStatus(db, status, limit) {
  const result = await db
    .prepare(`
      SELECT ${SUBMISSION_COLUMNS}
      FROM submissions
      WHERE status = ?
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `)
    .bind(status, limit)
    .all();

  return result.results.map((row) => mapSubmission(row));
}

export function listPendingSubmissions(db, limit) {
  return listSubmissionsByStatus(db, "pending", limit);
}

export async function findSubmission(db, id, { includeImageKey = false } = {}) {
  const row = await db
    .prepare(`
      SELECT ${SUBMISSION_COLUMNS}
      FROM submissions
      WHERE id = ?
      LIMIT 1
    `)
    .bind(id)
    .first();

  return mapSubmission(row, { includeImageKey });
}

export async function updatePendingSubmissionStatus(db, id, nextStatus) {
  const row = await db
    .prepare(`
      UPDATE submissions
      SET status = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND status = 'pending'
      RETURNING ${SUBMISSION_COLUMNS}
    `)
    .bind(nextStatus, id)
    .first();

  if (row) {
    return { outcome: "updated", submission: mapSubmission(row) };
  }

  const existing = await findSubmission(db, id);
  if (!existing) {
    return { outcome: "not_found" };
  }

  return { outcome: "conflict", submission: existing };
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
    RETURNING ${SUBMISSION_COLUMNS}
  `).bind(nextStatus, id);

  const [updateResult] = await db.batch([
    updateSubmission,
    prepareAuditLog(db, audit, { onlyIfPreviousStatementChanged: true })
  ]);
  const row = updateResult.results?.[0];

  if (row) {
    return { outcome: "updated", submission: mapSubmission(row) };
  }

  const existing = await findSubmission(db, id);
  if (!existing) {
    return { outcome: "not_found" };
  }

  return { outcome: "conflict", submission: existing };
}

export async function beginSubmissionRender(
  db,
  id,
  { templateId, rendererVersion }
) {
  const row = await db
    .prepare(`
      UPDATE submissions
      SET render_status = 'rendering',
          render_error = NULL,
          template_id = ?,
          renderer_version = ?,
          render_version = render_version + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
        AND status = 'approved'
        AND render_status != 'rendering'
      RETURNING ${SUBMISSION_COLUMNS}
    `)
    .bind(templateId, rendererVersion, id)
    .first();

  if (row) {
    return {
      outcome: "started",
      submission: mapSubmission(row, { includeImageKey: true })
    };
  }

  const existing = await findSubmission(db, id, { includeImageKey: true });
  if (!existing) {
    return { outcome: "not_found" };
  }
  if (existing.status !== "approved") {
    return { outcome: "not_approved", submission: existing };
  }
  return { outcome: "already_rendering", submission: existing };
}

async function finishSubmissionRender(
  db,
  id,
  expectedRenderVersion,
  { status, imageKey = null, errorCode = null, audit = null }
) {
  const update = status === "ready"
    ? db.prepare(`
        UPDATE submissions
        SET render_status = 'ready',
            rendered_image_key = ?,
            rendered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            render_error = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
          AND status = 'approved'
          AND render_status = 'rendering'
          AND render_version = ?
        RETURNING ${SUBMISSION_COLUMNS}
      `).bind(imageKey, id, expectedRenderVersion)
    : db.prepare(`
        UPDATE submissions
        SET render_status = 'failed',
            render_error = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
          AND status = 'approved'
          AND render_status = 'rendering'
          AND render_version = ?
        RETURNING ${SUBMISSION_COLUMNS}
      `).bind(errorCode, id, expectedRenderVersion);

  if (!audit) {
    const row = await update.first();
    return row
      ? { outcome: "updated", submission: mapSubmission(row) }
      : { outcome: "stale" };
  }

  const [result] = await db.batch([
    update,
    prepareAuditLog(db, audit, { onlyIfPreviousStatementChanged: true })
  ]);
  const row = result.results?.[0];
  return row
    ? { outcome: "updated", submission: mapSubmission(row) }
    : { outcome: "stale" };
}

export function completeSubmissionRender(
  db,
  id,
  expectedRenderVersion,
  { imageKey, audit = null }
) {
  return finishSubmissionRender(db, id, expectedRenderVersion, {
    status: "ready",
    imageKey,
    audit
  });
}

export function failSubmissionRender(
  db,
  id,
  expectedRenderVersion,
  { errorCode, audit = null }
) {
  return finishSubmissionRender(db, id, expectedRenderVersion, {
    status: "failed",
    errorCode,
    audit
  });
}

export async function findReadySubmissionPreview(db, id) {
  const submission = await findSubmission(db, id, { includeImageKey: true });
  if (!submission) {
    return { outcome: "not_found" };
  }
  if (
    submission.status !== "approved"
    || !submission.hasPreview
    || !submission.renderedImageKey
  ) {
    return { outcome: "not_ready", submission };
  }
  return { outcome: "ready", submission };
}
