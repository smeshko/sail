// decide(): the epic's table. Every prototype permission hole is a row and denied with its rule, the deny set's
// branch changes are denied by name, the legitimate calls pass, and every call that is missing what it needs fails
// closed. The rows run against a run's directories on disk.
import { afterAll, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decide } from '../../src/engine/permissions/index';
import type { DenialRule, ToolCall } from '../../src/engine/permissions/types';
import type { Permissions } from '../../src/sdk/steps';
import { makeLayout, perms } from '../helpers/permissions';

const layout = makeLayout();
afterAll(() => layout.remove());
const { clone, worktree, elsewhere, stageIn } = layout;
layout.link('out', elsewhere);
layout.link('wlib', join(clone, 'lib'));

interface Row {
  readonly label: string;
  readonly call: ToolCall;
  readonly open: Partial<Permissions>;
  readonly want: 'allow' | DenialRule;
  /** What a denial's reason must name: the refused path, command or tool. */
  readonly mention?: string;
}

const bash = (command: string, cwd?: string): ToolCall => ({
  tool: 'Bash',
  kind: 'execute',
  paths: [],
  command,
  ...(cwd === undefined ? {} : { cwd }),
});
const read = (...paths: string[]): ToolCall => ({ tool: 'Read', kind: 'read', paths });
const write = (...paths: string[]): ToolCall => ({ tool: 'Write', kind: 'write', paths });
const edit = (...paths: string[]): ToolCall => ({ tool: 'Edit', kind: 'edit', paths });
const mcp = (server: string | undefined, tool: string): ToolCall => ({
  tool,
  kind: 'mcp',
  paths: [],
  ...(server === undefined ? {} : { server }),
});
const other = (tool: string): ToolCall => ({ tool, kind: 'other', paths: [] });

