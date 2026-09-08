import { RenderError } from "./errors.js";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function readPngDimensions(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  const valid = bytes.byteLength >= 24
    && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
    && String.fromCharCode(...bytes.slice(12, 16)) === "IHDR";
  if (!valid) {
    throw new RenderError(
      "RENDER_BACKGROUND_ASSET_INVALID",
      "classic Canva 底圖不是有效的 PNG。"
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: view.getUint32(16),
    height: view.getUint32(20)
  };
}
