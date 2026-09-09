import assert from "node:assert/strict";
import test from "node:test";

import { formatText, getContent } from "../frontend/assets/content.js";

test("reads nested editable content with a fallback", () => {
  const content = { publicPage: { title: "可修改標題" } };
  assert.equal(getContent(content, "publicPage.title"), "可修改標題");
  assert.equal(getContent(content, "publicPage.missing", "預設文字"), "預設文字");
});

test("formats known placeholders and preserves unknown ones", () => {
  assert.equal(
    formatText("{current} / {max}", { current: 3, max: 100 }),
    "3 / 100"
  );
  assert.equal(formatText("保留 {unknown}", {}), "保留 {unknown}");
});
