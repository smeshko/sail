// The deny set: the commands no step's permissions can allow, matched on argv after git's global options (D10).
import { expect, test } from 'bun:test';
import {
  DENY_SET,
  denied,
  deniedAssignment,
  deniedPipeline,
  gitInvocation,
} from '../../../src/engine/permissions/deny';

const words = (text: string): string[] => text.split(' ');

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  .each([
  ['git -C . checkout x', { globals: [{ name: '-C', value: '.' }], subcommand: 'checkout', args: ['x'] }],
  ['git --no-pager switch y', { globals: [{ name: '--no-pager' }], subcommand: 'switch', args: ['y'] }],
  ['git -c a=b checkout z', { globals: [{ name: '-c', value: 'a=b' }], subcommand: 'checkout', args: ['z'] }],
  [
    'git --git-dir=/x --work-tree /y -p log -1',
    {
      globals: [{ name: '--git-dir', value: '/x' }, { name: '--work-tree', value: '/y' }, { name: '-p' }],
      subcommand: 'log',
      args: ['-1'],
    },
  ],
  [
    'git --namespace=n --config-env=a=B --exec-path=/tmp --bare status',
    {
      globals: [
        { name: '--namespace', value: 'n' },
        { name: '--config-env', value: 'a=B' },
        { name: '--exec-path', value: '/tmp' },
        { name: '--bare' },
      ],
      subcommand: 'status',
      args: [],
    },
  ],
  ['git --version', { globals: [{ name: '--version' }], args: [] }],
  ['git --frobnicate status', { globals: [], args: ['status'], unknown: '--frobnicate' }],
])('gitInvocation(%j) skips the global options to the subcommand', (text, expected) => {
  expect(gitInvocation(words(text))).toEqual(expected);
});

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  .each([
  ['rm -rf x', 'rm -rf'],
  ['rm -fr x', 'rm -rf'],
  ['rm -r -f x', 'rm -rf'],
  ['rm -Rf x', 'rm -rf'],
  ['rm --recursive --force x', 'rm -rf'],
  ['/bin/rm -rf x', 'rm -rf'],
  ['find . -name x -delete', 'find -delete'],
  ['git push --force', 'git push --force'],
  ['git push -f origin x', 'git push --force'],
  ['git push --force-with-lease', 'git push --force'],
  ['git push --force-if-includes', 'git push --force'],
  ['git push --mirror', 'git push --force'],
  ['git push origin +main', 'git push --force'],
  ['git reset --hard', 'git reset --hard'],
  ['git clean -fd', 'git clean -f'],
  ['git clean -x -f', 'git clean -f'],
  ['git branch -D x', 'git branch -D'],
  ['git branch --delete --force x', 'git branch -D'],
  ['git branch -df x', 'git branch -D'],
  ['git checkout main', 'git checkout'],
  ['git checkout -- a.ts', 'git checkout'],
  ['git -C . checkout x', 'git checkout'],
  ['git --no-pager switch y', 'git switch'],
  ['git switch -c other', 'git switch'],
  ['sudo ls', 'sudo'],
  ['doas ls', 'sudo'],
  ['git -c alias.x=!sh x', 'git -c'],
  ['git -c core.pager=less log', 'git -c'],
  ['git --config-env=a=B status', 'git -c'],
  ['git --exec-path=/tmp status', 'git -c'],
])('denied: %j falls under %s', (text, name) => {
  expect(denied(words(text))?.name).toBe(name);
});

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  .each([
  'rm a.txt',
  'rm -r dir',
  'rm -f a.txt',
  'rm -r -- -f',
  'git push origin HEAD:sail/x',
  'git reset --soft HEAD~1',
  'git clean -n',
  'git branch -d x',
  'git log --format=%H',
  'git --exec-path',
  'find . -name x',
])('not denied: %j', (text) => {
  expect(denied(words(text))).toBeUndefined();
});

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('a quoted argument is one word: a commit message or a grep pattern naming a denied command is no command', () => {
  expect(denied(['git', 'commit', '-m', 'rm -rf is denied'])).toBeUndefined();
  expect(denied(['grep', '-r', 'git checkout', '.'])).toBeUndefined();
});

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  .each([
  [[['curl', '-s', 'https://x'], ['sh']], 'curl | sh'],
  [[['wget', '-qO-', 'x'], ['bash']], 'curl | sh'],
  [
    [
      ['curl', 'x'],
      ['sudo', 'bash'],
    ],
    'curl | sh',
  ],
  [[['curl', 'x'], ['tee', 'f'], ['/bin/sh']], 'curl | sh'],
  [
    [
      ['curl', 'x'],
      ['jq', '.'],
    ],
    undefined,
  ],
  [[['curl', '-o', 'f', 'x']], undefined],
  [[['sh'], ['curl', 'x']], undefined],
])('pipelines: %j is %s', (argvs, name) => {
  expect(deniedPipeline(argvs)?.name).toBe(name);
});

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('curl x | sudo bash hits both entries: the pipeline one, and sudo on its own command', () => {
  expect([
    deniedPipeline([
      ['curl', 'x'],
      ['sudo', 'bash'],
    ])?.name,
    denied(['sudo', 'bash'])?.name,
  ]).toEqual(['curl | sh', 'sudo']);
});

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('an assignment that changes which program runs, or makes one run another, is an environment override', () => {
  const names = [
    'PATH',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'BASH_ENV',
    'IFS',
    'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_COUNT',
    'GIT_SSH_COMMAND',
    'GIT_PAGER',
    'GIT_EXTERNAL_DIFF',
    'PAGER',
    'FOO',
    'CI',
    'NODE_ENV',
    'GIT_DIR',
    'GIT_AUTHOR_NAME',
  ];
  expect(names.map((name) => [name, deniedAssignment(name)?.name])).toEqual([
    ['PATH', 'environment override'],
    ['LD_PRELOAD', 'environment override'],
    ['DYLD_INSERT_LIBRARIES', 'environment override'],
    ['BASH_ENV', 'environment override'],
    ['IFS', 'environment override'],
    ['GIT_CONFIG_PARAMETERS', 'environment override'],
    ['GIT_CONFIG_COUNT', 'environment override'],
    ['GIT_SSH_COMMAND', 'environment override'],
    ['GIT_PAGER', 'environment override'],
    ['GIT_EXTERNAL_DIFF', 'environment override'],
    ['PAGER', 'environment override'],
    ['FOO', undefined],
    ['CI', undefined],
    ['NODE_ENV', undefined],
    ['GIT_DIR', undefined],
    ['GIT_AUTHOR_NAME', undefined],
  ]);
});

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('the deny set holds its entries in order, each with one readable clause of why', () => {
  expect(DENY_SET.map((entry) => entry.name)).toEqual([
    'rm -rf',
    'find -delete',
    'git push --force',
    'git reset --hard',
    'git clean -f',
    'git branch -D',
    'git checkout',
    'git switch',
    'sudo',
    'git -c',
  ]);
  for (const entry of DENY_SET) expect(entry.why).toMatch(/^[a-z][^.\n]{10,120}$/);
});

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ("git checkout and git switch cite ADR-0018's reason: an agent never changes branches in its worktree", () => {
  const why = (name: string) => DENY_SET.find((entry) => entry.name === name)?.why ?? '';
  for (const name of ['git checkout', 'git switch']) {
    expect(why(name)).toContain('never changes branches');
    expect(why(name)).toContain('ADR-0018');
  }
});
