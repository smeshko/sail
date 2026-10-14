// Claude Code's tool calls in the permission engine's terms: one row per tool and per edge the mapping refuses or
// widens, then the session's tool set from a step's permissions (D2, D8, D10).
import { expect, test } from 'bun:test';
import { BUILTIN_TOOLS, sessionTools, toToolCall } from '../../../src/adapters/claude-code/tool-call';
import type { Permissions } from '../../../src/engine/permissions/types';

const CWD = '/w';
const call = (fields: Record<string, unknown>) => ({ call: { paths: [], cwd: CWD, ...fields } });
const read = (tool: string, paths: string[]) => call({ tool, kind: 'read', paths });
const unchecked = (kind: string, why: string) => ({ unchecked: why, kind });
const TILDE = 'a path through ~ is not allowed, name it in full';

test.each<[string, string, unknown, unknown, string?]>([
  [
    'Bash runs its command from the cwd',
    'Bash',
    { command: 'git status' },
    call({ tool: 'Bash', kind: 'execute', command: 'git status' }),
  ],
  [
    'Bash in the foreground is checked as usual',
    'Bash',
    { command: 'ls', run_in_background: false },
    call({ tool: 'Bash', kind: 'execute', command: 'ls' }),
  ],
  [
    'Bash in the background is refused',
    'Bash',
    { command: 'npm test', run_in_background: true },
    unchecked('execute', 'a background command can outlive the session'),
  ],
  [
    'Bash with a command that is no string',
    'Bash',
    { command: ['ls'] },
    unchecked('execute', 'Bash needs command as a string'),
  ],
  ['Bash with no input at all', 'Bash', null, unchecked('execute', 'Bash needs command as a string')],
  ['Read of a relative path', 'Read', { file_path: 'src/a.ts' }, read('Read', ['src/a.ts'])],
  ['Read whose path is no string', 'Read', { file_path: 3 }, unchecked('read', 'Read needs file_path as a string')],
  [
    'Write of an absolute path',
    'Write',
    { file_path: '/tmp/x' },
    call({ tool: 'Write', kind: 'write', paths: ['/tmp/x'] }),
  ],
  ['Edit is an edit', 'Edit', { file_path: 'a.ts' }, call({ tool: 'Edit', kind: 'edit', paths: ['a.ts'] })],
  [
    'NotebookEdit edits its notebook_path',
    'NotebookEdit',
    { notebook_path: 'n.ipynb' },
    call({ tool: 'NotebookEdit', kind: 'edit', paths: ['n.ipynb'] }),
  ],
  [
    'NotebookEdit with no notebook_path',
    'NotebookEdit',
    { file_path: 'n.ipynb' },
    unchecked('edit', 'NotebookEdit needs notebook_path as a string'),
  ],
  [
    'Glob of a relative pattern searches its folder below the cwd',
    'Glob',
    { pattern: 'src/*.ts' },
    read('Glob', ['/w', '/w/src']),
  ],
  ['Glob of an absolute pattern searches its own folder', 'Glob', { pattern: '/etc/*' }, read('Glob', ['/w', '/etc'])],
  [
    'Glob with a path and a pattern that starts wild',
    'Glob',
    { pattern: '*.md', path: 'docs' },
    read('Glob', ['docs']),
  ],
  [
    'Glob with a path joins the pattern folder to it',
    'Glob',
    { pattern: 'lib/**/*.ts', path: 'pkg' },
    read('Glob', ['pkg', 'pkg/lib']),
  ],
  [
    'Glob climbing from its path keeps the climb for the kernel, and normalised',
    'Glob',
    { pattern: '../*', path: 'link' },
    read('Glob', ['link', 'link/..', '/w']),
  ],
  [
    'Glob climbing after a wildcard is refused',
    'Glob',
    { pattern: '**/../x' },
    unchecked('read', 'Glob of **/../x: a pattern may not climb with .. after a wildcard'),
  ],
  ['Glob whose pattern is no string', 'Glob', { pattern: 3 }, unchecked('read', 'Glob needs pattern as a string')],
  ['Glob of a ~ folder', 'Glob', { pattern: '*', path: '~/.aws' }, unchecked('read', `Glob of ~/.aws: ${TILDE}`)],
  ['Grep with no path searches the cwd', 'Grep', { pattern: 'x' }, read('Grep', ['/w'])],
  ['Grep of a folder', 'Grep', { pattern: 'x', path: 'src' }, read('Grep', ['src'])],
  [
    'Grep of the parent folder, as given and normalised',
    'Grep',
    { pattern: 'x', path: '..' },
    read('Grep', ['..', '/']),
  ],
  [
    'Read through .. is also checked normalised',
    'Read',
    { file_path: 'a/../../etc/passwd' },
    read('Read', ['a/../../etc/passwd', '/etc/passwd']),
  ],
  ['an MCP tool by its name', 'mcp__linear__get_issue', {}, call({ tool: 'get_issue', kind: 'mcp', server: 'linear' })],
  [
    'an MCP tool whose server the CLI names',
    'mcp__team__linear__get_issue',
    {},
    call({ tool: 'get_issue', kind: 'mcp', server: 'team__linear' }),
    'team__linear',
  ],
  [
    'the same MCP tool, split at the first __ when no server is named',
    'mcp__team__linear__get_issue',
    {},
    call({ tool: 'linear__get_issue', kind: 'mcp', server: 'team' }),
  ],
  ['an MCP name with no tool', 'mcp__x', {}, unchecked('mcp', 'mcp__x names no MCP tool')],
  ['an MCP name with an empty tool', 'mcp__x__', {}, unchecked('mcp', 'mcp__x__ names no MCP tool')],
  [
    'WebFetch is matched by its name',
    'WebFetch',
    { url: 'https://example.com', prompt: 'x' },
    call({ tool: 'WebFetch', kind: 'other' }),
  ],
  ['a tool no one knows', 'Frobnicate', { file_path: '/etc/hosts' }, call({ tool: 'Frobnicate', kind: 'other' })],
  ['Read of a ~ path', 'Read', { file_path: '~/x' }, unchecked('read', `Read of ~/x: ${TILDE}`)],
  ['Read of a ~ path behind a space', 'Read', { file_path: ' ~/x' }, unchecked('read', `Read of  ~/x: ${TILDE}`)],
  [
    'Write of a padded path, as given and trimmed',
    'Write',
    { file_path: ' /etc/hosts' },
    call({ tool: 'Write', kind: 'write', paths: [' /etc/hosts', '/etc/hosts'] }),
  ],
  [
    'Write of a $VAR path, which the CLI never expands',
    'Write',
    { file_path: '$STAGE_OUT/spec.md' },
    unchecked('write', "Write of $STAGE_OUT/spec.md: the CLI doesn't expand variables, name the path in full"),
  ],
])('%s', (_, tool, input, expected, ...mcpServer) => {
  // A rest parameter: a fifth named one would read to Bun as a done callback.
  expect(toToolCall(tool, input, CWD, mcpServer[0])).toEqual(expected as ReturnType<typeof toToolCall>);
});

