// The shell parser: one row per construct it accepts, and one per construct it refuses with a reason (D7).
import { expect, test } from 'bun:test';
import { MAX_DEPTH, type Pipeline, parseCommand, type Word } from '../../../src/engine/permissions/shell';

/** The parse as words per command per pipeline, or the refusal. */
function argv(text: string): string[][][] | { refused: string } {
  const parsed = parseCommand(text);
  if (!parsed.ok) return { refused: parsed.reason };
  return parsed.list.map((pipeline) => pipeline.commands.map((command) => command.words.map((word) => word.text)));
}

/** The one simple command `text` parses into. */
function only(text: string) {
  const parsed = parseCommand(text);
  expect(parsed).toMatchObject({ ok: true, list: [{ commands: [{}] }] });
  if (!parsed.ok) throw new Error(parsed.reason);
  return (parsed.list[0] as Pipeline).commands[0] as Pipeline['commands'][number];
}

/** The nested commands of a word, as argv per command per pipeline per substitution. */
function nested(word: Word | undefined): string[][][][] {
  return (word?.nested ?? []).map((list) =>
    list.map((pipeline) => pipeline.commands.map((command) => command.words.map((w) => w.text))),
  );
}

test.each([
  ['a | b', [[['a'], ['b']]]],
  ['a |& b', [[['a'], ['b']]]],
  ['a || b', [[['a']], [['b']]]],
  ['a && b', [[['a']], [['b']]]],
  ['a ; b', [[['a']], [['b']]]],
  ['a & b', [[['a']], [['b']]]],
  ['a\nb', [[['a']], [['b']]]],
  ['a |\n  b', [[['a'], ['b']]]],
  ["echo 'a|b' \"c|d\" e\\|f 'a;b'", [[['echo', 'a|b', 'c|d', 'e|f', 'a;b']]]],
])('separators: %j splits into %j', (text, expected) => {
  expect(argv(text)).toEqual(expected);
});

test('a pipeline ended by & runs in the background', () => {
  const parsed = parseCommand('a & b; c');
  expect(parsed.ok ? parsed.list.map((pipeline) => pipeline.background) : parsed.reason).toEqual([true, false, false]);
});

test('quotes and escapes come off, and the words stay literal', () => {
  const command = only(`echo 'a b' "c d" e\\ f "\\$x \\" \\\\"`);
  expect(command.words.map((word) => [word.text, word.literal])).toEqual([
    ['echo', true],
    ['a b', true],
    ['c d', true],
    ['e f', true],
    ['$x " \\', true],
  ]);
});

test('a backslash before a newline joins the lines into one word', () => {
  expect(argv('r\\\nm -rf x')).toEqual([[['rm', '-rf', 'x']]]);
});

test('a # starting a word comments out the rest of the line; inside a word or quotes it is text', () => {
  expect(argv('git diff # rm -rf /')).toEqual([[['git', 'diff']]]);
  expect(argv('echo a#b \'#c\' "#d"')).toEqual([[['echo', 'a#b', '#c', '#d']]]);
  expect(argv('# only a comment\nls')).toEqual([[['ls']]]);
});

test('NAME=value before the command name is an assignment; after it, a word', () => {
  const command = only('FOO=1 BAR="x y" npm test');
  expect(command.assignments.map((a) => [a.name, a.value.text])).toEqual([
    ['FOO', '1'],
    ['BAR', 'x y'],
  ]);
  expect(command.words.map((word) => word.text)).toEqual(['npm', 'test']);
  const later = only('npm FOO=1');
  expect([later.assignments.length, later.words.map((word) => word.text)]).toEqual([0, ['npm', 'FOO=1']]);
});

