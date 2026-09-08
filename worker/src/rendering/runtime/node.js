import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { initWasm, Resvg } from "@resvg/resvg-wasm";

import { createResvgRasterizer } from "../resvg.js";

let initialization;

export async function createNodeResvgRasterizer() {
  initialization ??= (async () => {
    const wasmUrl = import.meta.resolve("@resvg/resvg-wasm/index_bg.wasm");
    const bytes = await readFile(fileURLToPath(wasmUrl));
    await initWasm(bytes);
  })();
  await initialization;
  return createResvgRasterizer(Resvg);
}
