// The two matchers of the permission engine: path globs, and command patterns.
// STUB (tdd-plan): every matcher matches nothing. TASK-003 ports them.

/**
 * A glob as a regular expression over a `/`-separated relative path: `*` matches within one segment, `**` across
 * segments, `**\/` any directories or none, `?` one character but `/`. Everything else is literal, braces included.
 */
export function globToRegExp(_glob: string): RegExp {
  return /(?!)/;
}

/** Whether any of `globs` matches the relative path. */
export function matchesGlob(relPath: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(relPath));
}

/**
 * A command pattern as a regular expression over a command's words: `*` matches any run of characters, and a
 * trailing ` *` also matches no arguments at all, so `git status *` allows `git status`. Matched whole.
 */
export function commandPatternToRegExp(_pattern: string): RegExp {
  return /(?!)/;
}

/** Whether any of `patterns` matches the command text. */
export function matchesCommand(text: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => commandPatternToRegExp(pattern).test(text));
}
