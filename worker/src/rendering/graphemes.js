const segmenter = new Intl.Segmenter("zh-Hant", { granularity: "grapheme" });

export function splitGraphemes(value) {
  return Array.from(segmenter.segment(String(value)), ({ segment }) => segment);
}

export function countGraphemes(value) {
  return splitGraphemes(value).length;
}
