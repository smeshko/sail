// The two matchers of the permission engine: path globs, and command patterns.

/**
 * A glob as a regular expression over a `/`-separated relative path: `*` matches within one segment, `**` across
 * segments, `**\/` any directories or none, `?` one character but `/`. Everything else is literal, braces included.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/** Whether any of `globs` matches the relative path. */
export function matchesGlob(relPath: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(relPath));
}

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