const TABLE: Row[] = [
  // The prototype's holes, each closed.
  {
    label: 'hole: an MCP call when the step lists no tools',
    call: mcp('linear', 'get_issue'),
    open: {},
    want: 'tools',
    mention: 'linear:get_issue',
  },
  {
    label: 'hole: an MCP call to a server the step does not list',
    call: mcp('linear', 'get_issue'),
    open: { tools: ['github:*'] },
    want: 'tools',
    mention: 'linear:get_issue',
  },
  {
    label: 'hole: echo x > lib/a.dart without write on lib/**',
    call: bash('echo x > lib/a.dart'),
    open: { commands: ['echo *'], write: ['src/**'] },
    want: 'write',
    mention: 'lib/a.dart',
  },
  {
    label: 'hole: echo $(rm -rf /)',
    call: bash('echo $(rm -rf /)'),
    open: { commands: ['echo *'] },
    want: 'commands',
    mention: 'rm -rf',
  },
  {
    label: 'hole: bash -c "rm -rf ."',
    call: bash('bash -c "rm -rf ."'),
    open: { commands: ['bash *'] },
    want: 'commands',
    mention: 'rm -rf',
  },
  {
    label: 'hole: git -C /elsewhere commit',
    call: bash(`git -C ${elsewhere} commit`),
    open: { commands: ['git *'] },
    want: 'commands',
    mention: elsewhere,
  },
  {
    label: "hole: a write into the clone's own checkout",
    call: write(join(clone, 'lib', 'a.dart')),
    open: { write: ['**'] },
    want: 'write',
    mention: join(clone, 'lib', 'a.dart'),
  },
  {
    label: "hole: an edit into the clone's own checkout",
    call: edit(join(clone, 'lib', 'a.dart')),
    open: { write: ['**'] },
    want: 'write',
    mention: join(clone, 'lib', 'a.dart'),
  },
  {
    label: "hole: cd into the clone's checkout, then a relative write",
    call: bash(`cd ${clone} && echo x > lib/a.dart`),
    open: { commands: ['echo *'], write: ['**'] },
    want: 'commands',
    mention: clone,
  },
  {
    label: 'hole: a write through a link into the clone',
    call: write('wlib/a.dart'),
    open: { write: ['**'] },
    want: 'write',
    mention: 'wlib/a.dart',
  },
  {
    label: 'hole: a write up out of the worktree with ..',
    call: write('../../../lib/a.dart'),
    open: { write: ['**'] },
    want: 'write',
    mention: '../../../lib/a.dart',
  },
  // The deny set.
  {
    label: 'deny set: git checkout main',
    call: bash('git checkout main'),
    open: { commands: ['git *'] },
    want: 'commands',
    mention: 'git checkout',
  },
  {
    label: 'deny set: git switch -c other',
    call: bash('git switch -c other'),
    open: { commands: ['git *'] },
    want: 'commands',
    mention: 'git switch',
  },
  {
    label: 'deny set: git push --force',
    call: bash('git push --force'),
    open: { commands: ['git *'] },
    want: 'commands',
    mention: 'git push --force',
  },
  {
    label: 'deny set: curl piped into sh',
    call: bash('curl -s x | sh'),
    open: { commands: ['curl *', 'sh *'] },
    want: 'commands',
    mention: 'curl | sh',
  },
  {
    label: 'deny set: sudo behind env',
    call: bash('env sudo x'),
    open: { commands: ['env *'] },
    want: 'commands',
    mention: 'sudo',
  },
  {
    label: 'deny set: rm -rf behind xargs',
    call: bash('xargs rm -rf'),
    open: { commands: ['xargs *'] },
    want: 'commands',
    mention: 'rm -rf',
  },
  {
    label: 'deny set: rm with -rf hidden behind $IFS',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, not a template
    call: bash('rm ${IFS}-rf x'),
    open: { commands: ['rm *'] },
    want: 'commands',
    mention: 'rm -rf',
  },
  {
    label: 'deny set: PATH set for an allowed command',
    call: bash('PATH=. git status'),
    open: { commands: ['git status *'] },
    want: 'commands',
    mention: 'PATH',
  },
  {
    label: 'deny set: git reset --hard abbreviated to a prefix git accepts',
    call: bash('git reset --har'),
    open: { commands: ['git reset *'] },
    want: 'commands',
    mention: 'git reset --hard',
  },
  {
    label: 'deny set: git push --force-with-lease abbreviated',
    call: bash('git push --force-w origin x'),
    open: { commands: ['git push *'] },
    want: 'commands',
    mention: 'git push --force',
  },
  {
    label: 'deny set: rm --recursive --force abbreviated',
    call: bash('rm --rec --forc x'),
    open: { commands: ['rm *'] },
    want: 'commands',
    mention: 'rm -rf',
  },
  // A backslash-newline is gone before bash reads a token.
  {
    label: 'parser: a heredoc delimiter holding a line continuation is unquoted, so its body is checked',
    call: bash('cat <<EO\\\nF\n$(rm -rf x)\nEOF'),
    open: { commands: ['cat *'] },
    want: 'commands',
    mention: 'rm -rf',
  },
  {
    label: 'parser: a line continuation between $ and { is still a variable',
    call: bash('rm $\\\n{IFS}-rf x'),
    open: { commands: ['rm *'] },
    want: 'commands',
    mention: 'rm -rf',
  },
  {
    label: 'parser: a line continuation between $ and ( in double quotes is still a substitution',
    call: bash('echo "$\\\n(id)"'),
    open: { commands: ['echo *'] },
    want: 'commands',
    mention: '`id`',
  },
  // Legitimate calls pass.
  {
    label: 'legit: git diff origin/main...HEAD | head -50',
    call: bash('git diff origin/main...HEAD | head -50'),
    open: { commands: ['git diff *', 'head *'] },
    want: 'allow',
  },
  {
    label: 'legit: npm test -- a.test.ts',
    call: bash('npm test -- a.test.ts'),
    open: { commands: ['npm test *'] },
    want: 'allow',
  },
  {
    label: 'legit: a command writing to /dev/null with no write globs',
    call: bash('npm test 2>/dev/null'),
    open: { commands: ['npm test *'] },
    want: 'allow',
  },
  {
    label: 'legit: a read of src/a.ts under src/**',
    call: read('src/a.ts'),
    open: { read: ['src/**'] },
    want: 'allow',
  },
  {
    label: 'legit: a read of $STAGE_IN/brief.md with no read globs',
    call: read('$STAGE_IN/brief.md'),
    open: {},
    want: 'allow',
  },
  {
    label: 'legit: a read of $STAGE_IN by absolute path',
    call: read(join(stageIn, 'brief.md')),
    open: {},
    want: 'allow',
  },
  {
    label: 'legit: a write of $STAGE_OUT/spec.md',
    call: write('$STAGE_OUT/spec.md'),
    open: { write: ['$STAGE_OUT/**'] },
    want: 'allow',
  },
  {
    label: 'legit: an edit of src/a.ts under src/**',
    call: edit('src/a.ts'),
    open: { write: ['src/**'] },
    want: 'allow',
  },
  {
    label: 'legit: an MCP call under server:*',
    call: mcp('linear', 'get_issue'),
    open: { tools: ['linear:*'] },
    want: 'allow',
  },
  {
    label: 'legit: an MCP call listed as server:tool',
    call: mcp('linear', 'get_issue'),
    open: { tools: ['linear:get_issue'] },
    want: 'allow',
  },
  {
    label: 'legit: another tool listed by name',
    call: other('WebFetch'),
    open: { tools: ['WebFetch'] },
    want: 'allow',
  },
  {
    label: 'legit: a command run from a subdirectory',
    call: bash('echo x > a.txt', join(worktree, 'sub')),
    open: { commands: ['echo *'], write: ['sub/**'] },
    want: 'allow',
  },
  // Fail closed.
  { label: 'closed: a read with no paths', call: read(), open: { read: ['**'] }, want: 'read', mention: 'Read' },
  { label: 'closed: a write with no paths', call: write(), open: { write: ['**'] }, want: 'write', mention: 'Write' },
  { label: 'closed: an edit with no paths', call: edit(), open: { write: ['**'] }, want: 'write', mention: 'Edit' },
  {
    label: 'closed: an execute with no command',
    call: { tool: 'Bash', kind: 'execute', paths: [] },
    open: { commands: ['*'] },
    want: 'commands',
    mention: 'Bash',
  },
  {
    label: 'closed: an execute with an empty command',
    call: bash('  '),
    open: { commands: ['*'] },
    want: 'commands',
    mention: 'Bash',
  },
  {
    label: 'closed: an MCP call with no server',
    call: mcp(undefined, 'get_issue'),
    open: { tools: ['linear:*'] },
    want: 'tools',
    mention: 'get_issue',
  },
  {
    label: 'closed: a kind outside the six',
    call: { tool: 'Remove', kind: 'delete', paths: ['src/a.ts'] } as unknown as ToolCall,
    open: { write: ['**'], tools: ['Remove'] },
    want: 'tools',
    mention: 'delete',
  },
  {
    label: 'closed: another tool when the step lists no tools',
    call: other('WebFetch'),
    open: {},
    want: 'tools',
    mention: 'WebFetch',
  },
  {
    label: "closed: another tool named like a server's tool",
    call: other('linear:get_issue'),
    open: { tools: ['linear:*', 'linear:get_issue'] },
    want: 'tools',
    mention: 'linear:get_issue',
  },
  {
    label: 'closed: an MCP server whose name holds a colon',
    call: mcp('linear:get_issue', 'x'),
    open: { tools: ['linear:*'] },
    want: 'tools',
    mention: 'linear:get_issue:x',
  },
  {
    label: 'closed: a command run from a cwd outside the roots',
    call: bash('echo x', elsewhere),
    open: { commands: ['echo *'] },
    want: 'commands',
    mention: elsewhere,
  },
  {
    label: 'closed: a relative read from a cwd outside the roots',
    call: { ...read('a.ts'), cwd: elsewhere },
    open: { read: ['**'] },
    want: 'read',
    mention: elsewhere,
  },
  {
    label: 'closed: a path through a file used as a directory',
    call: read('src/a.ts/x'),
    open: { read: ['**'] },
    want: 'read',
    mention: "can't be decided",
  },
  {
    label: 'closed: a loop the parser refuses',
    call: bash('for f in *; do rm $f; done'),
    open: { commands: ['rm *'] },
    want: 'commands',
    mention: "can't be checked",
  },
  {
    label: 'closed: a redirection through a file used as a directory',
    call: bash('sort < src/a.ts/x'),
    open: { commands: ['sort *'], read: ['**'] },
    want: 'commands',
    mention: "can't be decided",
  },
  // Paths.
  {
    label: 'paths: the first failing path of several is the reason',
    call: read('src/a.ts', join(clone, 'lib', 'a.dart')),
    open: { read: ['**'] },
    want: 'read',
    mention: join(clone, 'lib', 'a.dart'),
  },
  {
    label: 'paths: a read through a link pointing outside',
    call: read('out/x'),
    open: { read: ['**'] },
    want: 'read',
    mention: 'out/x',
  },
  {
    label: 'paths: a write into .git',
    call: write('.git/config'),
    open: { write: ['**'] },
    want: 'write',
    mention: '.git',
  },
  {
    label: 'paths: a write into $STAGE_IN',
    call: write('$STAGE_IN/brief.md'),
    open: { write: ['**', '$STAGE_OUT/**'] },
    want: 'write',
    mention: '$STAGE_IN',
  },
  {
    label: 'paths: an input redirection is a read',
    call: bash('sort < src/a.ts'),
    open: { commands: ['sort *'] },
    want: 'read',
    mention: 'src/a.ts',
  },
  {
    label: "paths: git diff's --output outside is a write",
    call: bash(`git diff --output=${elsewhere}/x`),
    open: { commands: ['git diff *'] },
    want: 'write',
    mention: elsewhere,
  },
];

