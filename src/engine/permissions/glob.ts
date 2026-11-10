// The two matchers of the permission engine: path globs (in the SDK, for a repository's code too), and command patterns.

export { globToRegExp, matchesGlob } from '../../sdk/globs';

/**
 * A command pattern as a regular expression over a command's words: `*` matches any run of characters, and a
 * trailing ` *` also matches no arguments at all, so `git status *` allows `git status`. Matched whole.
 */
export function commandPatternToRegExp(pattern: string): RegExp {
  const open = pattern.endsWith(' *');
  const head = open ? pattern.slice(0, -2) : pattern;
  const body = head.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '.*');
  return new RegExp(open ? `^${body}(?: .*)?$` : `^${body}$`, 's');
}

/** Whether any of `patterns` matches the command text. */
export function matchesCommand(text: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => commandPatternToRegExp(pattern).test(text));
}
