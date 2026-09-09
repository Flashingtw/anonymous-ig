import { graphemeLength } from "./graphemes.js";

export const MAX_CONTENT_LENGTH = 100;

// Retain the submission API's existing outer-whitespace normalization.
export function contentLength(value) {
  return graphemeLength(value.trim());
}