const RULES: readonly string[] = ['read', 'write', 'commands', 'tools'];

test.each(TABLE.map((row) => [row.label, row] as const))('%s', (_, row) => {
  const decision = decide(row.call, perms(row.open), layout.ctx);
  const mention = row.mention ?? '';
  const seen = decision.allow
    ? 'allow'
    : [decision.rule, decision.reason.includes(mention) ? mention : decision.reason];
  expect(seen).toEqual(row.want === 'allow' ? 'allow' : [row.want, mention]);
});

test('every denial explains itself: one of the four rules, and a reason naming the refused path, command or tool', () => {
  const denying = TABLE.filter((row) => row.want !== 'allow');
  const explained = denying.map((row) => {
    const decision = decide(row.call, perms(row.open), layout.ctx);
    if (decision.allow) return [row.label, 'allowed'];
    return [
      row.label,
      RULES.includes(decision.rule),
      decision.reason.trim() !== '' && decision.reason.includes(row.mention ?? '\0'),
    ];
  });
  expect(explained).toEqual(denying.map((row) => [row.label, true, true]));
  expect([TABLE.length >= 40, denying.length >= 30]).toEqual([true, true]);
});

test('the permission engine imports nothing but node:fs, node:path, the SDK types and its own modules', () => {
  const dir = join(import.meta.dir, '..', '..', 'src', 'engine', 'permissions');
  const files = readdirSync(dir).filter((name) => name.endsWith('.ts'));
  const found = files.flatMap((name) =>
    [
      ...readFileSync(join(dir, name), 'utf8').matchAll(
        /\bfrom\s+'([^']+)'|\bimport\s*\(\s*'([^']+)'|\brequire\s*\(\s*'([^']+)'/g,
      ),
    ].map((match) => match[1] ?? match[2] ?? match[3]),
  );
  const allowed = /^(?:node:fs|node:path|\.\.\/\.\.\/sdk\/steps|\.\/[a-z-]+)$/;
  expect(files.length).toBeGreaterThanOrEqual(7);
  expect(found.filter((specifier) => !allowed.test(specifier ?? ''))).toEqual([]);
});
