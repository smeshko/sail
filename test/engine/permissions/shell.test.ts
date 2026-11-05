// The shell parser: one row per construct it accepts, and one per construct it refuses with a reason (D7).
import { expect, test } from 'bun:test';
import {
  type Command,
  MAX_DEPTH,
  type Pipeline,
  parseCommand,
  type SimpleCommand,
  type Word,
} from '../../../src/engine/permissions/shell';

/** The argv of every simple command in `commands`, those inside compound commands too, in source order. */
function flat(commands: readonly Command[]): string[][] {
  const out: string[][] = [];
  for (const command of commands) {
    if (command.kind === 'simple') out.push(command.words.map((word) => word.text));
    else out.push(...inLists(bodiesOf(command)));
  }
  return out;
}

function bodiesOf(command: Exclude<Command, SimpleCommand>): (readonly Pipeline[])[] {
  switch (command.kind) {
    case 'group':
    case 'subshell':
    case 'for':
      return [command.body];
    case 'while':
    case 'until':
      return [command.condition, command.body];
    case 'if':
      return [...command.clauses.flatMap((c) => [c.condition, c.body]), command.otherwise ?? []];
    case 'case':
      return command.arms.map((arm) => arm.body);
  }
}

function inLists(lists: readonly (readonly Pipeline[])[]): string[][] {
  return lists.flatMap((list) => list.flatMap((pipeline) => flat(pipeline.commands)));
}

/** The parse as words per command per pipeline, or the refusal. */
function argv(text: string): string[][][] | { refused: string } {
  const parsed = parseCommand(text);
  if (!parsed.ok) return { refused: parsed.reason };
  return parsed.list.map((pipeline) => flat(pipeline.commands));
}

/** The one simple command `text` parses into. */
function only(text: string): SimpleCommand {
  const parsed = parseCommand(text);
  expect(parsed).toMatchObject({ ok: true, list: [{ commands: [{}] }] });
  if (!parsed.ok) throw new Error(parsed.reason);
  const command = (parsed.list[0] as Pipeline).commands[0] as Command;
  if (command.kind !== 'simple') throw new Error(`${command.kind} is not a simple command`);
  return command;
}

