import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { executeSql, sqlLiteral } from "./manage-admin.js";
import { normalizeAccessEmail } from "../worker/src/security/access-email.js";

export const usage = "npm run admin:bind-access-email -- --github-user-id NUMERIC_ID --email EMAIL (--local | --remote) [--execute]";

export function parseArguments(argv) {
  const options = { execute: false, target: null, githubUserId: null, email: null };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (seen.has(key)) throw new Error("Duplicate option.");
    seen.add(key);
    if (key === "--execute") { options.execute = true; continue; }
    if (key === "--local" || key === "--remote") {
      if (options.target) throw new Error("Choose exactly one database target.");
      options.target = key.slice(2); continue;
    }
    if (!["--github-user-id", "--email"].includes(key)) throw new Error("Unsupported option. No password or role arguments accepted.");
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error("Missing option value.");
    if (key === "--email") options.email = normalizeAccessEmail(value);
    else {
      if (!/^[0-9]{1,32}$/.test(value)) throw new Error("GitHub ID must contain 1-32 digits.");
      options.githubUserId = value;
    }
  }
  if (!options.target || !options.githubUserId || !options.email) throw new Error("Explicit target, GitHub ID and email are required.");
  return options;
}

export async function runCli(argv, {
  query = request => executeSql({ ...request, json: true }), execute = executeSql, logger = console
} = {}) {
  const options = parseArguments(argv);
  const rows = await query({ target: options.target, sensitive: false, sql: `SELECT id, github_user_id, github_username, role, enabled, created_at, access_email, access_email_normalized
    FROM admins WHERE github_user_id=${sqlLiteral(options.githubUserId)} OR access_email_normalized=${sqlLiteral(options.email)};` });
  if (!Array.isArray(rows)) throw new Error("Invalid query result.");
  const matches = rows.filter(row => row.github_user_id === options.githubUserId);
  if (matches.length !== 1) throw new Error("Exactly one existing GitHub admin is required.");
  const admin = matches[0];
  if (!Number.isSafeInteger(admin.id) || admin.id <= 0 || !["owner", "admin", "moderator"].includes(admin.role)) throw new Error("Invalid admin metadata.");
  if (admin.enabled !== 1) throw new Error("Cannot bind a disabled admin.");
  if (admin.access_email !== null || admin.access_email_normalized !== null) throw new Error("Admin already has an Access email; this command does not overwrite bindings.");
  if (rows.some(row => row.id !== admin.id && row.access_email_normalized === options.email)) throw new Error("Duplicate Access email.");
  logger.log(`Target: ${options.target}; will bind to admin id ${admin.id}; GitHub ${admin.github_user_id} (${admin.github_username}); role ${admin.role}; enabled ${admin.enabled}; email ${options.email}. No new admin row.`);
  if (!options.execute) { logger.log("Preview only. Add --execute to bind. No database changes."); return; }
  // D1 executes the file atomically. The assertion aborts the whole operation
  // if the preview target changed; audit failure also rolls back the update.
  const sql = `UPDATE admins SET access_email=${sqlLiteral(options.email)}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=${admin.id} AND github_user_id=${sqlLiteral(options.githubUserId)}
      AND github_username=${sqlLiteral(admin.github_username)} AND role=${sqlLiteral(admin.role)}
      AND created_at=${sqlLiteral(admin.created_at)} AND enabled=1
      AND access_email IS NULL AND access_email_normalized IS NULL
      AND NOT EXISTS(SELECT 1 FROM admins WHERE access_email_normalized=${sqlLiteral(options.email)});
    SELECT CASE WHEN changes()=1 THEN 1 ELSE json('ACCESS_BIND_TARGET_CHANGED') END;
    INSERT INTO audit_logs(admin_id,action,metadata) VALUES(NULL,'admin_access_email_bound',
      json_object('source','bind-access-email-cli','target_admin_id',${admin.id},'provider','cloudflare_access'));`;
  try {
    await execute({ target: options.target, sql, sensitive: true, sensitiveValues: [options.email] });
  } catch {
    throw new Error("Access email binding failed or outcome unavailable. Database errors roll back the transaction; after a transport error, inspect the binding and audit before retrying.");
  }
  logger.log("Access email bound to the existing admin and audited. Existing sessions unchanged.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runCli(process.argv.slice(2)); }
  catch (error) { console.error(error.message); console.error(usage); process.exitCode = 1; }
}
