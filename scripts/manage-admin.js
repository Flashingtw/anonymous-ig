import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertPasswordPolicy,
  hashPassword,
  normalizeUsername,
  PASSWORD_MIN_GRAPHEMES,
  PASSWORD_MAX_GRAPHEMES
} from "../worker/src/security/passwords.js";

const ROLES = new Set(["owner", "admin", "moderator"]);
export const usage = `Usage:
  node scripts/manage-admin.js add-local --username USERNAME [--role ROLE] (--local | --remote) [--execute]
  node scripts/manage-admin.js bind-local --github-user-id NUMERIC_ID --username USERNAME (--local | --remote) [--execute]
  node scripts/manage-admin.js list (--local | --remote)
  node scripts/manage-admin.js set-role --username USERNAME --role ROLE (--local | --remote) [--execute]
  node scripts/manage-admin.js disable --username USERNAME (--local | --remote) [--execute]
  node scripts/manage-admin.js enable --username USERNAME (--local | --remote) [--execute]
  node scripts/manage-admin.js set-password --username USERNAME (--local | --remote) [--execute]

ROLE is owner, admin, or moderator. Mutations are previews unless --execute is present.
add-local defaults to moderator. --local and --remote select separate databases.
bind-local reads the existing GitHub admin in preview mode; it never creates an admin or changes a role.
Passwords must contain ${PASSWORD_MIN_GRAPHEMES}–${PASSWORD_MAX_GRAPHEMES} graphemes, at most 1024 UTF-8 bytes, and cannot be all whitespace.
Passwords are accepted only through a hidden TTY prompt; --password is never accepted.`;

const COMMAND_OPTIONS = Object.freeze({
  "add-local": new Set(["--username", "--role", "--local", "--remote", "--execute"]),
  "bind-local": new Set(["--github-user-id", "--username", "--local", "--remote", "--execute"]),
  list: new Set(["--local", "--remote"]),
  "set-role": new Set(["--username", "--role", "--local", "--remote", "--execute"]),
  disable: new Set(["--username", "--local", "--remote", "--execute"]),
  enable: new Set(["--username", "--local", "--remote", "--execute"]),
  "set-password": new Set(["--username", "--local", "--remote", "--execute"])
});

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

export function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error("A command is required.");
  }

  const command = argv[0];
  const allowedOptions = COMMAND_OPTIONS[command];
  if (!allowedOptions) {
    throw new Error(`Unknown command: ${command}`);
  }

  const parsed = {
    command,
    execute: false,
    role: command === "add-local" ? "moderator" : null,
    target: null,
    username: null,
    usernameNormalized: null,
    ...(command === "bind-local" ? { githubUserId: null } : {})
  };
  const seen = new Set();

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--password" || argument.startsWith("--password=")) {
      throw new Error("--password is forbidden; enter passwords only at the hidden TTY prompt.");
    }
    if (!allowedOptions.has(argument)) {
      if (!argument.startsWith("--")) {
        throw new Error(`Unexpected positional argument for ${command}.`);
      }
      throw new Error(`Unknown option for ${command}: ${argument.split("=", 1)[0]}`);
    }
    if (seen.has(argument)) {
      throw new Error(`Duplicate argument: ${argument}`);
    }
    seen.add(argument);

    if (argument === "--execute") {
      parsed.execute = true;
      continue;
    }
    if (argument === "--local" || argument === "--remote") {
      if (parsed.target !== null) {
        throw new Error("Choose exactly one target: --local or --remote.");
      }
      parsed.target = argument.slice(2);
      continue;
    }

    const value = optionValue(argv, index, argument);
    index += 1;
    if (argument === "--username") {
      const normalized = normalizeUsername(value);
      parsed.username = normalized.username;
      parsed.usernameNormalized = normalized.normalized;
    } else if (argument === "--github-user-id") {
      if (!/^[0-9]{1,32}$/.test(value)) {
        throw new Error("--github-user-id must contain 1-32 digits.");
      }
      parsed.githubUserId = value;
    } else if (argument === "--role") {
      if (!ROLES.has(value)) {
        throw new Error("--role must be owner, admin, or moderator.");
      }
      parsed.role = value;
    }
  }

  if (parsed.target === null) {
    throw new Error("Choose exactly one target: --local or --remote.");
  }
  if (command !== "list" && parsed.username === null) {
    throw new Error("--username is required.");
  }
  if (command === "set-role" && parsed.role === null) {
    throw new Error("--role is required.");
  }
  if (command === "bind-local" && parsed.githubUserId === null) {
    throw new Error("--github-user-id is required.");
  }

  return Object.freeze(parsed);
}

