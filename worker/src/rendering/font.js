import opentype from "opentype.js";

import { RenderError } from "./errors.js";
import { splitGraphemes } from "./graphemes.js";

function exactArrayBuffer(bytes) {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}

function pathBounds(path) {
  const box = path.getBoundingBox();
  return {
    x1: box.x1,
    y1: box.y1,
    x2: box.x2,
    y2: box.y2,
    width: box.x2 - box.x1,
    height: box.y2 - box.y1
  };
}

export function createOpenTypeFont(bytes, { family }) {
  let font;
  try {
    font = opentype.parse(exactArrayBuffer(bytes));
  } catch {
    throw new RenderError(
      "RENDER_FONT_INVALID",
      `${family} 字型檔無法解析。`,
      { fontFamily: family }
    );
  }

  function path(text, x, y, fontSize) {
    return font.getPath(text, x, y, fontSize, {
      kerning: true,
      features: { liga: true, rlig: true }
    });
  }

  return Object.freeze({
    family,
    supports(text) {
      return splitGraphemes(text).every((grapheme) => {
        if (/^\s+$/u.test(grapheme)) {
          return true;
        }
        if (grapheme.includes("\u200d")) {
          return false;
        }
        return Array.from(grapheme).every((character) => {
          const codePoint = character.codePointAt(0);
          if (codePoint === 0xfe0f || codePoint === 0xfe0e) {
            return true;
          }
          return font.charToGlyphIndex(character) !== 0;
        });
      });
    },
    metrics(fontSize) {
      const scale = fontSize / font.unitsPerEm;
      return {
        ascent: font.ascender * scale,
        descent: Math.abs(font.descender * scale)
      };
    },
    measure(text, fontSize) {
      const textPath = path(text, 0, 0, fontSize);
      return {
        advanceWidth: font.getAdvanceWidth(text, fontSize, { kerning: true }),
        bounds: pathBounds(textPath)
      };
    },
    outline(text, x, y, fontSize) {
      const textPath = path(text, x, y, fontSize);
      return {
        bounds: pathBounds(textPath),
        pathData: textPath.toPathData({
          decimalPlaces: 2,
          optimize: true,
          flipY: false
        })
      };
    }
  });
}
