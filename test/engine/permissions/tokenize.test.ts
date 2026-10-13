import { expect, test } from 'bun:test';
import { tokenize, Unparseable } from '../../../src/engine/permissions/tokenize';

test('a pipeline splits on | into two segments, each with its words', () => {
  const script = tokenize('git diff origin/main...HEAD | head -50');
  expect(script).toHaveLength(2);
  expect(script.map((segment) => segment.words.map((word) => word.text))).toEqual([
    ['git', 'diff', 'origin/main...HEAD'],
    ['head', '-50'],
  ]);
  expect(script[1]?.before).toBe('|');
});

test('double quotes, single quotes and a backslash each make one word', () => {
  const script = tokenize('echo "a b" \'c d\' e\\ f');
  expect(script).toHaveLength(1);
  expect(script[0]?.words.map((word) => word.text)).toEqual(['echo', 'a b', 'c d', 'e f']);
  expect(script[0]?.words[1]?.quoted).toBe(true);
  expect(script[0]?.words[2]?.quoted).toBe(true);
});

test('&&, ||, ; and & each split, and every segment records the operator before it', () => {
  const script = tokenize('a && b || c; d & e');
  expect(script).toHaveLength(5);
  expect(script.map((segment) => segment.words[0]?.text)).toEqual(['a', 'b', 'c', 'd', 'e']);
  expect(script.map((segment) => segment.before)).toEqual([null, '&&', '||', ';', '&']);
});

test('a newline splits the script like a semicolon', () => {
  const script = tokenize('a\nb');
  expect(script).toHaveLength(2);
  expect(script.map((segment) => segment.before)).toEqual([null, '\n']);
});

const REFUSED: [string, string][] = [
  ['an unclosed double quote', 'echo "abc'],
  ['an unclosed single quote', "echo 'abc"],
  ['a trailing backslash', 'echo abc\\'],
  ['a heredoc', 'cat <<EOF'],
  ['a here-string', 'cat <<<x'],
  ['a process substitution read', 'diff <(a) b'],
  ['a process substitution write', 'tee >(a)'],
  ['a subshell', '(a)'],
  ['a stray close parenthesis', 'a)'],
  ['a brace group', '{ a; }'],
  ['a word that starts with #', 'echo hi #note'],
  ['an arithmetic expansion', 'echo $((1+2))'],
];

test.each(REFUSED)('refuses %s', (_label, input) => {
  expect(() => tokenize(input)).toThrow(Unparseable);
});

test('a substitution in single quotes is literal text, not a substitution', () => {
  const script = tokenize("echo '$(rm -rf /)'");
  expect(script).toHaveLength(1);
  expect(script[0]?.words[1]?.text).toBe('$(rm -rf /)');
  expect(script[0]?.words[1]?.substitutions).toEqual([]);
});

test('a substitution in double quotes stays active and its body is kept unparsed', () => {
  const script = tokenize('echo "$(id)"');
  expect(script).toHaveLength(1);
  expect(script[0]?.words[1]?.substitutions).toEqual(['id']);
});
