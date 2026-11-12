// review: reads a pull request body's Demonstration section. Its workflow skips the demonstrate agent when the section
// says there is no surface, and hands the section's first paragraph on as the reason nothing was shown. The text is the
// author's: the ticket comment shows it, and the judge reads NO_SURFACE in its place.

/** The judge's reason for a skipped demonstration: a fixed sentence, since the body's own words are untrusted input. */
export const NO_SURFACE =
  "Not started: the pull request body's Demonstration section says there is no surface. Its words are in the brief.";

/** The most of the section's text the reason keeps. */
const MAX = 300;

/**
 * The section's first paragraph, trimmed, without its heading and cut to 300 characters, when the section starts with
 * `none` or `Surface: none`; else null.
 */
export function noSurface(body: string): string | null {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Demonstration\s*$/i.test(line));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  const text = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
  if (!/^\W*(surface\W*)?none\b/i.test(text)) return null;
  const [first = ''] = text.split(/\n\s*\n/);
  return first.length > MAX ? `${first.slice(0, MAX - 1)}…` : first;
}
