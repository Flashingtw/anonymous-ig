import assert from "node:assert/strict";
import test from "node:test";

import { loadClassicCanvaAssets } from "../worker/src/rendering/assets.js";
import { RenderError } from "../worker/src/rendering/errors.js";
import { countGraphemes } from "../worker/src/rendering/graphemes.js";
import {
  classicCanvaTemplate,
  formatClassicPostNumber
} from "../worker/src/rendering/templates/classic-canva.js";

test("classic post numbers pad to three digits without truncating", () => {
  assert.equal(formatClassicPostNumber(1), "#001");
  assert.equal(formatClassicPostNumber(5), "#005");
  assert.equal(formatClassicPostNumber(79), "#079");
  assert.equal(formatClassicPostNumber(123), "#123");
  assert.equal(formatClassicPostNumber(999), "#999");
  assert.equal(formatClassicPostNumber(1000), "#1000");
});

test("classic template keeps the requested visible number center in config", () => {
  assert.equal(classicCanvaTemplate.id, "classic-canva");
  assert.equal(classicCanvaTemplate.postNumber.centerX, 403);
  assert.equal(classicCanvaTemplate.postNumber.centerY, 319);
  assert.equal(classicCanvaTemplate.postNumber.fontStyle, "Regular");
  assert.equal(classicCanvaTemplate.postNumber.font.allowSyntheticBold, false);
  assert.equal(classicCanvaTemplate.postNumber.font.allowFallback, false);
  assert.equal(classicCanvaTemplate.content.font.allowFallback, false);
});

test("grapheme counting keeps composed emoji and combining text together", () => {
  assert.equal(countGraphemes("大安A1"), 4);
  assert.equal(countGraphemes("👨‍👩‍👧‍👦"), 1);
  assert.equal(countGraphemes("👍🏽"), 1);
  assert.equal(countGraphemes("e\u0301"), 1);
});

test("classic asset loading refuses to hide a missing formal content font", async () => {
  const available = new Map([
    [classicCanvaTemplate.background.assetPath, new Uint8Array([1])],
    [classicCanvaTemplate.postNumber.font.assetPath, new Uint8Array([2])]
  ]);

  await assert.rejects(
    () => loadClassicCanvaAssets(async (assetPath) => available.get(assetPath)),
    (error) => {
      assert.ok(error instanceof RenderError);
      assert.equal(error.code, "RENDER_FONT_ASSET_MISSING");
      assert.equal(error.details.fontFamily, "可畫錦繡體-繁");
      assert.equal(
        error.details.assetPath,
        "assets/fonts/KeHuaJinXiuTi-Traditional.ttf"
      );
      return true;
    }
  );
});
