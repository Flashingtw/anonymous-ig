import { initWasm, Resvg } from "@resvg/resvg-wasm";
import wasm from "@resvg/resvg-wasm/index_bg.wasm";

import { createResvgRasterizer } from "../resvg.js";

let initialization;

export async function createWorkerResvgRasterizer() {
  initialization ??= initWasm(wasm);
  await initialization;
  return createResvgRasterizer(Resvg);
}
