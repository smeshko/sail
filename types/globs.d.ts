// Generated from src/sdk by `bun run types`. Do not edit.
/**
 * A glob as a regular expression over a `/`-separated relative path: `*` matches within one segment, `**` across
 * segments, `**\/` any directories or none, `?` one character but `/`. Everything else is literal, braces included.
 */
export declare function globToRegExp(glob: string): RegExp;
/**
 * Whether the relative path is matched by `globs`: some glob not starting with `!` matches it, and no glob starting
 * with `!` (read without the `!`) does. A list of only `!` globs matches nothing.
 */
export declare function matchesGlob(relPath: string, globs: readonly string[]): boolean;