test("a call's cwd is the one the CLI reports, on every kind", () => {
  const cwds = [
    toToolCall('Bash', { command: 'ls' }, '/w/sub'),
    toToolCall('Read', { file_path: 'a' }, '/w/sub'),
    toToolCall('mcp__a__b', {}, '/w/sub'),
    toToolCall('WebSearch', { query: 'x' }, '/w/sub'),
  ].map((mapped) => ('call' in mapped ? mapped.call.cwd : mapped.unchecked));
  expect(cwds).toEqual(['/w/sub', '/w/sub', '/w/sub', '/w/sub']);
});

const READ_ONLY: Permissions = { read: ['**'], write: [], commands: [] };
const SPEC_STAGE: Permissions = {
  read: ['**'],
  write: ['$STAGE_OUT/**'],
  commands: ['git log *', 'git diff *'],
};

test.each<[string, Permissions, string[]]>([
  ['a read-only step reads, globs and greps', READ_ONLY, ['Read', 'Glob', 'Grep']],
  [
    "the fixture's spec stage also writes, edits and runs commands",
    SPEC_STAGE,
    ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'],
  ],
  [
    'a listed built-in joins the set, a server tool does not',
    { ...READ_ONLY, tools: ['WebFetch', 'linear:get_issue'] },
    ['Read', 'Glob', 'Grep', 'WebFetch'],
  ],
])('%s, and every other built-in is disallowed, never the submission', (_, permissions, tools) => {
  const set = sessionTools(permissions);
  expect({
    tools: set.tools,
    overlap: set.disallowedTools.filter((name) => set.tools.includes(name)),
    submission: set.disallowedTools.includes('StructuredOutput'),
    together: [...set.tools, ...set.disallowedTools].sort(),
  }).toEqual({ tools, overlap: [], submission: false, together: [...BUILTIN_TOOLS].sort() });
});

test("a read-only step's disallowed tools hold the shell, the writers, the web, subagents and plans", () => {
  const { disallowedTools } = sessionTools(READ_ONLY);
  const risky = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'TodoWrite'];
  expect(risky.filter((name) => !disallowedTools.includes(name))).toEqual([]);
});
