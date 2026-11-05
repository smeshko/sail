// Path globs, shared by the permission engine and a repository's own code that must match paths as the engine does.

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

/**
 * Whether the relative path is matched by `globs`: some glob not starting with `!` matches it, and no glob starting
 * with `!` (read without the `!`) does. A list of only `!` globs matches nothing.
 */
export function matchesGlob(relPath: string, globs: readonly string[]): boolean {
  const hit = (glob: string): boolean => globToRegExp(glob).test(relPath);
  return globs.some((g) => !g.startsWith('!') && hit(g)) && !globs.some((g) => g.startsWith('!') && hit(g.slice(1)));
}
