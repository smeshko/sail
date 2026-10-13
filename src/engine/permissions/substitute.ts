// Substitution bodies and redirections: each body is parsed as a script, and each redirect is a read, a write or
// refused.
import { type Redirect, type Script, tokenize, Unparseable, type Word } from './tokenize';

/** A read or a write of one path, from a redirection. */
export interface RedirectTarget {
  readonly kind: 'read' | 'write';
  readonly path: string;
}

/** The most substitutions one command may nest. Past it the command is refused, not walked. */
const MAX_DEPTH = 16;

/** Parses every substitution body of a word as a script, recursively. Throws `Unparseable` past depth 16. */
export function substitutionScripts(word: Word, depth: number = 0): Script[] {
  if (word.substitutions.length === 0) return [];
  if (depth >= MAX_DEPTH) throw new Unparseable('substitutions nested too deeply');
  return word.substitutions.map((body) => {
    const script = tokenize(body);
    for (const segment of script) {
      for (const inner of segment.words) substitutionScripts(inner, depth + 1);
      for (const redirect of segment.redirects) substitutionScripts(redirect.target, depth + 1);
    }
    return script;
  });
}

/** Classifies a redirect as a read or a write of its target, or null for a file-descriptor duplication. */
export function classifyRedirect(redirect: Redirect): RedirectTarget | null {
  const { op, target } = redirect;
  if ((op === '>&' || op === '<&') && isDescriptor(target)) return null;
  const path = targetPath(target);
  const isRead = op === '<' || op === '<&';
  return { kind: isRead ? 'read' : 'write', path };
}

/** The literal path a word names. Throws `Unparseable` when it is unsafe or empty. */
export function targetPath(word: Word): string {
  if (word.unsafe || word.text === '') throw new Unparseable('a redirect target the engine cannot name');
  return word.text;
}

/** A file descriptor number, or `-` for a closed one: the target of `2>&1`, `>&2` and `<&-`. */
function isDescriptor(word: Word): boolean {
  return !word.unsafe && (word.text === '-' || /^\d+$/.test(word.text));
}
