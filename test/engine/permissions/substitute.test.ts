import { expect, test } from 'bun:test';
import { classifyRedirect, substitutionScripts, targetPath } from '../../../src/engine/permissions/substitute';
import { type Redirect, tokenize, Unparseable, type Word } from '../../../src/engine/permissions/tokenize';

/** The word at `index` of the first segment. Its own expect runs first, so a missing word fails on its assertion. */
function wordAt(command: string, index: number): Word {
  const [segment] = tokenize(command);
  expect(segment?.words.length).toBe(index + 1);
  return segment?.words[index] as Word;
}

/** The first redirect of the first segment, with the same assertion-first shape. */
function redirectAt(command: string): Redirect {
  const [segment] = tokenize(command);
  expect(segment?.redirects.length ?? 0).toBe(1);
  return segment?.redirects[0] as Redirect;
}

/** A command with `levels` nested `$(` substitutions around `true`. */
function nested(levels: number): string {
  return `echo ${'$('.repeat(levels)}true${')'.repeat(levels)}`;
}

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('a $(...) body parses as a script of its own, with its command', () => {
  const scripts = substitutionScripts(wordAt('echo $(rm -rf /)', 1));
  expect(scripts).toHaveLength(1);
  expect(scripts[0]).toHaveLength(1);
  expect(scripts[0]?.[0]?.words.map((word) => word.text)).toEqual(['rm', '-rf', '/']);
});

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('a backtick body parses as a substitution script', () => {
  const scripts = substitutionScripts(wordAt('echo `id`', 1));
  expect(scripts).toHaveLength(1);
  expect(scripts[0]?.[0]?.words.map((word) => word.text)).toEqual(['id']);
});

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('a substitution inside a substitution parses at the inner level too', () => {
  const [outer] = substitutionScripts(wordAt('echo $(echo $(ls))', 1));
  expect(outer?.[0]?.words.length ?? 0).toBe(2);
  const inner = outer?.[0]?.words[1] as Word;
  expect(substitutionScripts(inner)[0]?.[0]?.words.map((word) => word.text)).toEqual(['ls']);
});

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('sixteen levels of substitution parse, and seventeen are refused', () => {
  const sixteen = wordAt(nested(16), 1);
  expect(substitutionScripts(sixteen)).toHaveLength(1);
  const seventeen = wordAt(nested(17), 1);
  expect(() => substitutionScripts(seventeen)).toThrow(Unparseable);
});

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('a > redirect is a write to its target, and a < redirect is a read of it', () => {
  expect(classifyRedirect(redirectAt('echo x > lib/a.dart'))).toEqual({ kind: 'write', path: 'lib/a.dart' });
  expect(classifyRedirect(redirectAt('cat < in.txt'))).toEqual({ kind: 'read', path: 'in.txt' });
});

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('a file-descriptor duplication classifies as no file', () => {
  expect(classifyRedirect(redirectAt('echo x 2>&1'))).toBeNull();
  expect(classifyRedirect(redirectAt('echo x >&2'))).toBeNull();
});

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('&> writes its target', () => {
  expect(classifyRedirect(redirectAt('echo x &> out'))).toEqual({ kind: 'write', path: 'out' });
});

const UNRESOLVABLE: [string, string][] = [
  ['a variable in the target', 'echo x > $HOME/a'],
  ['a tilde in the target', 'echo x > ~/a'],
  ['a glob in the target', 'echo x > lib/*.dart'],
  ['a brace expansion in the target', 'echo x > {a,b}'],
];

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  .each(UNRESOLVABLE)('refuses a redirect target with %s', (_label, command) => {
  const redirect = redirectAt(command);
  expect(() => classifyRedirect(redirect)).toThrow(Unparseable);
});

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('targetPath returns the literal text of a plain word and refuses an unsafe one', () => {
  expect(targetPath(redirectAt('echo x > lib/a.dart').target)).toBe('lib/a.dart');
  const unsafe = redirectAt('echo x > $HOME/a').target;
  expect(() => targetPath(unsafe)).toThrow(Unparseable);
});
