// The interim fail-closed file guard (D1): file tools reach only the run's own directories, `..` and symlinks resolved,
// StructuredOutput is allowed, and every other tool is denied with a reason, which onDenied hears.
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { createFileGuard, FILE_TOOLS } from '../../../src/adapters/claude-code/guard';

// A base under the system's temp folder, which on macOS is itself reached through a symlink, so the roots are given by
// a path that is not their real one.
const base = mkdtempSync(join(tmpdir(), 'sail-guard-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const cwd = join(base, 'work');
const stageIn = join(base, 'in');
const stageOut = join(base, 'out');
for (const dir of [cwd, join(cwd, 'src'), stageIn, stageOut, join(base, 'work-other'), join(base, 'elsewhere')]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(join(cwd, 'src', 'a.ts'), 'a\n');
writeFileSync(join(stageIn, 'brief.md'), '# Brief\n');
writeFileSync(join(base, 'outside.txt'), 'secret\n');
writeFileSync(join(base, 'elsewhere', 'secret.txt'), 'secret\n');
symlinkSync(join(base, 'elsewhere'), join(cwd, 'link'));
const real = realpathSync(base);
const ROOTS = [join(real, 'work'), join(real, 'in'), join(real, 'out')].join(', ');

/** A guard over the run's three directories, and every denial it reported. */
function guard(): { canUseTool: CanUseTool; denied: [string, string][] } {
  const denied: [string, string][] = [];
  const canUseTool = createFileGuard({
    roots: [cwd, stageIn, stageOut],
    cwd,
    onDenied: (toolUseId, reason) => denied.push([toolUseId, reason]),
  });
  return { canUseTool, denied };
}

const ask = (canUseTool: CanUseTool, tool: string, input: Record<string, unknown>, toolUseID = 'call-1') =>
  canUseTool(tool, input, { signal: new AbortController().signal, toolUseID, requestId: 'r1' });

test('the session has the five file tools and no other', () => {
  expect([...FILE_TOOLS]).toEqual(['Read', 'Glob', 'Grep', 'Write', 'Edit']);
});

test.each<[string, string, Record<string, unknown>]>([
  ['Read of a file in the workspace, by its absolute path', 'Read', { file_path: join(cwd, 'src', 'a.ts') }],
  ['Read of a file in the workspace, by its real path', 'Read', { file_path: join(real, 'work', 'src', 'a.ts') }],
  ['Edit of a relative path', 'Edit', { file_path: 'src/a.ts' }],
  ['Read through .. that stays inside', 'Read', { file_path: 'src/../src/a.ts' }],
  ['Read of $STAGE_IN', 'Read', { file_path: join(stageIn, 'brief.md') }],
  ['Write of a new file in a new folder of $STAGE_OUT', 'Write', { file_path: join(stageOut, 'notes', 'spec.md') }],
  ['Glob with no path', 'Glob', { pattern: '**/*.ts' }],
  ['Grep of a relative folder', 'Grep', { pattern: 'a', path: 'src' }],
  ['StructuredOutput, whatever its input', 'StructuredOutput', { outcome: 'done', output: { anything: true } }],
])('allows %s', async (_, tool, input) => {
  const { canUseTool, denied } = guard();
  expect(await ask(canUseTool, tool, input)).toEqual({ behavior: 'allow', updatedInput: input });
  expect(denied).toEqual([]);
});

test.each<[string, string, string]>([
  ['an absolute path outside every root', 'Read', '/etc/hosts'],
  ['.. out of the workspace', 'Read', '../outside.txt'],
  ['a symlink in the workspace that leads out of it', 'Read', 'link/secret.txt'],
  ['a new file through that symlink', 'Write', 'link/new.txt'],
  ["a root's sibling that shares its name as a prefix", 'Write', join(base, 'work-other', 'x.ts')],
  ['Grep of the parent folder', 'Grep', '..'],
])('denies %s, naming the path and the roots, and tells onDenied', async (_, tool, path) => {
  const { canUseTool, denied } = guard();
  const reason = `${tool} of ${path} is outside the run's directories: ${ROOTS}`;
  const input = tool === 'Grep' ? { pattern: 'x', path } : { file_path: path };
  expect(await ask(canUseTool, tool, input, 'toolu_9')).toEqual({ behavior: 'deny', message: reason });
  expect(denied).toEqual([['toolu_9', reason]]);
});

// Review R1-2: the CLI expands a leading `~` to the home folder and trims a path, so the guard must not read either as a
// folder inside the workspace.
test.each<[string, string, Record<string, unknown>, string]>([
  ['Read of a ~ path', 'Read', { file_path: '~/.ssh/id_rsa' }, '~/.ssh/id_rsa'],
  ['Write of a bare ~', 'Write', { file_path: '~' }, '~'],
  ['Grep of ~', 'Grep', { pattern: '.', path: '~' }, '~'],
  ['Glob of a ~ folder', 'Glob', { pattern: '*', path: '~/.aws' }, '~/.aws'],
  ['Edit of a ~ path behind a space', 'Edit', { file_path: ' ~/.zshrc' }, ' ~/.zshrc'],
])('denies %s, since the CLI reads it from the home folder', async (_, tool, input, shown) => {
  const { canUseTool, denied } = guard();
  const reason = `${tool} of ${shown}: a path through ~ is not allowed, name it in full`;
  expect(await ask(canUseTool, tool, input, 'toolu_7')).toEqual({ behavior: 'deny', message: reason });
  expect(denied).toEqual([['toolu_7', reason]]);
});

test.each<[string, string, Record<string, unknown>, string]>([
  ['Read of an absolute path behind a space', 'Read', { file_path: ' /etc/hosts' }, ' /etc/hosts'],
  ['Grep of the parent folder behind a space', 'Grep', { pattern: 'x', path: ' ..' }, ' ..'],
])('denies %s, which the CLI trims to a path outside', async (_, tool, input, shown) => {
  const { canUseTool } = guard();
  const reason = `${tool} of ${shown} is outside the run's directories: ${ROOTS}`;
  expect(await ask(canUseTool, tool, input)).toEqual({ behavior: 'deny', message: reason });
});

test('allows a workspace path with a trailing space, inside whether trimmed or not', async () => {
  const input = { file_path: 'src/a.ts ' };
  expect(await ask(guard().canUseTool, 'Read', input)).toEqual({ behavior: 'allow', updatedInput: input });
});

// Review R1-1: an absolute Glob pattern searches from its own folder, ahead of `path`, so the pattern's folder is
// checked as a path is.
test.each<[string, Record<string, unknown>, string]>([
  ['an absolute pattern outside every root', { pattern: '/etc/*' }, "Glob of /etc/* is outside the run's directories"],
  [
    'an absolute pattern outside, beside a path inside',
    { pattern: join(base, 'elsewhere', '*'), path: '.' },
    `Glob of ${join(base, 'elsewhere', '*')} is outside the run's directories`,
  ],
  [
    'a pattern that climbs out of the workspace',
    { pattern: '../elsewhere/*' },
    "Glob of ../elsewhere/* is outside the run's directories",
  ],
  [
    'a pattern that climbs out of its path',
    { pattern: '../../*', path: 'src' },
    "Glob of ../../* is outside the run's directories",
  ],
  ['a ~ pattern', { pattern: '~/.ssh/*' }, 'Glob of ~/.ssh/*: a path through ~ is not allowed, name it in full'],
  [
    'a pattern that climbs after a wildcard',
    { pattern: 'src/*/../../../elsewhere/*' },
    'Glob of src/*/../../../elsewhere/*: a pattern may not climb with .. after a wildcard',
  ],
  ['a pattern that is not a string', { pattern: 3 }, 'Glob needs pattern as a string'],
])('denies Glob with %s', async (_, input, start) => {
  const { canUseTool, denied } = guard();
  const answer = await ask(canUseTool, 'Glob', input, 'toolu_8');
  expect(answer).toMatchObject({ behavior: 'deny' });
  expect((answer as { message: string }).message.startsWith(start)).toBe(true);
  expect(denied).toHaveLength(1);
});

test.each<[string, Record<string, unknown>]>([
  ['an absolute pattern inside the workspace', { pattern: join(cwd, 'src', '*.ts') }],
  [
    'an absolute pattern in $STAGE_IN, beside the workspace as its path',
    { pattern: join(stageIn, '**', '*.md'), path: cwd },
  ],
  ['a pattern that climbs and comes back', { pattern: '../work/src/*.ts' }],
  ['a pattern with a wildcard first', { pattern: '**/*.ts', path: 'src' }],
])('allows Glob with %s', async (_, input) => {
  expect(await ask(guard().canUseTool, 'Glob', input)).toEqual({ behavior: 'allow', updatedInput: input });
});

test('every tool but the file tools and StructuredOutput is denied, without interrupting the session', async () => {
  const { canUseTool, denied } = guard();
  const tools = ['Bash', 'WebFetch', 'WebSearch', 'mcp__x__y', 'Task', 'NotebookEdit', 'Unheard'];
  const answers = [];
  for (const tool of tools) answers.push(await ask(canUseTool, tool, { command: 'ls' }, `id-${tool}`));
  const reason = (tool: string) =>
    `the claude-code harness allows only file tools until permissions are enforced: ${tool} is not one`;
  expect(answers).toEqual(tools.map((tool) => ({ behavior: 'deny', message: reason(tool) })));
  expect(denied).toEqual(tools.map((tool) => [`id-${tool}`, reason(tool)]));
});

test('a file tool whose path is not a string is denied', async () => {
  const { canUseTool, denied } = guard();
  const answers = [
    await ask(canUseTool, 'Read', { file_path: 3 }),
    await ask(canUseTool, 'Write', { content: 'x' }),
    await ask(canUseTool, 'Glob', { pattern: '*', path: null }),
  ];
  expect(answers).toEqual([
    { behavior: 'deny', message: 'Read needs file_path as a string' },
    { behavior: 'deny', message: 'Write needs file_path as a string' },
    { behavior: 'deny', message: 'Glob needs path as a string' },
  ]);
  expect(denied).toHaveLength(3);
});
