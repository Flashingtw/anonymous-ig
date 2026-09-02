import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "../worker/src/errors.js";
import {
  MAX_CONTENT_LENGTH,
  parseJsonBody,
  parseLimit,
  parsePositiveInteger,
  validateSubmissionContent
} from "../worker/src/validation.js";

test("validates and trims normal submission content", () => {
  assert.equal(validateSubmissionContent("  匿名內容  "), "匿名內容");
});

test("accepts content exactly at the character limit", () => {
  const value = "字".repeat(MAX_CONTENT_LENGTH);
  assert.equal(validateSubmissionContent(value), value);
});

test("counts emoji by Unicode code point", () => {
  const value = "🙂".repeat(MAX_CONTENT_LENGTH);
  assert.equal(validateSubmissionContent(value), value);
});

test("rejects blank, non-string, and over-limit content", () => {
  for (const [value, code] of [
    ["  \n ", "EMPTY_CONTENT"],
    [42, "INVALID_CONTENT"],
    ["字".repeat(MAX_CONTENT_LENGTH + 1), "CONTENT_TOO_LONG"]
  ]) {
    assert.throws(
      () => validateSubmissionContent(value),
      (error) => error instanceof HttpError && error.code === code
    );
  }
});

test("parses an object JSON body and rejects unexpected fields", async () => {
  const validRequest = new Request("http://localhost/api/submissions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "hello" })
  });
  assert.deepEqual(await parseJsonBody(validRequest), { content: "hello" });

  const invalidRequest = new Request("http://localhost/api/submissions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "hello", status: "approved" })
  });
  await assert.rejects(
    () => parseJsonBody(invalidRequest),
    (error) => error.code === "UNEXPECTED_FIELDS"
  );
});

test("rejects the wrong content type, invalid JSON, and oversized bodies", async () => {
  const cases = [
    [
      new Request("http://localhost", { method: "POST", body: "{}" }),
      "UNSUPPORTED_MEDIA_TYPE"
    ],
    [
      new Request("http://localhost", {
        method: "POST",
        headers: { "Content-Type": "application/jsonp" },
        body: "{}"
      }),
      "UNSUPPORTED_MEDIA_TYPE"
    ],
    [
      new Request("http://localhost", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{broken"
      }),
      "INVALID_JSON"
    ],
    [
      new Request("http://localhost", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(17 * 1024)
      }),
      "PAYLOAD_TOO_LARGE"
    ]
  ];

  for (const [request, code] of cases) {
    await assert.rejects(() => parseJsonBody(request), (error) => error.code === code);
  }
});

test("validates IDs and clamps list limit", () => {
  assert.equal(parsePositiveInteger("12"), 12);
  assert.equal(parseLimit(null), 50);
  assert.equal(parseLimit("500"), 100);
  assert.throws(() => parsePositiveInteger("0"), (error) => error.code === "INVALID_ID");
  assert.throws(() => parsePositiveInteger("1.5"), (error) => error.code === "INVALID_ID");
});
