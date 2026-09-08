import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadClassicCanvaAssets } from "../worker/src/rendering/assets.js";
import { RenderError } from "../worker/src/rendering/errors.js";
import { createClassicCanvaRenderer } from "../worker/src/rendering/renderer.js";
import { createNodeResvgRasterizer } from "../worker/src/rendering/runtime/node.js";

const projectRoot = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(projectRoot, "tmp/render-fixtures");

const fixtures = Object.freeze([
  { id: 1, name: "001-short", content: "今天也要好好過日子。" },
  {
    id: 79,
    name: "079-medium-chinese",
    content: "有時候只是想找一個不必說明身分，也能把心裡話好好留下來的地方。"
  },
  { id: 80, name: "080-two-manual-lines", content: "第一行想說的話\n第二行留給明天" },
  { id: 81, name: "081-one-line", content: "放學後一起去吃飯嗎？" },
  { id: 82, name: "082-three-lines", content: "第一件事\n第二件事\n最後一件事" },
  { id: 83, name: "083-four-lines", content: "一行\n兩行\n三行\n四行" },
  {
    id: 84,
    name: "084-five-plus-lines",
    content: "今天的風很大\n操場還是很多人\n有人練球\n有人聊天\n也有人只是坐著\n等一天慢慢結束"
  },
  { id: 85, name: "085-mixed", content: "DAAN 的今天 100% 忙碌，但還是想說：辛苦了。" },
  { id: 86, name: "086-emoji", content: "考完了！🎉 明天一起吃早餐嗎？☀️" },
  {
    id: 87,
    name: "087-near-limit",
    content: "這是一段接近模板上限的固定測試內容，用來確認中文字寬、標點、中英混排 DAAN 2026、換行與最小字級仍然清楚可讀。請讓每一行保持平衡，不要因為內容較長就縮得太小，也不要超出白紙的安全範圍。最後一段用來觀察底部留白與整體視覺中心。"
  }
]);

async function readBinary(assetPath) {
  try {
    return new Uint8Array(await readFile(resolve(projectRoot, assetPath)));
  } catch {
    return null;
  }
}

async function main() {
  const assets = await loadClassicCanvaAssets(readBinary);
  const rasterize = await createNodeResvgRasterizer();
  const renderer = createClassicCanvaRenderer({ assets, rasterize });

  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });

  for (const fixture of fixtures) {
    const result = await renderer.render(fixture);
    await writeFile(
      resolve(outputDirectory, `${fixture.name}.png`),
      result.bytes
    );
  }

  console.log(`Rendered ${fixtures.length} deterministic fixtures to ${outputDirectory}.`);
}

main().catch((error) => {
  if (error instanceof RenderError && error.code === "RENDER_FONT_ASSET_MISSING") {
    console.error(error.message);
    console.error(`請將合法字型檔放到：${error.details.assetPath}`);
  } else {
    console.error(error instanceof Error ? error.message : "Fixture render failed.");
  }
  process.exitCode = 1;
});
