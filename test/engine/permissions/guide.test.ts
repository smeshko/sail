// The section of a session's system prompt on the commands its permissions deny. Its hand-written lines describe
// commands.ts's cd() and git() and shell.ts's operator refusal: each is tied here to decideCommand()'s verdict on an
// example it denies and a rewrite it allows, so a parser change that makes a line untrue fails a test naming the line.
import { afterAll, describe, expect, test } from 'bun:test';
import { decideCommand } from '../../../src/engine/permissions/commands';
import { DENY_SET } from '../../../src/engine/permissions/deny';
import { deniedCommands, denySetNames } from '../../../src/engine/permissions/guide';
import { makeLayout, perms } from '../../helpers/permissions';

const layout = makeLayout();
afterAll(() => layout.remove());

function decide(command: string) {
  return decideCommand(command.replaceAll('<elsewhere>', layout.elsewhere), perms({ commands: ['*'] }), layout.ctx);
}

const lines = deniedCommands().split('\n');
const bullets = lines.filter((line) => line.startsWith('- '));

describe('the section', () => {
  test('starts with its heading and has six bullets', () => {
    expect(lines[0]).toBe('## Commands the permissions deny');
    expect(bullets).toHaveLength(6);
  });
});

describe('the scratch line', () => {
  test('sends scratch files to $TMPDIR', () => {
    expect(bullets.some((line) => line.includes('`$TMPDIR`'))).toBe(true);
  });

  test('allows a write to $TMPDIR with no write globs', () => {
    expect(decide('echo notes > $TMPDIR/notes.txt').allow).toBe(true);
  });

  test('denies the same write outside the workspace', () => {
    expect(decide('echo notes > <elsewhere>/notes.txt').allow).toBe(false);
  });
});

describe('the deny-set line', () => {
  test('names every entry of the deny set, then curl | sh and environment override, in order', () => {
    const names = [...DENY_SET.map((e) => e.name), 'curl | sh', 'environment override'];
    expect(denySetNames()).toEqual(names);
    expect(names).toHaveLength(14);
    const line = deniedCommands().replaceAll('\n  ', ' ');
    for (const name of names) expect(line).toContain(`\`${name}\``);
  });

  test('says what the names that are no command deny', () => {
    const text = deniedCommands().replaceAll('\n  ', ' ');
    expect(text).toContain(
      '`git program option` (an option that names a program, or a template of hooks, for git to run, as in `git push --receive-pack=…` or `git grep -O`)',
    );
    expect(text).toContain(
      '`environment override` (a variable that changes which program runs, or makes one run another command, such as `GIT_SSH_COMMAND=…` or `LD_PRELOAD=…`)',
    );
  });

  test('lists the entries a session meets most', () => {
    for (const name of ['rm -rf', 'git checkout', 'find -delete', 'git -c'])
      expect(deniedCommands()).toContain(`\`${name}\``);
  });
});

describe('the cd line', () => {
  test('names a bare cd and a cd to a path that is no directory', () => {
    const text = deniedCommands().replaceAll('\n  ', ' ');
    expect(text).toContain('a bare `cd`');
    expect(text).toContain('a path that is no directory');
  });

  test.each(['cd <elsewhere>', 'cd -', 'cd ~', 'cd "$(pwd)"', 'cd', 'cd src/a.ts'])('denies %s', (command) => {
    expect(decide(command).allow).toBe(false);
  });

  test('names the scratch folder among the places a cd may go', () => {
    expect(deniedCommands().replaceAll('\n  ', ' ')).toContain(
      'A `cd` is denied when it leaves the workspace, the stage directories and the scratch folder',
    );
  });

  test.each(['cd src', 'git -C src status', 'cd $TMPDIR && ls'])('allows %s', (command) => {
    expect(decide(command).allow).toBe(true);
  });
});

describe('the git line', () => {
  test('denies an argument from a command substitution', () => {
    const decision = decide('B=$(git merge-base origin/main HEAD); git diff $B...HEAD');
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toContain("git's arguments hold an expansion");
  });

  test('says a variable it cannot resolve is denied, and one assigned a literal is fine', () => {
    const text = deniedCommands().replaceAll('\n  ', ' ');
    expect(text).toContain('a variable the guard cannot resolve');
    expect(text).toContain('assigned a literal in the same command');
  });

  test.each(['git diff $HOME', 'git diff $BASE...HEAD'])('denies %s, a variable it cannot resolve', (command) => {
    const decision = decide(command);
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toContain("git's arguments hold an expansion");
  });

  test('allows the value written out', () => {
    expect(decide('git diff abc1234...HEAD').allow).toBe(true);
  });

  test('allows a variable assigned a literal in the same command', () => {
    expect(decide('B=abc1234; git diff $B...HEAD').allow).toBe(true);
  });

  test('allows a variable of "Where you work"', () => {
    expect(decide('git -C $STAGE_OUT status').allow).toBe(true);
  });
});

describe('the operator line', () => {
  test('denies a parameter expansion with an operator', () => {
    const decision = decide('echo ${NAME:-default}');
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toContain('a parameter expansion with an operator');
  });

  test('allows the value written out', () => {
    expect(decide('echo default').allow).toBe(true);
  });
});

describe('the deny-set line, by example', () => {
  test.each([
    ['git push --receive-pack=x origin', 'git program option'],
    ['git grep -O foo', 'git program option'],
    ['GIT_SSH_COMMAND=x git fetch', 'environment override'],
    ['LD_PRELOAD=x ls', 'environment override'],
  ])('denies %s, naming %s', (command, name) => {
    const decision = decide(command);
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toContain(`default deny: ${name}`);
  });

  test('denies rm -rf, naming it', () => {
    const decision = decide('rm -rf build');
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toContain('default deny: rm -rf');
  });
});
