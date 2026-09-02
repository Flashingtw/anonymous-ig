import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const usage = `Usage:
  npm run bootstrap:owner -- \\
    --github-user-id 12345678 \\
    --github-username YOUR_USERNAME \\
    (--local | --remote) [--execute]

Without --execute, the command only validates and previews the operation.`;

function parseArguments(argv) {
  const result = {
    execute: false,
    githubUserId: "",
    githubUsername: "",
    target: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") {
      result.execute = true;
    } else if (argument === "--local" || argument === "--remote") {
      if (result.target) {
        throw new Error("Choose exactly one target: --local or --remote.");
      }
      result.target = argument.slice(2);
    } else if (argument === "--github-user-id") {
      result.githubUserId = argv[index + 1] ?? "";
      index += 1;
    } else if (argument === "--github-username") {
      result.githubUsername = argv[index + 1] ?? "";
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!/^[1-9][0-9]{0,31}$/.test(result.githubUserId)) {
    throw new Error("--github-user-id must be a positive numeric GitHub user id.");
  }

  const usernamePattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
  if (
    !usernamePattern.test(result.githubUsername)
    || result.githubUsername.includes("--")
  ) {
    throw new Error("--github-username is not a valid GitHub username.");
  }

  if (!result.target) {
    throw new Error("Choose exactly one target: --local or --remote.");
  }

  return result;
}

function wranglerArguments(target, sql) {
  const targetArguments = target === "remote"
    ? ["--remote", "--env", "production"]
    : ["--local", "--config", "wrangler.dev.jsonc"];
  return [
    "--no-install",
    "wrangler",
    "d1",
    "execute",
    "DB",
    ...targetArguments,
    "--command",
    sql
  ];
}

function runWrangler(argumentsList) {
  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(executable, argumentsList, { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Wrangler exited with status ${result.status ?? "unknown"}.`);
  }
}

export function ownerInsertSql({ githubUserId, githubUsername }) {
  return "INSERT INTO admins "
    + "(github_user_id, github_username, role, enabled) "
    + `VALUES ('${githubUserId}', '${githubUsername}', 'owner', 1);`;
}

export function ownerVerifySql(githubUserId) {
  return "SELECT github_user_id, github_username, role, enabled "
    + `FROM admins WHERE github_user_id = '${githubUserId}';`;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const insertSql = ownerInsertSql(options);

  console.log(`Target: ${options.target}`);
  console.log(`GitHub numeric user id: ${options.githubUserId}`);
  console.log(`GitHub username (display only): ${options.githubUsername}`);
  console.log("Role: owner; enabled: true");

  if (!options.execute) {
    console.log("Preview only. Add --execute after confirming the target and id.");
    return;
  }

  runWrangler(wranglerArguments(options.target, insertSql));
  runWrangler(wranglerArguments(
    options.target,
    ownerVerifySql(options.githubUserId)
  ));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    console.error(usage);
    process.exitCode = 1;
  }
}
