function number(value) {
  return Number(value.toFixed(3));
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.byteLength; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function composeClassicSvg(template, background, postNumber, contentLayout) {
  const contentPaths = contentLayout.lines
    .filter((line) => line.pathData)
    .map((line) => `
      <g transform="translate(${number(line.translateX)} 0)">
        <path d="${line.pathData}" fill="${template.content.color}"/>
      </g>`)
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${template.width}" height="${template.height}" viewBox="0 0 ${template.width} ${template.height}">
      <image href="data:image/png;base64,${bytesToBase64(background)}" x="0" y="0" width="${template.width}" height="${template.height}"/>
      <g transform="translate(${number(postNumber.translateX)} ${number(postNumber.translateY)})">
        <path d="${postNumber.pathData}" fill="${template.postNumber.color}"/>
      </g>${contentPaths}
    </svg>`;
}