export function sqlLiteral(value) {
  if (typeof value !== "string") {
    throw new TypeError("SQL literal values must be strings.");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

const nowSql = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export function bindingTargetSql(options) {
  // Return only identity metadata; never retrieve an existing password hash.
  return `SELECT id, github_user_id, role, enabled, username_normalized,
  CASE WHEN username IS NOT NULL OR username_normalized IS NOT NULL
    OR password_hash IS NOT NULL OR password_updated_at IS NOT NULL
    THEN 1 ELSE 0 END AS has_local_identity
FROM admins
WHERE github_user_id = ${sqlLiteral(options.githubUserId)}
   OR username_normalized = ${sqlLiteral(options.usernameNormalized)};`;
}

function bindingTarget(options, rows) {
  if (!Array.isArray(rows)) throw new Error("Unable to read the binding target.");
  const matches = rows.filter((row) => row.github_user_id === options.githubUserId);
  if (matches.length !== 1) {
    throw new Error("Binding requires exactly one matching GitHub admin. Check --github-user-id and target.");
  }
  const admin = matches[0];
  if (!Number.isSafeInteger(admin.id) || admin.id <= 0 || !ROLES.has(admin.role)) {
    throw new Error("Invalid binding target metadata; refusing to continue.");
  }
  if (admin.enabled !== 1) throw new Error("Cannot bind a disabled admin.");
  if (admin.has_local_identity !== 0) {
    throw new Error("Admin already has a local identity. Use set-password to reset it; binding will not overwrite it.");
  }
  if (rows.some((row) => row.id !== admin.id && row.username_normalized === options.usernameNormalized)) {
    throw new Error("Username is already used by another admin.");
  }
  return Object.freeze({ id: admin.id, role: admin.role });
}

export function listSql() {
  return `SELECT
  id,
  github_username,
  username,
  CASE
    WHEN github_user_id IS NOT NULL AND username_normalized IS NOT NULL THEN 'github,local'
    WHEN github_user_id IS NOT NULL THEN 'github'
    WHEN username_normalized IS NOT NULL THEN 'local'
    ELSE ''
  END AS auth_methods,
  role,
  enabled,
  created_at
FROM admins
ORDER BY id;`;
}

function changedAdminAuditSql({ action, usernameNormalized, metadataEntriesSql = "" }) {
  return `INSERT INTO audit_logs (admin_id, action, submission_id, metadata)
SELECT NULL, ${sqlLiteral(action)}, NULL,
       json_object(
         'source', 'manage-admin-cli',
         'target_admin_id', id${metadataEntriesSql}
       )
FROM admins
WHERE username_normalized = ${sqlLiteral(usernameNormalized)}
  AND changes() = 1;`;
}

function targetAssertionSql() {
  // D1 rejects TEMP tables and RAISE() outside triggers. SQLite evaluates only
  // the selected CASE branch: invalid JSON aborts the transaction on no match.
  return `SELECT CASE WHEN changes() = 1 THEN 1
  ELSE json('MANAGE_ADMIN_TARGET_NOT_FOUND') END;`;
}

export function mutationSql(options, { passwordHash, binding } = {}) {
  const username = sqlLiteral(options.username);
  const normalized = sqlLiteral(options.usernameNormalized);

  if (options.command === "bind-local") {
    if (typeof passwordHash !== "string" || !Number.isSafeInteger(binding?.id)
      || binding.id <= 0 || !ROLES.has(binding.role)) {
      throw new TypeError("bind-local requires a password hash and a resolved admin target.");
    }
    const githubId = sqlLiteral(options.githubUserId);
    // Recheck every precondition at the write boundary. A preview does not
    // authorize binding a different/replaced row or overwriting new credentials.
    return `UPDATE admins
SET username = ${username}, username_normalized = ${normalized},
    password_hash = ${sqlLiteral(passwordHash)}, password_updated_at = ${nowSql},
    updated_at = ${nowSql}
WHERE id = ${binding.id} AND github_user_id = ${githubId}
  AND role = ${sqlLiteral(binding.role)} AND enabled = 1
  AND username IS NULL AND username_normalized IS NULL
  AND password_hash IS NULL AND password_updated_at IS NULL
  AND (SELECT COUNT(*) FROM admins WHERE github_user_id = ${githubId}) = 1
  AND NOT EXISTS (SELECT 1 FROM admins WHERE username_normalized = ${normalized});
SELECT CASE WHEN changes() = 1 THEN 1
  ELSE json('BIND_LOCAL_TARGET_CHANGED') END;
${changedAdminAuditSql({
    action: "admin_local_identity_bound",
    usernameNormalized: options.usernameNormalized
  })}
DELETE FROM admin_sessions WHERE admin_id = ${binding.id};`;
  }

  if (options.command === "add-local") {
    if (typeof passwordHash !== "string") {
      throw new TypeError("add-local requires a password hash.");
    }
    return `INSERT INTO admins (
  username, username_normalized, password_hash, password_updated_at,
  role, enabled, updated_at
)
VALUES (
  ${username}, ${normalized}, ${sqlLiteral(passwordHash)}, ${nowSql},
  ${sqlLiteral(options.role)}, 1, ${nowSql}
);
INSERT INTO audit_logs (admin_id, action, submission_id, metadata)
VALUES (
  NULL, 'admin_account_created', NULL,
  json_object(
    'source', 'manage-admin-cli',
    'target_admin_id', last_insert_rowid(),
    'auth_method', 'local',
    'role', ${sqlLiteral(options.role)}
  )
);`;
  }

  if (options.command === "set-password") {
    if (typeof passwordHash !== "string") {
      throw new TypeError("set-password requires a password hash.");
    }
    return `UPDATE admins
SET password_hash = ${sqlLiteral(passwordHash)},
    password_updated_at = ${nowSql},
    updated_at = ${nowSql}
WHERE username_normalized = ${normalized};
${changedAdminAuditSql({
    action: "password_changed",
    usernameNormalized: options.usernameNormalized
  })}
${targetAssertionSql()}
DELETE FROM admin_sessions
WHERE admin_id = (
  SELECT id FROM admins WHERE username_normalized = ${normalized}
);`;
  }

  if (options.command === "set-role") {
    return `UPDATE admins
SET role = ${sqlLiteral(options.role)},
    updated_at = ${nowSql}
WHERE username_normalized = ${normalized};
${changedAdminAuditSql({
    action: "admin_role_changed",
    usernameNormalized: options.usernameNormalized,
    metadataEntriesSql: `,\n         'role', ${sqlLiteral(options.role)}`
  })}
${targetAssertionSql()}`;
  }

  if (options.command === "disable" || options.command === "enable") {
    const enabled = options.command === "enable" ? 1 : 0;
    const action = enabled === 1 ? "admin_account_enabled" : "admin_account_disabled";
    return `UPDATE admins
SET enabled = ${enabled},
    updated_at = ${nowSql}
WHERE username_normalized = ${normalized};
${changedAdminAuditSql({
    action,
    usernameNormalized: options.usernameNormalized
  })}
${targetAssertionSql()}
${enabled === 0 ? `DELETE FROM admin_sessions
WHERE admin_id = (SELECT id FROM admins WHERE username_normalized = ${normalized});` : ""}`;
  }

  throw new TypeError(`Unsupported mutation command: ${options.command}`);
}

export function wranglerArguments(target, { command, file } = {}) {
  if (target !== "local" && target !== "remote") {
    throw new TypeError("Wrangler target must be local or remote.");
  }
  if ((command === undefined) === (file === undefined)) {
    throw new TypeError("Provide exactly one of command or file.");
  }

  const targetArguments = target === "remote"
    ? ["--remote", "--env", "production"]
    : ["--local", "--config", "wrangler.dev.jsonc"];
  return [
    "d1",
    "execute",
    "DB",
    ...targetArguments,
    ...(file === undefined ? ["--command", command] : ["--file", file])
  ];
}

export function protectWindowsDirectory(directory, { spawn = spawnSync } = {}) {
  // Pass the path as data, never interpolate it into PowerShell source.
  const result = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference = 'Stop'
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($identity)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($identity, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
      $acl.AddAccessRule($rule)
    }
    [System.IO.Directory]::SetAccessControl($env:ANONYMOUS_ADMIN_TEMP, $acl)
  `], {
    env: { ...process.env, ANONYMOUS_ADMIN_TEMP: directory },
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error || result.status !== 0) {
    throw new Error("Unable to protect the temporary SQL directory with a Windows ACL.");
  }
}

export async function withSensitiveSqlFile(sql, callback, {
  makeTemporaryDirectory = mkdtemp,
  changeMode = chmod,
  write = writeFile,
  remove = rm,
  temporaryRoot = tmpdir(),
  platform = process.platform,
  protectWindows = protectWindowsDirectory
} = {}) {
  const directory = await makeTemporaryDirectory(join(temporaryRoot, "anonymous-admin-"));
  const filename = join(directory, "mutation.sql");
  try {
    if (platform === "win32") {
      protectWindows(directory);
    } else {
      await changeMode(directory, 0o700);
    }
    await write(filename, sql, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await changeMode(filename, 0o600);
    return await callback(filename);
  } finally {
    await remove(directory, { force: true, recursive: true });
  }
}

function redact(value, secrets) {
  let safeValue = String(value ?? "");
  for (const secret of secrets) {
    if (secret) {
      safeValue = safeValue.replaceAll(secret, "[REDACTED]");
    }
  }
  return safeValue;
}

// Row queries accept exactly one successful statement envelope from
// --command --json. Never scrape JSON out of terminal/progress output.
export function normalizeWranglerD1Rows(output) {
  let payload;
  try {
    if (typeof output !== "string") throw new TypeError();
    payload = JSON.parse(output);
  } catch {
    throw new Error("Unable to parse Wrangler query results; no binding performed.");
  }
  if (!Array.isArray(payload) || payload.length !== 1
    || payload[0]?.success !== true || !Array.isArray(payload[0]?.results)
    || Object.hasOwn(payload[0], "finalBookmark")) {
    throw new Error("Unexpected Wrangler query results; expected one successful statement.");
  }
  return payload[0].results;
}

export async function executeSql({
  target,
  sql,
  sensitive = false,
  sensitiveValues = [],
  json = false
}, {
  spawn = spawnSync,
  stdout = process.stdout,
  stderr = process.stderr,
  sensitiveFile = withSensitiveSqlFile
} = {}) {
  if (json && sensitive) {
    throw new Error("JSON row queries cannot use the sensitive file-import path. Never pass credentials via --command.");
  }
  const invoke = (argumentsList, logDirectory) => {
    const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
    const result = spawn(process.execPath, [wrangler, ...argumentsList, ...(json ? ["--json"] : [])], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG_SANITIZE: "true",
        ...(logDirectory ? { WRANGLER_LOG_PATH: logDirectory } : {})
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const safeStdout = redact(result.stdout, sensitiveValues);
    const safeStderr = redact(result.stderr, sensitiveValues);
    if (safeStdout && !json) stdout.write(safeStdout);
    if (safeStderr) stderr.write(safeStderr);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const combined = `${safeStdout}\n${safeStderr}`;
      if (combined.includes("BIND_LOCAL_TARGET_CHANGED")
        || (sql.includes("BIND_LOCAL_TARGET_CHANGED") && /malformed JSON/i.test(combined))) {
        throw new Error("Binding refused: target or username changed after preview. Re-run the dry-run; no credentials were overwritten.");
      }
      if (combined.includes("LAST_ENABLED_OWNER")) {
        throw new Error(
          "Operation refused: the database must keep at least one enabled owner. "
          + "Add or enable another owner first."
        );
      }
      if (combined.includes("MANAGE_ADMIN_TARGET_NOT_FOUND")
        || (sql.includes("MANAGE_ADMIN_TARGET_NOT_FOUND") && /malformed JSON/i.test(combined))) {
        throw new Error(
          "No matching local admin was found. Check --username and the selected target."
        );
      }
      throw new Error(`Wrangler exited with status ${result.status ?? "unknown"}.`);
    }
    if (json) {
      return normalizeWranglerD1Rows(result.stdout);
    }
  };

  if (sensitive) {
    return sensitiveFile(sql, (filename) => invoke(
      wranglerArguments(target, { file: filename }), dirname(filename)
    ));
  }
  return invoke(wranglerArguments(target, { command: sql }));
}

export function promptHidden(label, {
  input = process.stdin,
  output = process.stderr
} = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Password entry requires an interactive TTY.");
  }

  return new Promise((resolvePrompt, rejectPrompt) => {
    let value = "";
    const wasRaw = Boolean(input.isRaw);
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      if (!wasRaw) input.pause();
    };
    const finish = () => {
      cleanup();
      output.write("\n");
      resolvePrompt(value);
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") {
          cleanup();
          output.write("\n");
          rejectPrompt(new Error("Password entry cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = [...value].slice(0, -1).join("");
        } else if (character >= " ") {
          value += character;
        }
      }
    };

    output.write(label);
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

export async function readConfirmedPassword({ prompt = promptHidden } = {}) {
  const password = await prompt("Password: ");
  const confirmation = await prompt("Confirm password: ");
  if (password !== confirmation) {
    throw new Error("Password confirmation does not match.");
  }
  assertPasswordPolicy(password);
  return password;
}

function previewDescription(options) {
  if (options.command === "bind-local") {
    return `bind local username ${options.username} to GitHub ID ${options.githubUserId}`;
  }
  if (options.command === "add-local") {
    return `add local admin ${options.username} with role ${options.role}`;
  }
  if (options.command === "set-role") {
    return `set ${options.username}'s role to ${options.role}`;
  }
  if (options.command === "set-password") {
    return `replace ${options.username}'s password and revoke existing sessions`;
  }
  return `${options.command} local admin ${options.username}`;
}

export async function runCli(argv, {
  execute = executeSql,
  query = (request) => executeSql({ ...request, json: true }),
  passwordReader = readConfirmedPassword,
  passwordHasher = hashPassword,
  logger = console
} = {}) {
  const options = parseArguments(argv);

  if (options.command === "list") {
    await execute({ target: options.target, sql: listSql(), sensitive: false });
    return;
  }

  logger.log(`Target: ${options.target}`);
  logger.log(`Plan: ${previewDescription(options)}`);
  let binding;
  if (options.command === "bind-local") {
    binding = bindingTarget(options, await query({
      target: options.target, sql: bindingTargetSql(options), sensitive: false
    }));
    logger.log(`Will bind to admin id ${binding.id} (role ${binding.role}, unchanged). No new admin row.`);
    logger.log("Existing sessions for this admin will be revoked; GitHub sign-in remains available.");
  }
  if (!options.execute) {
    logger.log("Preview only. Add --execute to apply this change.");
    return;
  }

  let passwordHash;
  let sensitiveValues = [];
  if (["add-local", "set-password", "bind-local"].includes(options.command)) {
    const password = await passwordReader();
    assertPasswordPolicy(password);
    passwordHash = await passwordHasher(password);
    sensitiveValues = [password, passwordHash];
  }

  await execute({
    target: options.target,
    sql: mutationSql(options, { passwordHash, binding }),
    sensitive: passwordHash !== undefined,
    sensitiveValues
  });
  logger.log("Admin change completed and audited.");
}

export async function main(argv = process.argv.slice(2)) {
  try {
    await runCli(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
