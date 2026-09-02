import { readFileSync, writeFileSync } from "node:fs";

const content = JSON.parse(readFileSync("frontend/content.json", "utf8"));

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const title = escapeXml(content.social?.title ?? content.site?.brandName ?? "匿名投稿");
const description = escapeXml(content.social?.description ?? "");
const mark = escapeXml(content.site?.brandMark ?? "匿");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="title description">
  <title id="title">${title}</title>
  <desc id="description">${description}</desc>
  <rect width="1200" height="630" fill="#f4f1ea"/>
  <rect x="30" y="30" width="1140" height="570" rx="20" fill="none" stroke="#215c4e" stroke-width="2"/>
  <g fill="#1d2523" font-family="-apple-system, BlinkMacSystemFont, 'Noto Sans TC', sans-serif">
    <text x="88" y="294" font-size="64" font-weight="650" letter-spacing="2">${title}</text>
    <text x="90" y="350" font-size="28" font-weight="400" fill="#65706c">${description}</text>
  </g>
  <circle cx="1060" cy="315" r="48" fill="#215c4e"/>
  <text x="1060" y="330" text-anchor="middle" fill="#fffdf8" font-family="'Noto Serif TC', serif" font-size="38">${mark}</text>
</svg>
`;

writeFileSync("frontend/og-editable.svg", svg, "utf8");
console.log("Generated frontend/og-editable.svg from frontend/content.json.");
