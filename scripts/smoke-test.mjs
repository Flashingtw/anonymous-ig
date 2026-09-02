import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8787";

function readDevVariable(name) {
  try {
    const contents = readFileSync(".dev.vars", "utf8");
    const line = contents
      .split(/\r?\n/)
      .find((candidate) => candidate.trim().startsWith(`${name}=`));
    if (!line) {
      return "";
    }

    return line
      .slice(line.indexOf("=") + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
  } catch {
    return "";
  }
}

const adminToken = process.env.DEV_ADMIN_TOKEN || readDevVariable("DEV_ADMIN_TOKEN");

if (!adminToken) {
  throw new Error("Set DEV_ADMIN_TOKEN before running the smoke test.");
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const payload = response.status === 204 ? null : await response.json();
  return { response, payload };
}

const created = await request("/api/submissions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ content: "本機 smoke test 投稿 <script>不應執行</script>" })
});
assert.equal(created.response.status, 201);
assert.equal(created.payload.data.submission.status, "pending");
const id = created.payload.data.submission.id;

const unauthorized = await request("/api/admin/submissions");
assert.equal(unauthorized.response.status, 401);

const unauthorizedApprove = await request(`/api/admin/submissions/${id}/approve`, {
  method: "POST"
});
assert.equal(unauthorizedApprove.response.status, 401);

const authHeaders = { Authorization: `Bearer ${adminToken}` };
const listed = await request("/api/admin/submissions", { headers: authHeaders });
assert.equal(listed.response.status, 200);
const storedSubmission = listed.payload.data.submissions.find((submission) => submission.id === id);
assert.equal(storedSubmission.content, "本機 smoke test 投稿 <script>不應執行</script>");

const approved = await request(`/api/admin/submissions/${id}/approve`, {
  method: "POST",
  headers: authHeaders
});
assert.equal(approved.response.status, 200);
assert.equal(approved.payload.data.submission.status, "approved");

const duplicate = await request(`/api/admin/submissions/${id}/reject`, {
  method: "POST",
  headers: authHeaders
});
assert.equal(duplicate.response.status, 409);

const rejectCandidate = await request("/api/submissions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ content: "這篇用來驗證 reject endpoint。" })
});
assert.equal(rejectCandidate.response.status, 201);

const rejected = await request(
  `/api/admin/submissions/${rejectCandidate.payload.data.submission.id}/reject`,
  { method: "POST", headers: authHeaders }
);
assert.equal(rejected.response.status, 200);
assert.equal(rejected.payload.data.submission.status, "rejected");

const afterModeration = await request("/api/admin/submissions", { headers: authHeaders });
assert.ok(!afterModeration.payload.data.submissions.some((submission) => (
  submission.id === id || submission.id === rejectCandidate.payload.data.submission.id
)));

const missing = await request("/api/admin/submissions/999999999/approve", {
  method: "POST",
  headers: authHeaders
});
assert.equal(missing.response.status, 404);

const invalidId = await request("/api/admin/submissions/not-an-id/reject", {
  method: "POST",
  headers: authHeaders
});
assert.equal(invalidId.response.status, 400);

const raceCandidate = await request("/api/submissions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ content: "這篇用來驗證並行審核只會成功一次。" })
});
const raceId = raceCandidate.payload.data.submission.id;
const raceResults = await Promise.all([
  request(`/api/admin/submissions/${raceId}/approve`, { method: "POST", headers: authHeaders }),
  request(`/api/admin/submissions/${raceId}/reject`, { method: "POST", headers: authHeaders })
]);
assert.deepEqual(
  raceResults.map(({ response }) => response.status).sort(),
  [200, 409]
);

const invalid = await request("/api/submissions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ content: " " })
});
assert.equal(invalid.response.status, 400);

const wrongMethod = await request("/api/submissions");
assert.equal(wrongMethod.response.status, 405);
assert.equal(wrongMethod.response.headers.get("Allow"), "POST");

console.log(
  `Smoke test passed for submissions #${id}, #${rejectCandidate.payload.data.submission.id}, and #${raceId}.`
);
