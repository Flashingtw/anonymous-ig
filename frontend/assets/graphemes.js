// Shared by browser and Worker; extracted from the existing password counter.
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemeLength(value) {
  return [...segmenter.segment(value)].length;
}
