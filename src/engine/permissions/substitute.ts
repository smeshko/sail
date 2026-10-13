// Substitution bodies and redirections: each body is parsed as a script, and each redirect is a read, a write or
// refused.
import type { Redirect, Script, Word } from './tokenize';

/** A read or a write of one path, from a redirection. */
export interface RedirectTarget {
  readonly kind: 'read' | 'write';
  readonly path: string;
}

/** Parses every substitution body of a word as a script, recursively. Throws `Unparseable` past depth 16. */
export function substitutionScripts(_word: Word, _depth: number = 0): Script[] {
  return [];
}

/** Classifies a redirect as a read or a write of its target, or null for a file-descriptor duplication. */
export function classifyRedirect(_redirect: Redirect): RedirectTarget | null {
  return null;
}

/** The literal path a word names. Throws `Unparseable` when it is unsafe or empty. */
export function targetPath(_word: Word): string {
  return '';
}
