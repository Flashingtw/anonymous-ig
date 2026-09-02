import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const roots = ["worker/src", "frontend/assets", "scripts", "test"];
const files = [];

function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      collect(path);
    } else if (entry.isFile() && (path.endsWith(".js") || path.endsWith(".mjs"))) {
      files.push(path);
    }
  }
}

for (const root of roots) {
  collect(root);
}

for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

JSON.parse(readFileSync("frontend/content.json", "utf8"));

console.log(`Syntax check passed for ${files.length} JavaScript files and frontend/content.json.`);