test.each([
  ['cmd > out', [{ op: '>', target: 'out' }]],
  ['cmd >out', [{ op: '>', target: 'out' }]],
  ['cmd >> out', [{ op: '>>', target: 'out' }]],
  ['cmd >| out', [{ op: '>|', target: 'out' }]],
  ['cmd < in', [{ op: '<', target: 'in' }]],
  ['cmd 2> err', [{ op: '>', fd: 2, target: 'err' }]],
  ['cmd 2>>err', [{ op: '>>', fd: 2, target: 'err' }]],
  ['cmd &> all', [{ op: '&>', target: 'all' }]],
  ['cmd &>>all', [{ op: '&>>', target: 'all' }]],
  ['cmd 2>&1', [{ op: 'dup', fd: 2 }]],
  ['cmd >&2', [{ op: 'dup' }]],
  ['cmd >&out', [{ op: '&>', target: 'out' }]],
  ['cmd <<< "a b"', [{ op: '<<<', target: 'a b' }]],
  [
    'cmd>out 2>/dev/null',
    [
      { op: '>', target: 'out' },
      { op: '>', fd: 2, target: '/dev/null' },
    ],
  ],
] as [string, { op: string; fd?: number; target?: string }[]][])(
  'redirections: %j records %j, and the command keeps only its words',
  (text, expected) => {
    const command = only(text);
    const found: { op: string; fd?: number; target?: string }[] = command.redirections.map((r) => ({
      op: r.op,
      ...(r.fd === undefined ? {} : { fd: r.fd }),
      ...(r.target === undefined ? {} : { target: r.target.text }),
    }));
    expect([command.words.map((word) => word.text), found]).toEqual([['cmd'], expected]);
  },
);

test("a quoted heredoc's body is data, and the command's other redirections stay", () => {
  const command = only("cat <<'EOF' > out.md\n$(rm -rf /)\nEOF");
  expect(command.words.map((word) => word.text)).toEqual(['cat']);
  expect(command.redirections.map((r) => [r.op, r.target?.text, r.heredoc])).toEqual([
    ['<<', undefined, { body: '$(rm -rf /)\n', quoted: true, nested: [] }],
    ['>', 'out.md', undefined],
  ]);
});

test("an unquoted heredoc's substitutions are nested commands, and the list goes on after its delimiter", () => {
  const parsed = parseCommand('cat <<EOF\nnow $(rm -rf /)\nEOF\nls');
  expect(parsed.ok ? 'parsed' : parsed.reason).toBe('parsed');
  if (!parsed.ok) return;
  const heredoc = parsed.list[0]?.commands[0]?.redirections[0]?.heredoc;
  expect(heredoc?.quoted).toBe(false);
  expect(
    (heredoc?.nested ?? []).map((list) => list.map((p) => p.commands.map((c) => c.words.map((w) => w.text)))),
  ).toEqual([[[['rm', '-rf', '/']]]]);
  expect(argv('cat <<EOF\nnow $(rm -rf /)\nEOF\nls')).toEqual([[['cat']], [['ls']]]);
});

test('<<- strips the leading tabs of the body and of the delimiter line', () => {
  const command = only('cat <<-EOF\n\tline\n\t\tEOF');
  expect(command.redirections[0]?.heredoc?.body).toBe('line\n');
});

test.each([
  ['echo $(rm -rf /)', 1, [[[['rm', '-rf', '/']]]]],
  ['echo `rm -rf /`', 1, [[[['rm', '-rf', '/']]]]],
  ['echo "$(rm -rf /)"', 1, [[[['rm', '-rf', '/']]]]],
  ['echo "a `sudo x` b"', 1, [[[['sudo', 'x']]]]],
  ['$(a $(b))', 0, [[[['a', '$(b)']]]]],
  ['echo $(a | b; c)', 1, [[[['a'], ['b']], [['c']]]]],
])('substitutions: in %j, word %i holds %j', (text, index, expected) => {
  const command = only(text);
  expect([nested(command.words[index]), command.words[index]?.literal]).toEqual([expected, false]);
});

test('a substitution inside a substitution is nested in turn', () => {
  const outer = only('$(a $(b))').words[0];
  expect(nested(outer?.nested[0]?.[0]?.commands[0]?.words[1])).toEqual([[[['b']]]]);
});

test("'$(x)' in single quotes is literal text", () => {
  const word = only("echo '$(x)'").words[1];
  expect([word?.text, word?.literal, nested(word)]).toEqual(['$(x)', true, []]);
});

