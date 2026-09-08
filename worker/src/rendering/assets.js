import { RenderError } from "./errors.js";
import { classicCanvaTemplate } from "./templates/classic-canva.js";

function asBytes(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

async function requireBinaryAsset(readBinary, assetPath, { type, family } = {}) {
  let value;
  try {
    value = await readBinary(assetPath);
  } catch {
    value = null;
  }

  const bytes = asBytes(value);
  if (bytes?.byteLength) {
    return bytes;
  }

  const isFont = type === "font";
  throw new RenderError(
    isFont ? "RENDER_FONT_ASSET_MISSING" : "RENDER_BACKGROUND_ASSET_MISSING",
    isFont
      ? `需要提供 ${family} 的合法字型檔。`
      : "找不到 classic Canva 正式底圖。",
    { assetPath, ...(family ? { fontFamily: family } : {}) }
  );
}

export async function loadClassicCanvaAssets(
  readBinary,
  template = classicCanvaTemplate
) {
  if (typeof readBinary !== "function") {
    throw new TypeError("readBinary must be a function.");
  }

  // No fallback is attempted here. The caller must supply every exact asset
  // selected by the production template.
  const background = await requireBinaryAsset(
    readBinary,
    template.background.assetPath,
    { type: "background" }
  );

  // Load the formal content font first so a repository missing both fonts
  // always reports the user-facing blocking asset deterministically.
  const contentFont = await requireBinaryAsset(
    readBinary,
    template.content.font.assetPath,
    { type: "font", family: template.content.fontFamily }
  );
  const postNumberFont = await requireBinaryAsset(
    readBinary,
    template.postNumber.font.assetPath,
    { type: "font", family: template.postNumber.fontFamily }
  );

  return freezeAssets({ background, postNumberFont, contentFont });
}

function freezeAssets(assets) {
  return Object.freeze(assets);
}
