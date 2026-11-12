// review: reads a pull request body's Demonstration section. Its workflow skips the demonstrate agent when the section
// says there is no surface, and hands the section's text on as the reason nothing was shown.

/** The section's text, trimmed and without its heading, when it starts with `none` or `Surface: none`; else null. */
export function noSurface(body: string): string | null {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Demonstration\s*$/i.test(line));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  const text = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
  return /^\W*(surface\W*)?none\b/i.test(text) ? text : null;
}