/** The nested commands of a word, as argv per command per pipeline per substitution. */
function nested(word: Word | undefined): string[][][][] {
  return (word?.nested ?? []).map((list) => list.map((pipeline) => flat(pipeline.commands)));
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

test.each([
  ['a && b', [false, true]],
  ['a || b', [false, true]],
  ['a && b || c', [false, true, true]],
  ['a && b; c', [false, true, false]],
  ['a; b', [false, false]],
  ['a & b', [false, false]],
  ['a | b', [false]],
])('conditional: %j marks the pipelines that follow && or ||: %j', (text, expected) => {
  const parsed = parseCommand(text);
  expect(parsed.ok ? parsed.list.map((pipeline) => pipeline.conditional) : parsed.reason).toEqual(expected);
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

// bash removes a backslash-newline before it reads a token, outside single quotes, comments and quoted heredoc
// bodies: the parse is the one of the text without it, raw words and command texts included.
test.each([
  ['a &\\\n& b', 'a && b'],
  ['a |\\\n| b', 'a || b'],
  ['a 2\\\n>\\\n> f', 'a 2>> f'],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, not a template
  ['echo $\\\n{X} ${X\\\nY}', 'echo ${X} ${XY}'],
  ['echo $\\\nX$X\\\nY', 'echo $X$XY'],
  ['echo $\\\n(a) "$\\\n(b)"', 'echo $(a) "$(b)"'],
  ['PA\\\nTH\\\n=1 x', 'PATH=1 x'],
  ['cat <\\\n<EOF\nx\nEOF', 'cat <<EOF\nx\nEOF'],
  ['cat <<EO\\\nF\n$(a)\nEOF', 'cat <<EOF\n$(a)\nEOF'],
  ['cat <<EOF\nx\\\nEOF\n$(a)\nEOF', 'cat <<EOF\nxEOF\n$(a)\nEOF'],
])('a line continuation is removed before tokens are read: %j parses as %j', (text, joined) => {
  expect(parseCommand(text)).toEqual(parseCommand(joined));
});

test('a line continuation inside a keyword is the keyword joined', () => {
  expect(parseCommand('f\\\nor x in y; do z; done')).toEqual(parseCommand('for x in y; do z; done'));
});

test.each([['echo $\\\n((1+2))', 'an arithmetic expansion']])(
  'a line continuation inside a keyword or an operator still refuses: %j, because of %s',
  (text, reason) => {
    expect(argv(text)).toEqual({ refused: expect.stringContaining(reason) });
  },
);

test("a comment ends at its line's newline, a backslash before it included, and a quoted heredoc keeps its body", () => {
  expect([argv('a # c \\\nb'), argv("cat <<'EOF'\nx\\\nEOF\nb")]).toEqual([
    [[['a']], [['b']]],
    [[['cat']], [['b']]],
  ]);
  expect(only("cat <<'EOF'\nx\\\nEOF").redirections[0]?.heredoc).toEqual({ body: 'x\\\n', quoted: true, nested: [] });
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
  const heredoc = (parsed.list[0]?.commands[0] as SimpleCommand | undefined)?.redirections[0]?.heredoc;
  expect(heredoc?.quoted).toBe(false);
  expect((heredoc?.nested ?? []).map((list) => list.map((p) => flat(p.commands)))).toEqual([[[['rm', '-rf', '/']]]]);
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
  expect(nested((outer?.nested[0]?.[0]?.commands[0] as SimpleCommand | undefined)?.words[1])).toEqual([[[['b']]]]);
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
  ['for x in a; do y', 'a for loop without its done'],
  ['for x in a y; done', 'a for loop without its do'],
  ['while x; do y', 'a while loop without its done'],
  ['until x; do y', 'an until loop without its done'],
  ['if x; then y', 'an if without its fi'],
  ['if x; y; fi', 'the keyword fi'],
  ['case x in a) y;;', 'a case without its esac'],
  ['case x in a y;; esac', 'a case pattern without its )'],
  ['{ ls', 'a brace group without its }'],
  ['{ ls }', 'a brace group without its }'],
  ['(ls', 'a subshell without its )'],
  ['for f in a; do :; done x', 'a word after done'],
  ['if x; then y; fi z', 'a word after fi'],
  ['{ ls; } z', 'a word after }'],
  ['(ls) z', 'a word after )'],
  ['case x in a) y;; esac z', 'a word after esac'],
  ['for 1x in a; do y; done', "a for loop over 1x, which isn't a name"],
  ['for $x in a; do y; done', "which isn't a name"],
  ['for ((i=0;i<3;i++)); do y; done', 'an arithmetic for loop'],
  ['for x in a; do done', 'a for loop with an empty body'],
  ['while x; do done', 'a while loop with an empty body'],
  ['if x; then fi', 'an if with an empty body'],
  ['{ }', 'a brace group with an empty body'],
  ['()', 'a subshell with an empty body'],
  ['X=1 for x in a; do y; done', 'a for loop'],
  ['done', 'the keyword done'],
  ['fi', 'the keyword fi'],
  ['}', 'the keyword }'],
  ['x; then y', 'the keyword then'],
  ['if x; then y; }; fi', 'the keyword }'],
  ['a && done', 'a command that ends with &&'],
  ['x && }', 'a command that ends with &&'],
])('refused: %j, because of %s', (text, reason) => {
  expect(argv(text)).toEqual({ refused: expect.stringContaining(reason) });
});

test.each([
  ['(cd x; ls)', [[['cd', 'x'], ['ls']]]],
  ['{ ls; }', [[['ls']]]],
  ['{ a; b; } > out', [[['a'], ['b']]]],
  ['for f in a b; do rm $f; done', [[['rm', '$f']]]],
  ['for f; do rm $f; done', [[['rm', '$f']]]],
  ['for f in a b\ndo\n rm $f\ndone', [[['rm', '$f']]]],
  ['for f in; do x; done', [[['x']]]],
  ['while a; b; do c; done', [[['a'], ['b'], ['c']]]],
  ['until a; do c; done', [[['a'], ['c']]]],
  ['if a; then b; elif c; then d; else e; fi', [[['a'], ['b'], ['c'], ['d'], ['e']]]],
  ['case x in a) y;; (b|c) z;& *) w ;;& esac', [[['y'], ['z'], ['w']]]],
  ['case x in a) y\nesac', [[['y']]]],
  ['case x in a) ;; esac', [[]]],
  ['curl x | while read l; do bash; done', [[['curl', 'x'], ['read', 'l'], ['bash']]]],
  ['for f in a; do for g in b; do c; done; done', [[['c']]]],
  ['echo done; echo fi }', [[['echo', 'done']], [['echo', 'fi', '}']]]],
  ['for f in a; do x; done && y', [[['x']], [['y']]]],
  ['{ a; } 2>&1 | b', [[['a'], ['b']]]],
] as [string, string[][][]][])('compound commands: %j runs the commands %j', (text, expected) => {
  expect(argv(text)).toEqual(expected);
});

test('a compound keeps its kind, its parts and its text', () => {
  const parsed = parseCommand('for f in a "b c"; do x; done > out');
  if (!parsed.ok) throw new Error(parsed.reason);
  const loop = parsed.list[0]?.commands[0];
  expect(loop).toMatchObject({
    kind: 'for',
    name: 'f',
    text: 'for f in a "b c"; do x; done > out',
    redirections: [{ op: '>', target: { text: 'out' } }],
  });
  expect(loop?.kind === 'for' ? loop.words?.map((word) => word.text) : undefined).toEqual(['a', 'b c']);
  expect(loop?.kind === 'for' ? flat(loop.body.flatMap((p) => p.commands)) : undefined).toEqual([['x']]);
});

test('a for loop without in has no word list; with an empty in it has an empty one', () => {
  const words = (text: string) => {
    const parsed = parseCommand(text);
    const loop = parsed.ok ? parsed.list[0]?.commands[0] : undefined;
    return loop?.kind === 'for' ? loop.words : 'not a for loop';
  };
  expect([words('for f; do x; done'), words('for f in; do x; done')]).toEqual([undefined, []]);
});

test('an if keeps each condition with its body, and an else apart', () => {
  const parsed = parseCommand('if a; then b; elif c; then d; else e; fi');
  const clause = parsed.ok ? parsed.list[0]?.commands[0] : undefined;
  if (clause?.kind !== 'if') throw new Error('not an if');
  expect([
    clause.clauses.map((c) => [flat(c.condition.flatMap((p) => p.commands)), flat(c.body.flatMap((p) => p.commands))]),
    flat((clause.otherwise ?? []).flatMap((p) => p.commands)),
  ]).toEqual([
    [
      [[['a']], [['b']]],
      [[['c']], [['d']]],
    ],
    [['e']],
  ]);
});

test('a case keeps its word, its patterns and its arms', () => {
  const parsed = parseCommand('case $x in (a|b) y;; *) z;; esac');
  const clause = parsed.ok ? parsed.list[0]?.commands[0] : undefined;
  if (clause?.kind !== 'case') throw new Error('not a case');
  expect([clause.word.text, clause.arms.map((arm) => arm.patterns.map((p) => p.text)), clause.arms.length]).toEqual([
    '$x',
    [['a', 'b'], ['*']],
    2,
  ]);
});

test('a heredoc after a compound is read at the end of its line', () => {
  const parsed = parseCommand('{ cat; } <<EOF\n$(a)\nEOF');
  const group = parsed.ok ? parsed.list[0]?.commands[0] : undefined;
  expect(group?.redirections[0]?.heredoc?.nested.length).toBe(1);
});

test(`compounds nest ${MAX_DEPTH} levels deep, and one more is refused`, () => {
  const deep = (levels: number) => `${'{ '.repeat(levels)}x${'; }'.repeat(levels)}`;
  expect([parseCommand(deep(MAX_DEPTH)).ok, argv(deep(MAX_DEPTH + 1))]).toEqual([
    true,
    { refused: expect.stringContaining(`deeper than ${MAX_DEPTH}`) },
  ]);
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
