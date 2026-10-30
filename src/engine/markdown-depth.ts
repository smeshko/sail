// Bun.markdown is quadratic in nesting on some shapes (`- - - … x` takes 592 ms at 32 KiB), so a text is measured here
// in one linear pass before anything hands it to Bun, and a text nested too deep is never parsed.

/** The most container levels (list items and block quotes) a text may nest to be parsed as markdown. */
export const MAX_MARKDOWN_DEPTH = 64;

const isBlank = (code: number) => code === 0x20 || code === 0x09;
const isLineEnd = (code: number) => code === 0x0a || code === 0x0d || Number.isNaN(code);
const isDigit = (code: number) => code >= 0x30 && code <= 0x39;

/**
 * An upper bound on how deep any line of `text` nests its containers: half its leading indentation in columns (a tab
 * to the next multiple of 4), plus the block quote and list markers it opens in a row. It is not a parse: it
 * over-counts a line in fenced code, and never under-counts what `Bun.markdown` builds.
 */
export function markdownDepth(text: string): number {
  let deepest = 0;
  let i = 0;
  while (i < text.length) {
    let columns = 0;
    for (; isBlank(text.charCodeAt(i)); i++) columns += text.charCodeAt(i) === 0x09 ? 4 - (columns % 4) : 1;
    let depth = columns >> 1;
    for (;;) {
      const code = text.charCodeAt(i);
      let next = i + 1;
      if (code === 0x3e) {
        // A block quote's `>` needs nothing after it.
      } else if (code === 0x2d || code === 0x2a || code === 0x2b) {
        if (!isBlank(text.charCodeAt(next)) && !isLineEnd(text.charCodeAt(next))) break;
      } else if (isDigit(code)) {
        while (isDigit(text.charCodeAt(next))) next++;
        const mark = text.charCodeAt(next);
        if (next - i > 9 || (mark !== 0x2e && mark !== 0x29)) break;
        next++;
        if (!isBlank(text.charCodeAt(next)) && !isLineEnd(text.charCodeAt(next))) break;
      } else break;
      depth++;
      i = next;
      while (isBlank(text.charCodeAt(i))) i++;
    }
    if (depth > deepest) deepest = depth;
    while (i < text.length && !isLineEnd(text.charCodeAt(i))) i++;
    i++;
  }
  return deepest;
}
