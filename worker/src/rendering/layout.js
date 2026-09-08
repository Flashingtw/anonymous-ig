import { RenderError } from "./errors.js";
import { countGraphemes } from "./graphemes.js";
import { formatClassicPostNumber } from "./templates/classic-canva.js";
import { wrapMeasuredText } from "./wrap.js";

function fontSizes(defaultSize, minSize, step) {
  const sizes = [];
  for (let size = defaultSize; size >= minSize; size -= step) {
    sizes.push(size);
  }
  if (sizes.at(-1) !== minSize) {
    sizes.push(minSize);
  }
  return sizes;
}

function yOffsetForLineCount(offsets, lineCount) {
  return offsets[lineCount] ?? offsets.default ?? 0;
}

function visibleWidth(measurement) {
  return Math.max(measurement.advanceWidth, measurement.bounds.width);
}

export function layoutPostNumber(id, font, config) {
  const label = formatClassicPostNumber(id);
  if (!font.supports(label)) {
    throw new RenderError(
      "RENDER_UNSUPPORTED_GLYPH",
      "Anton 字型無法顯示投稿編號。"
    );
  }

  const origin = font.outline(label, 0, 0, config.fontSize);
  const translateX = config.centerX - (origin.bounds.x1 + origin.bounds.x2) / 2;
  const translateY = config.centerY - (origin.bounds.y1 + origin.bounds.y2) / 2;

  return {
    label,
    fontSize: config.fontSize,
    pathData: origin.pathData,
    translateX,
    translateY,
    visibleBounds: {
      x1: origin.bounds.x1 + translateX,
      x2: origin.bounds.x2 + translateX,
      y1: origin.bounds.y1 + translateY,
      y2: origin.bounds.y2 + translateY
    }
  };
}

export function layoutContent(text, font, config) {
  const normalized = String(text).replace(/\r\n?/g, "\n");
  const graphemeCount = countGraphemes(normalized);
  if (graphemeCount > config.maxGraphemes) {
    throw new RenderError(
      "CONTENT_TOO_LONG_TO_RENDER",
      "投稿內容超過 classic template 可顯示的長度。",
      { maxGraphemes: config.maxGraphemes, actualGraphemes: graphemeCount }
    );
  }
  if (!font.supports(normalized)) {
    throw new RenderError(
      "RENDER_UNSUPPORTED_GLYPH",
      "投稿含有目前正式字型無法顯示的字元。"
    );
  }

  const measurementCache = new Map();
  for (const fontSize of fontSizes(
    config.defaultFontSize,
    config.minFontSize,
    config.fontStep
  )) {
    const measure = (value) => {
      const key = `${fontSize}\u0000${value}`;
      if (!measurementCache.has(key)) {
        measurementCache.set(key, font.measure(value, fontSize));
      }
      return measurementCache.get(key);
    };
    const lines = wrapMeasuredText(
      normalized,
      config.maxWidth,
      (value) => visibleWidth(measure(value))
    );
    const lineAdvance = fontSize * config.lineHeight;
    const blockHeight = lines.length * lineAdvance;
    const widthsFit = lines.every((line) => visibleWidth(measure(line)) <= config.maxWidth);
    if (!widthsFit || blockHeight > config.maxHeight) {
      continue;
    }

    const metrics = font.metrics(fontSize);
    const leading = Math.max(0, lineAdvance - metrics.ascent - metrics.descent);
    const centerY = config.centerY
      + yOffsetForLineCount(config.lineCountYOffset, lines.length);
    const blockTop = centerY - blockHeight / 2;
    const firstBaseline = blockTop + leading / 2 + metrics.ascent;
    const positionedLines = lines.map((line, index) => {
      const baselineY = firstBaseline + index * lineAdvance;
      if (!line) {
        return { text: line, baselineY, pathData: "", translateX: 0 };
      }
      const origin = font.outline(line, 0, baselineY, fontSize);
      const translateX = config.centerX
        - (origin.bounds.x1 + origin.bounds.x2) / 2;
      return {
        text: line,
        baselineY,
        pathData: origin.pathData,
        translateX
      };
    });

    return {
      fontSize,
      graphemeCount,
      lines: positionedLines,
      lineAdvance,
      blockHeight,
      centerY
    };
  }

  throw new RenderError(
    "CONTENT_TOO_LONG_TO_RENDER",
    "投稿內容在最小字級仍無法放入 classic template。",
    { maxGraphemes: config.maxGraphemes, actualGraphemes: graphemeCount }
  );
}
