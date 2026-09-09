import assert from "node:assert/strict";
import test from "node:test";
import { executeSql, normalizeWranglerD1Rows } from "../scripts/manage-admin.js";
import { runCli } from "../scripts/create-access-admin.js";

test("row queries refuse the sensitive file-import path before spawning Wrangler", async () => {
  await assert.rejects(executeSql({ target: "remote", sql: "SELECT 1;", json: true, sensitive: true }, {
    spawn() { assert.fail("must not start import"); },
    sensitiveFile() { assert.fail("must not create an import file"); }
  }), /JSON row queries.*file/);
});

test("single-statement Wrangler JSON returns rows including an empty result", () => {
  assert.deepEqual(normalizeWranglerD1Rows('[{"results":[{"id":1}],"success":true,"meta":{}}]'), [{ id: 1 }]);
  assert.deepEqual(normalizeWranglerD1Rows('[{"results":[],"success":true}]'), []);
});

for (const [name, output] of [
  ["malformed JSON", "not JSON"],
  ["terminal prefix", 'progress\n[{"success":true,"results":[]}]'],
  ["zero statements", "[]"],
  ["multiple statements", '[{"success":true,"results":[]},{"success":true,"results":[]}]'],
  ["failed statement", '[{"success":false,"results":[]}]'],
  ["missing success", '[{"results":[]}]'],
  ["non-boolean success", '[{"success":"true","results":[]}]'],
  ["missing results", '[{"success":true}]'],
  ["non-array results", '[{"success":true,"results":{}}]'],
  ["null envelope", "[null]"],
  ["undocumented bare object", '{"success":true,"results":[{"id":1}]}'],
  ["null payload", "null"],
  ["file-import summary", '[{"success":true,"results":[{"Total queries executed":1}],"finalBookmark":"fixture-not-a-real-bookmark"}]']
]) {
  test(`row parser fails closed on ${name}`, () => {
    assert.throws(() => normalizeWranglerD1Rows(output), /Wrangler query results/);
  });
}

test("create-access dry-run reads query rows, not remote file-import summaries", async () => {
  const messages = [];
  let writes = 0;
  await runCli(["--email", " Friend@Example.com ", "--role", "moderator", "--remote"], {
    query: request => executeSql({ ...request, json: true }, {
      sensitiveFile: async (_sql, callback) => callback("/private/query.sql"),
      spawn: (_executable, args) => ({
        status: 0, stderr: "",
        // Wrangler 4.127.1 remote --file emits progress + import metrics,
        // whereas --command --json returns the SELECT rows.
        stdout: args.includes("--file")
          ? '├ Checking if file needs uploading\n[{"results":[{"Total queries executed":1,"Rows written":0}],"success":true}]'
          : JSON.stringify([{ results: [], success: true, meta: { rows_written: 0 } }])
      }),
      stdout: { write() { assert.fail("query rows must not be printed"); } },
      stderr: { write() {} }
    }),
    execute: async () => { writes += 1; },
    logger: { log: message => messages.push(message) }
  });
  assert.equal(writes, 0);
  assert.match(messages.join("\n"), /friend@example.com/);
  assert.match(messages.join("\n"), /Preview only/);
  assert.match(messages.join("\n"), /INSERT admins.*INSERT audit_logs.*existing admins unchanged/);
});
