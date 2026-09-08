import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryImageStorage,
  resolveImageStorage
} from "../worker/src/storage/image-storage.js";

test("memory image storage clones bytes and supports put/get/delete", async () => {
  const storage = new MemoryImageStorage();
  const original = new Uint8Array([1, 2, 3]);
  await storage.put("preview.png", original, { contentType: "image/png" });
  original[0] = 9;

  const first = await storage.get("preview.png");
  assert.deepEqual([...first.bytes], [1, 2, 3]);
  first.bytes[1] = 9;
  assert.deepEqual([...(await storage.get("preview.png")).bytes], [1, 2, 3]);

  await storage.delete("preview.png");
  assert.equal(await storage.get("preview.png"), null);
});

test("production image storage fails closed without an R2 binding", () => {
  assert.throws(
    () => resolveImageStorage({ APP_ENV: "production" }),
    (error) => error.code === "IMAGE_STORAGE_NOT_CONFIGURED"
  );
});
