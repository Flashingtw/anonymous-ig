import assert from "node:assert/strict";
import test from "node:test";

import { RenderError } from "../worker/src/rendering/errors.js";
import { splitGraphemes } from "../worker/src/rendering/graphemes.js";
import { layoutContent, layoutPostNumber } from "../worker/src/rendering/layout.js";
import { classicCanvaTemplate } from "../worker/src/rendering/templates/classic-canva.js";
import { wrapMeasuredText } from "../worker/src/rendering/wrap.js";

function testFont({ widthFactor = 0.72 } = {}) {
  const width = (text, fontSize) => splitGraphemes(text).length * fontSize * widthFactor;
  return {
    supports: () => true,
    metrics(fontSize) {
      return { ascent: fontSize * 0.8, descent: fontSize * 0.2 };
    },
    measure(text, fontSize) {
      const measuredWidth = width(text, fontSize);
      return {
        advanceWidth: measuredWidth,
        bounds: { x1: 0, x2: measuredWidth, y1: -fontSize * 0.8, y2: fontSize * 0.2, width: measuredWidth, height: fontSize }
      };
    },
    outline(text, x, y, fontSize) {
      const measuredWidth = width(text, fontSize);
      return {
        pathData: `M${x} ${y}h${measuredWidth}`,
        bounds: {
          x1: x,
          x2: x + measuredWidth,
          y1: y - fontSize * 0.8,
          y2: y + fontSize * 0.2,
          width: measuredWidth,
          height: fontSize
        }
      };
    }
  };
}

test("post number visible outline stays centered for changing widths", () => {
  for (const id of [1, 79, 123, 999, 1000]) {
    const layout = layoutPostNumber(id, testFont(), classicCanvaTemplate.postNumber);
    assert.equal((layout.visibleBounds.x1 + layout.visibleBounds.x2) / 2, 403);
    assert.equal((layout.visibleBounds.y1 + layout.visibleBounds.y2) / 2, 319);
  }
});

test("measured wrapping preserves manual newlines and empty lines", () => {
  const lines = wrapMeasuredText(
    "大安 ABCD\n\n第二段",
    4,
    (value) => splitGraphemes(value).length
  );
  assert.deepEqual(lines, ["大安 ", "ABCD", "", "第二段"]);
});

test("content layout shrinks by configured steps and centers the full block", () => {
  const config = {
    ...classicCanvaTemplate.content,
    maxWidth: 220,
    maxHeight: 260,
    defaultFontSize: 70,
    minFontSize: 40,
    fontStep: 5,
    maxGraphemes: 100
  };
  const layout = layoutContent("這是一段需要自動換行的中文內容", testFont(), config);
  assert.ok(layout.fontSize < config.defaultFontSize);
  assert.ok(layout.fontSize >= config.minFontSize);
  assert.ok(layout.blockHeight <= config.maxHeight);
  assert.ok(layout.lines.length > 1);
  assert.equal(
    layout.centerY,
    config.centerY + (config.lineCountYOffset[layout.lines.length] ?? config.lineCountYOffset.default)
  );
});

test("content layout rejects grapheme overflow before making text unreadable", () => {
  assert.throws(
    () => layoutContent("👍🏽".repeat(4), testFont(), {
      ...classicCanvaTemplate.content,
      maxGraphemes: 3
    }),
    (error) => error instanceof RenderError
      && error.code === "CONTENT_TOO_LONG_TO_RENDER"
      && error.details.actualGraphemes === 4
  );
});
