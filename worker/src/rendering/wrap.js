import { splitGraphemes } from "./graphemes.js";

const wordSegmenter = new Intl.Segmenter("zh-Hant", { granularity: "word" });
const CJK_GRAPHEME = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const OPENING_PUNCTUATION = /^[（〔［｛〈《「『【“‘(\[{]$/u;
const CLOSING_PUNCTUATION = /^[）〕］｝〉》」』】。，、！？：；％…,.!?%:;)'\]}]$/u;

function graphemeOffsets(graphemes) {
  const offsets = [0];
  for (const grapheme of graphemes) {
    offsets.push(offsets.at(-1) + grapheme.length);
  }
  return offsets;
}

function legalBreaks(text, graphemes) {
  const offsets = graphemeOffsets(graphemes);
  const offsetToIndex = new Map(offsets.map((offset, index) => [offset, index]));
  const breaks = new Set([graphemes.length]);

  for (const segment of wordSegmenter.segment(text)) {
    const index = offsetToIndex.get(segment.index + segment.segment.length);
    if (index !== undefined) {
      breaks.add(index);
    }
  }

  graphemes.forEach((grapheme, index) => {
    if (/^\s+$/u.test(grapheme) || CJK_GRAPHEME.test(grapheme)) {
      breaks.add(index + 1);
    }
  });

  for (const index of [...breaks]) {
    const previous = graphemes[index - 1] ?? "";
    const next = graphemes[index] ?? "";
    if (OPENING_PUNCTUATION.test(previous) || CLOSING_PUNCTUATION.test(next)) {
      breaks.delete(index);
    }
  }

  return breaks;
}

function wrapManualLine(text, maxWidth, measureWidth) {
  if (text === "") {
    return [""];
  }

  const graphemes = splitGraphemes(text);
  const breaks = legalBreaks(text, graphemes);
  const lines = [];
  let start = 0;

  while (start < graphemes.length) {
    let furthest = start;
    for (let end = start + 1; end <= graphemes.length; end += 1) {
      const candidate = graphemes.slice(start, end).join("");
      if (measureWidth(candidate) <= maxWidth) {
        furthest = end;
      } else {
        break;
      }
    }

    if (furthest === start) {
      furthest = start + 1;
    }

    let end = furthest;
    if (furthest < graphemes.length) {
      for (let candidate = furthest; candidate > start; candidate -= 1) {
        if (breaks.has(candidate)) {
          end = candidate;
          break;
        }
      }
    }

    lines.push(graphemes.slice(start, end).join(""));
    start = end;
  }

  return lines;
}

export function wrapMeasuredText(text, maxWidth, measureWidth) {
  const normalized = String(text).replace(/\r\n?/g, "\n");
  return normalized
    .split("\n")
    .flatMap((manualLine) => wrapManualLine(manualLine, maxWidth, measureWidth));
}
