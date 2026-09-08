import { RenderError } from "../rendering/errors.js";

function toBytes(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("Image data must be binary.");
}

export class MemoryImageStorage {
  constructor() {
    this.objects = new Map();
  }

  async put(key, value, { contentType = "image/png" } = {}) {
    const bytes = toBytes(value);
    this.objects.set(key, {
      bytes: bytes.slice(),
      contentType
    });
  }

  async get(key) {
    const object = this.objects.get(key);
    if (!object) {
      return null;
    }
    return {
      bytes: object.bytes.slice(),
      contentType: object.contentType
    };
  }

  async delete(key) {
    this.objects.delete(key);
  }
}

export class R2ImageStorage {
  constructor(bucket) {
    this.bucket = bucket;
  }

  async put(key, value, { contentType = "image/png" } = {}) {
    await this.bucket.put(key, toBytes(value), {
      httpMetadata: { contentType }
    });
  }

  async get(key) {
    const object = await this.bucket.get(key);
    if (!object) {
      return null;
    }
    return {
      bytes: new Uint8Array(await object.arrayBuffer()),
      contentType: object.httpMetadata?.contentType || "image/png"
    };
  }

  async delete(key) {
    await this.bucket.delete(key);
  }
}

const localMemoryStorage = new MemoryImageStorage();

export function resolveImageStorage(env, providedStorage = null) {
  if (providedStorage) {
    return providedStorage;
  }
  if (env.RENDER_IMAGES) {
    return new R2ImageStorage(env.RENDER_IMAGES);
  }
  if (env.APP_ENV === "development") {
    return localMemoryStorage;
  }

  throw new RenderError(
    "IMAGE_STORAGE_NOT_CONFIGURED",
    "圖片儲存尚未設定。"
  );
}
