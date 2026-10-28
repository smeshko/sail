// pi's tool calls in sail's own terms: each call becomes the permission engine's ToolCall or the reason it can't be
// checked, and a step's permissions give the session its built-in tools.
import { expect, test } from 'bun:test';
import { PI_TOOLS, SUBMIT_TOOL, sessionTools, toToolCall } from '../../../src/adapters/pi/tool-call';
import type { Permissions } from '../../../src/engine/permissions/types';

const CWD = '/work/tree';

test('the built-ins pi offers are read, write, edit, bash, grep, find and ls, and the submission is named submit', () => {
  expect({ tools: [...PI_TOOLS], submit: SUBMIT_TOOL }).toEqual({
    tools: ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'],
    submit: 'submit',
  });
});

test('read, write and edit map to a call on their path', () => {
  expect({
    read: toToolCall('read', { path: 'src/a.ts' }, CWD),
    write: toToolCall('write', { path: 'out.md', content: 'x' }, CWD),
    edit: toToolCall('edit', { path: 'src/a.ts', edits: [] }, CWD),
  }).toEqual({
    read: { call: { tool: 'read', kind: 'read', paths: ['src/a.ts'], cwd: CWD } },
    write: { call: { tool: 'write', kind: 'write', paths: ['out.md'], cwd: CWD } },
    edit: { call: { tool: 'edit', kind: 'edit', paths: ['src/a.ts'], cwd: CWD } },
  });
});

test('bash maps to an execute call carrying its command', () => {
  expect(toToolCall('bash', { command: 'git status' }, CWD)).toEqual({
    call: { tool: 'bash', kind: 'execute', paths: [], command: 'git status', cwd: CWD },
  });
});

test('a bash command sent to the background is unchecked, with the reason refusedCommand gives', () => {
  expect(toToolCall('bash', { command: 'sleep 9 &' }, CWD)).toEqual({
    unchecked: 'a command run in the background with & can outlive the session',
    kind: 'execute',
  });
});

test('grep, find and ls map to a read of their path, or of the working directory without one', () => {
  expect({
    grep: toToolCall('grep', { pattern: 'x', path: 'src' }, CWD),
    find: toToolCall('find', { pattern: '*.ts' }, CWD),
    ls: toToolCall('ls', {}, CWD),
  }).toEqual({
    grep: { call: { tool: 'grep', kind: 'read', paths: ['src'], cwd: CWD } },
    find: { call: { tool: 'find', kind: 'read', paths: [CWD], cwd: CWD } },
    ls: { call: { tool: 'ls', kind: 'read', paths: [CWD], cwd: CWD } },
  });
});

test('a path through ~ or a $ variable is unchecked, and a padded or climbing path is checked in every form', () => {
  expect({
    home: toToolCall('read', { path: '~/.ssh/id' }, CWD),
    variable: toToolCall('write', { path: '$HOME/x' }, CWD),
    padded: toToolCall('read', { path: ' a.md ' }, CWD),
    climbing: toToolCall('read', { path: '../x' }, CWD),
  }).toEqual({
    home: { unchecked: 'read of ~/.ssh/id: a path through ~ is not allowed, name it in full', kind: 'read' },
    variable: { unchecked: "write of $HOME/x: pi doesn't expand variables, name the path in full", kind: 'write' },
    padded: { call: { tool: 'read', kind: 'read', paths: [' a.md ', 'a.md'], cwd: CWD } },
    climbing: { call: { tool: 'read', kind: 'read', paths: ['../x', '/work/x'], cwd: CWD } },
  });
});

test('a find pattern that is absolute or climbs is unchecked, since it searches beyond its path', () => {
  expect({
    absolute: toToolCall('find', { pattern: '/etc/**' }, CWD),
    climbing: toToolCall('find', { pattern: '../**/*.ts' }, CWD),
  }).toEqual({
    absolute: { unchecked: 'find of /etc/**: a pattern must stay below its path', kind: 'read' },
    climbing: { unchecked: 'find of ../**/*.ts: a pattern must stay below its path', kind: 'read' },
  });
});

test('a tool the gate does not know is unchecked, under the kind its name suggests', () => {
  expect({
    unknown: toToolCall('web_fetch', { url: 'http://x' }, CWD),
    shellish: toToolCall('bash2', {}, CWD),
  }).toEqual({
    unknown: { unchecked: 'web_fetch is no tool the gate knows', kind: 'other' },
    shellish: { unchecked: 'bash2 is no tool the gate knows', kind: 'other' },
  });
});

test('a call missing its path or command is unchecked', () => {
  expect({
    path: toToolCall('read', {}, CWD),
    command: toToolCall('bash', { command: 3 }, CWD),
  }).toEqual({
    path: { unchecked: 'read needs path as a string', kind: 'read' },
    command: { unchecked: 'bash needs command as a string', kind: 'execute' },
  });
});

test('a session is offered the reads always, the writes with a write glob and bash with a command', () => {
  const none: Permissions = { read: ['**'], write: [], commands: [] };
  expect({
    reads: sessionTools(none),
    writes: sessionTools({ ...none, write: ['out/**'] }),
    shell: sessionTools({ ...none, commands: ['ls *'] }),
  }).toEqual({
    reads: ['read', 'grep', 'find', 'ls'],
    writes: ['read', 'grep', 'find', 'ls', 'write', 'edit'],
    shell: ['read', 'grep', 'find', 'ls', 'bash'],
  });
});
