const ALLOWED_ACTIONS = new Set([
  "login",
  "logout",
  "approve_submission",
  "reject_submission"
]);

function auditValues({ adminId, action, submissionId = null, metadata = null }) {
  if (!ALLOWED_ACTIONS.has(action)) {
    throw new TypeError("Unsupported audit action.");
  }

  return {
    adminId,
    action,
    submissionId,
    serializedMetadata: metadata === null ? null : JSON.stringify(metadata)
  };
}

export function prepareAuditLog(
  db,
  entry,
  { onlyIfPreviousStatementChanged = false } = {}
) {
  const values = auditValues(entry);
  const statement = onlyIfPreviousStatementChanged
    ? `
      INSERT INTO audit_logs (admin_id, action, submission_id, metadata)
      SELECT ?, ?, ?, ?
      WHERE changes() = 1
      RETURNING id, admin_id, action, submission_id, metadata, created_at
    `
    : `
      INSERT INTO audit_logs (admin_id, action, submission_id, metadata)
      VALUES (?, ?, ?, ?)
      RETURNING id, admin_id, action, submission_id, metadata, created_at
    `;

  return db
    .prepare(statement)
    .bind(
      values.adminId,
      values.action,
      values.submissionId,
      values.serializedMetadata
    );
}
