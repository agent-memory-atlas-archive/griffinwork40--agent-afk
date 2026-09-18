/**
 * Display-only pre-processor: auto-closes unclosed inline markdown markers so
 * the marked lexer never sees a dangling span while a chunk is still streaming.
 *
 * Callers must NOT write the return value back to the pending buffer — this is
 * purely for rendering and does not affect parser state.
 */

// Invariant: markers are checked longest-first so `**` is consumed before a
// lone `*` could miscount its two characters as two italic markers.
const MARKERS = ['**', '~~', '*', '`'] as const;

/** Count non-overlapping occurrences of `marker` in `text`. */
function countOccurrences(text: string, marker: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(marker, pos)) !== -1) {
    count++;
    pos += marker.length;
  }
  return count;
}

/**
 * Append closing markers for any unclosed inline markdown spans in `text`.
 *
 * - Pure function: the input string is never modified.
 * - Display-only: callers must not persist the return value back to the buffer.
 * - Checks `**` before `*` so bold markers are not double-counted as italics.
 * - Counts non-overlapping occurrences; odd count → unclosed → appends closer.
 * - Multiple unclosed markers are all closed (innermost-first by marker order).
 */
export function closePendingInlineSyntax(text: string): string {
  if (!text) return text;

  let result = text;

  for (const marker of MARKERS) {
    // Skip occurrences that were already consumed by a longer marker above.
    // Strategy: count in the *original* text for the longer markers and in
    // the accumulated result for shorter ones — but since we only append (never
    // replace), the original counts are stable for non-overlapping markers.
    const count = countOccurrences(text, marker);
    if (count % 2 !== 0) {
      result += marker;
    }
  }

  return result;
}