test('variables are recorded, kept as written, and make their words non-literal', () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, not a template
  const words = only('echo $HOME ${STAGE_OUT}/x "$1" plain').words;
  expect(words.map((word) => [word.text, word.vars, word.literal])).toEqual([
    ['echo', [], true],
    ['$HOME', ['HOME'], false],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, not a template
    ['${STAGE_OUT}/x', ['STAGE_OUT'], false],
    ['$1', ['1'], false],
    ['plain', [], true],
  ]);
});

test('an unquoted glob or a leading ~ makes a word non-literal; quoted, it is text', () => {
  const words = only("ls *.ts '*.ts' a?c [ab] ~/x '~/x'").words.slice(1);
  expect(words.map((word) => [word.text, word.literal, word.glob])).toEqual([
    ['*.ts', false, true],
    ['*.ts', true, false],
    ['a?c', false, true],
    ['[ab]', false, true],
    ['~/x', false, false],
    ['~/x', true, false],
  ]);
});

test('a simple command keeps its text as written, for reasons', () => {
  const parsed = parseCommand('git  diff | head -5 && FOO=1 ls >x');
  expect(parsed.ok ? 'parsed' : parsed.reason).toBe('parsed');
  if (!parsed.ok) return;
  expect(parsed.list.flatMap((pipeline) => pipeline.commands.map((command) => command.text))).toEqual([
    'git  diff',
    'head -5',
    'FOO=1 ls >x',
  ]);
});

test.each([
  ['(cd x; ls)', 'a subshell'],
  ['{ ls; }', 'a brace group'],
  ['for f in *; do rm $f; done', 'a for loop'],
  ['while true; do :; done', 'a while loop'],
  ['until x; do y; done', 'an until loop'],
  ['if x; then y; fi', 'an if'],
  ['case x in a) y;; esac', 'a case'],
  ['select x in a; do y; done', 'a select'],
  ['f() { x; }', 'a function definition'],
  ['function f { x; }', 'a function definition'],
  ['[[ -f x ]] && y', 'a [[ test'],
  ['! true', 'a negated pipeline'],
  ['((x++))', 'an arithmetic command'],
  ['diff <(a) <(b)', 'a process substitution <('],
  ['tee >(x)', 'a process substitution >('],
  ['echo $((1+2))', 'an arithmetic expansion'],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, not a template
  ['echo ${X:-y}', '${X:-y}'],
  ["$'rm' -rf x", "an ANSI-C quote $'"],
  ['echo $"x"', 'a locale quote'],
  ['{rm,-rf,x}', 'a brace expansion {rm,-rf,x}'],
  ['echo a{1..3}', 'a brace expansion {1..3}'],
  ['X=(a b) y', 'an array assignment to X'],
  ['cat <> f', 'a read-write redirection'],
  ['cat <&x', 'an input duplication'],
  ['echo >', 'a redirection > without a target'],
  ["echo 'a", "an unterminated ' quote"],
  ['echo "a', 'an unterminated " quote'],
  ['echo $(a', 'an unterminated $('],
  ['echo ${a', 'an unterminated ${'],
  ['echo `a', 'an unterminated ` substitution'],
  ['cat <<EOF\nline', 'a heredoc without its closing EOF line'],
  ['cat <<EOF', 'a heredoc without its closing EOF line'],
  ['a |', 'a command that ends with |'],
  ['a &&', 'a command that ends with &&'],
  ['a || ;', 'a command that ends with ||'],
  ['| a', "a command can't start with |"],
  ['a ;; b', 'a case clause'],
  ['a )', 'an unmatched )'],
])('refused: %j, because of %s', (text, reason) => {
  expect(argv(text)).toEqual({ refused: expect.stringContaining(reason) });
});

test(`substitutions nest ${MAX_DEPTH} levels deep, and one more is refused`, () => {
  const deep = (levels: number) => `${'echo $('.repeat(levels)}x${')'.repeat(levels)}`;
  const parsed = parseCommand(deep(MAX_DEPTH));
  expect([parsed.ok, argv(deep(MAX_DEPTH + 1))]).toEqual([
    true,
    { refused: expect.stringContaining(`deeper than ${MAX_DEPTH}`) },
  ]);
});

test('empty and blank input is an empty list, not a refusal', () => {
  expect([parseCommand(''), parseCommand('  \n\t ')]).toEqual([
    { ok: true, list: [] },
    { ok: true, list: [] },
  ]);
});
