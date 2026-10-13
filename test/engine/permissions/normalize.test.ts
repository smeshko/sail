import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { type NormalizedCommand, normalize } from '../../../src/engine/permissions/normalize';
import { tokenize } from '../../../src/engine/permissions/tokenize';
import { Refusal, type Rule } from '../../../src/engine/permissions/types';
import { type PermissionRoots, permissionRoots } from '../../helpers/permission-roots';
import { withTempRepo } from '../../helpers/temp-repo';

/** Runs `fn` inside a temporary repository whose roots are real directories. */
const inRoots = (fn: (p: PermissionRoots) => void): Promise<void> =>
  withTempRepo((repo) => {
    fn(permissionRoots(repo));
  });

/** The normalized commands of a command string. */
function normalized(command: string, p: PermissionRoots): NormalizedCommand[] {
  return normalize(tokenize(command), p.roots);
}

/** The rule of the refusal `run` throws, or undefined when it does not refuse. Other errors propagate. */
function refusalRule(run: () => unknown): Rule | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    if (error instanceof Refusal) return error.rule;
    throw error;
  }
}

test('an env assignment before a command is stripped into env, and argv keeps the command', () =>
  inRoots((p) => {
    const commands = normalized('env FOO=1 npm test -- a.test.ts', p);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.argv).toEqual(['npm', 'test', '--', 'a.test.ts']);
    expect(commands[0]?.env).toEqual({ FOO: '1' });
  }));

test.each([['command'], ['exec'], ['nohup'], ['time']])('the %s wrapper is stripped before matching', (wrapper) =>
  inRoots((p) => {
    const commands = normalized(`${wrapper} rm x`, p);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.argv).toEqual(['rm', 'x']);
  }),
);

test('env with options is refused as unparseable', () =>
  inRoots((p) => {
    expect(refusalRule(() => normalized('env -i FOO=1 npm test', p))).toBe('command:unparseable');
  }));

test.each([
  ['bash -c "rm -rf ."', ['rm', '-rf', '.']],
  ['sh -lc "rm x"', ['rm', 'x']],
  ['eval "rm -rf ."', ['rm', '-rf', '.']],
])('%s yields its inner command as the one normalized command', (command, argv) =>
  inRoots((p) => {
    expect(normalized(command, p).map((command) => command.argv)).toEqual([argv]);
  }),
);

test.each([['sh script.sh'], ['bash']])('the opaque shell %s is refused as unparseable', (command) =>
  inRoots((p) => {
    expect(refusalRule(() => normalized(command, p))).toBe('command:unparseable');
  }),
);

test.each([
  ['git -C /elsewhere commit', 'git:outside-roots'],
  ['git --git-dir=/x commit', 'git:outside-roots'],
  ['git --work-tree /x commit', 'git:outside-roots'],
  ['GIT_DIR=/x git commit', 'git:outside-roots'],
])('%s is refused as %s', (command, rule) =>
  inRoots((p) => {
    expect(refusalRule(() => normalized(command, p))).toBe(rule as Rule);
  }),
);

test('a GIT_DIR inside the worktree is accepted, and the assignment is kept in env', () =>
  inRoots((p) => {
    const commands = normalized('GIT_DIR=.git git commit', p);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.argv).toEqual(['git', 'commit']);
    expect(commands[0]?.env).toEqual({ GIT_DIR: '.git' });
  }));

test('cd into a directory tracks it, and a redirect in that directory resolves beneath it', () =>
  inRoots((p) => {
    const echo = normalized('cd lib && echo x > a', p).find((command) => command.argv[0] === 'echo');
    expect(echo).toBeDefined();
    expect(echo?.cwd).toBe(join(p.roots.worktree, 'lib'));
    expect(echo?.writes).toEqual([join(p.roots.worktree, 'lib', 'a')]);
  }));

test.each([
  ['cd /etc', 'path:outside-roots'],
  ['cd', 'command:unparseable'],
  ['cd -', 'command:unparseable'],
])('%s is refused as %s', (command, rule) =>
  inRoots((p) => {
    expect(refusalRule(() => normalized(command, p))).toBe(rule as Rule);
  }),
);

test('cp to an absolute path outside the roots, or up and out, is refused as path:outside-roots', () =>
  inRoots((p) => {
    expect(refusalRule(() => normalized('cp x /elsewhere', p))).toBe('path:outside-roots');
    expect(refusalRule(() => normalized('cp x ../up', p))).toBe('path:outside-roots');
  }));

test('npm test with a plain relative argument is not refused', () =>
  inRoots((p) => {
    const commands = normalized('npm test -- a.test.ts', p);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.argv).toEqual(['npm', 'test', '--', 'a.test.ts']);
  }));
