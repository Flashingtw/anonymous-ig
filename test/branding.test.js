import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const projectRoot = resolve(import.meta.dirname, "..");

test("public and admin surfaces use the DAAN ANONYMOUS brand fallbacks", async () => {
  const [publicHtml, adminHtml, stylesheet, adminScript, content] = await Promise.all([
    readFile(resolve(projectRoot, "frontend/index.html"), "utf8"),
    readFile(resolve(projectRoot, "frontend/admin/index.html"), "utf8"),
    readFile(resolve(projectRoot, "frontend/assets/styles.css"), "utf8"),
    readFile(resolve(projectRoot, "frontend/assets/admin.js"), "utf8"),
    readFile(resolve(projectRoot, "frontend/content.json"), "utf8").then(JSON.parse)
  ]);

  assert.equal(content.site.brandName, "大安匿名");
  assert.equal(content.site.brandEnglish, "DAAN ANONYMOUS");
  assert.equal(content.social.title, "大安匿名｜DAAN ANONYMOUS");
  assert.match(publicHtml, /大安匿名｜DAAN ANONYMOUS/);
  assert.match(publicHtml, /想說什麼，都可以留在這裡。/);
  assert.match(publicHtml, /匿名送出/);
  assert.match(adminHtml, /id="tab-pending"/);
  assert.match(adminHtml, /id="tab-approved"/);
  assert.match(adminHtml, /id="tab-rejected"/);
  assert.match(stylesheet, /--accent: #f36a21/);
  assert.match(stylesheet, /--canvas: #171512/);
  assert.match(adminScript, /\/api\/admin\/submissions\/\$\{submission\.id\}\/render/);
  assert.match(adminScript, /apiBinaryRequest/);
});

test("admin preview CSS preserves the rendered image aspect ratio", async () => {
  const stylesheet = await readFile(
    resolve(projectRoot, "frontend/assets/styles.css"),
    "utf8"
  );
  assert.match(stylesheet, /\.render-preview img[\s\S]*width: min\(100%, 420px\)/);
  assert.match(stylesheet, /\.render-preview img[\s\S]*height: auto/);
  assert.match(stylesheet, /object-fit: contain/);
});
