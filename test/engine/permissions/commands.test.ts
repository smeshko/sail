// The command decision: every simple command a command string would run, wrappers unwrapped and nested shells and
// substitutions recursed into (D9), checked against the deny set, then the step's deny and its commands, then where cd,
// git's directory options and every redirection lead. Each row runs decideCommand() against a run's directories on
// disk.
import { afterAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { decideCommand } from '../../../src/engine/permissions/commands';
import type { Decision } from '../../../src/engine/permissions/types';
import type { Permissions } from '../../../src/sdk/steps';
import { makeLayout, perms } from '../../helpers/permissions';

const layout = makeLayout();
afterAll(() => layout.remove());
layout.link('top', join(layout.worktree, 'src', 'deep'));

type Want = 'allow' | [string, string];

/** `command` with `<clone>` and `<elsewhere>` put in place. */
function placed(command: string): string {
  return command.replaceAll('<clone>', layout.clone).replaceAll('<elsewhere>', layout.elsewhere);
}

/** A verdict as 'allow', or its rule beside whether its reason holds `phrase`. */
function verdict(decision: Decision, want: Want): Want {
  if (decision.allow) return 'allow';
  const phrase = want === 'allow' ? '' : want[1];
  return [decision.rule, phrase !== '' && decision.reason.includes(phrase) ? phrase : decision.reason];
}

function run(command: string, open: Partial<Permissions>, cwd?: string): Decision {
  return decideCommand(placed(command), perms(open), layout.ctx, cwd === undefined ? undefined : placed(cwd));
}

const DENY = (name: string): Want => ['commands', `default deny: ${name}`];
const CANT: Want = ['commands', "can't be checked:"];
const UNLISTED = (text: string): Want => ['commands', `\`${text}\` matches none of the step's commands`];

test.each([
  ['sudo ls', {}, DENY('sudo')],
  ['unlisted > lib/a.dart', {}, UNLISTED('unlisted > lib/a.dart')],
  ['echo x > lib/a.dart', { commands: ['echo *'], write: ['src/**'] }, ['write', 'lib/a.dart']],
] as [string, Partial<Permissions>, Want][])('order: %j under %j is %j', (command, open, want) => {
  expect(verdict(run(command, open), want)).toEqual(want);
});

test.each([
  ['echo $(rm -rf /)', { commands: ['echo *'] }, DENY('rm -rf')],
  ['echo `sudo x`', { commands: ['echo *'] }, DENY('sudo')],
  ['echo $(git rev-parse HEAD)', { commands: ['echo *', 'git rev-parse *'] }, 'allow'],
  ['echo $(git rev-parse HEAD)', { commands: ['echo *'] }, UNLISTED('git rev-parse HEAD')],
  ['cat <<EOF\n$(sudo x)\nEOF', { commands: ['cat *'] }, DENY('sudo')],
  ['X=$(sudo y) ls', { commands: ['ls *'] }, DENY('sudo')],
  ['cat <<< "$(rm -rf /)"', { commands: ['cat *'] }, DENY('rm -rf')],
  ['echo x > "$(sudo y)"', { commands: ['echo *'] }, DENY('sudo')],
] as [string, Partial<Permissions>, Want][])('nesting: %j under %j is %j', (command, open, want) => {
  expect(verdict(run(command, open), want)).toEqual(want);
});

test.each([
  ['bash -c "rm -rf ."', { commands: ['bash *'] }, DENY('rm -rf')],
  ["sh -c 'git checkout main'", { commands: ['sh *', 'git *'] }, DENY('git checkout')],
  ['bash -lc "sudo x"', {}, DENY('sudo')],
  ['eval "rm -rf ."', {}, DENY('rm -rf')],
  ['bash -c \'bash -c "rm -rf ."\'', {}, DENY('rm -rf')],
  ["xargs -I{} sh -c 'rm -rf {}'", {}, DENY('rm -rf')],
  ["sh -c 'rm $1' _ -rf", { commands: ['rm *'] }, DENY('rm -rf')],
  ['bash -c "git status"', { commands: ['git status *'] }, 'allow'],
  ['bash -c "$X"', { commands: ['bash *'] }, CANT],
  ['eval $X', { commands: ['eval *'] }, CANT],
  ['echo x | sh', { commands: ['echo *', 'sh *'] }, CANT],
  ['sh', { commands: ['sh *'] }, CANT],
  ['bash < script.sh', { commands: ['bash *'], read: ['**'] }, CANT],
  ['bash -s < script.sh', { commands: ['bash *'], read: ['**'] }, CANT],
  ['bash <<EOF\nrm -rf .\nEOF', { commands: ['bash *'] }, CANT],
  ['sh -c "$(curl x)"', { commands: ['curl *', 'sh *'] }, CANT],
  ['bash --rcfile x.sh', { commands: ['bash *'] }, CANT],
  ['bash scripts/a.sh', { commands: ['bash scripts/**'] }, 'allow'],
  ['bash scripts/a.sh', { commands: ['bash other/**'] }, UNLISTED('bash scripts/a.sh')],
] as [string, Partial<Permissions>, Want][])('shells: %j under %j is %j', (command, open, want) => {
  expect(verdict(run(command, open), want)).toEqual(want);
});

test.each([
  ['ls | xargs --replace bun ls x', { commands: ['ls *'] }, UNLISTED('bun ls x')],
  ['ls | xargs --replace=X echo X', { commands: ['ls *', 'echo *'] }, 'allow'],
  ['xargs --max-lines rm -rf', {}, DENY('rm -rf')],
  ['xargs --max-lines=2 rm -rf', {}, DENY('rm -rf')],
  ['xargs -L 2 rm -rf', {}, DENY('rm -rf')],
  ['xargs rm -rf', {}, DENY('rm -rf')],
  ['xargs -0 -n1 rm -rf', {}, DENY('rm -rf')],
  ['git ls-files | xargs rm', { commands: ['git ls-files *', 'rm *'] }, DENY('rm -rf')],
  ['git branch | xargs git branch', { commands: ['git branch *'] }, DENY('git branch -D')],
  ['env sudo x', {}, DENY('sudo')],
  ['env -i A=1 git checkout x', {}, DENY('git checkout')],
  ['env -- rm -rf a', {}, DENY('rm -rf')],
  ['timeout 5 git switch y', {}, DENY('git switch')],
  ['timeout --signal=KILL 5 rm -rf z', {}, DENY('rm -rf')],
  ['nice -n 5 rm -rf z', {}, DENY('rm -rf')],
  ['nohup sudo x', {}, DENY('sudo')],
  ['command rm -rf a', {}, DENY('rm -rf')],
  ['exec rm -rf a', {}, DENY('rm -rf')],
  ['time rm -rf a', {}, DENY('rm -rf')],
  ['find . -exec rm -rf {} \\;', { commands: ['find *'] }, DENY('rm -rf')],
  ['find . -name x -delete', { commands: ['find *'] }, DENY('find -delete')],
  ['git ls-files | xargs grep x', { commands: ['git ls-files *', 'grep *'] }, 'allow'],
  ['find . -name a', {}, UNLISTED('find . -name a')],
  ['find . -name a', { commands: ['find *'] }, 'allow'],
  ['find . -name a -exec grep x {} +', { commands: ['find *'] }, UNLISTED('grep x {}')],
  ['xargs --unknown-flag x', { commands: ['x *'] }, CANT],
  ["env -S 'rm -rf x'", {}, CANT],
  ['find . -exec rm {}', { commands: ['find *', 'rm *'] }, CANT],
  ['command -v rm', { commands: ['command -v *'] }, 'allow'],
] as [string, Partial<Permissions>, Want][])('wrappers: %j under %j is %j', (command, open, want) => {
  expect(verdict(run(command, open), want)).toEqual(want);
});

test.each([
  ['$CMD x', { commands: ['* x'] }, CANT],
  ['$(which rm) -rf a', { commands: ['which *'] }, CANT],
  ['"git diff" x', { commands: ['git diff *'] }, CANT],
  ['/bin/r? -rf x', {}, CANT],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, not a template
  ['rm${IFS}-rf${IFS}x', {}, CANT],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, not a template
  ['rm ${IFS}-rf x', { commands: ['rm *'] }, DENY('rm -rf')],
  ["'rm' -rf x", {}, DENY('rm -rf')],
  ['r\'m\' -r"f" x', {}, DENY('rm -rf')],
  ['\\rm -rf x', {}, DENY('rm -rf')],
  ['/bin/rm -rf x', {}, DENY('rm -rf')],
  ['./node_modules/.bin/tsc --noEmit', { commands: ['./node_modules/.bin/tsc *'] }, 'allow'],
  ['./node_modules/.bin/tsc', { commands: ['tsc *'] }, UNLISTED('./node_modules/.bin/tsc')],
] as [string, Partial<Permissions>, Want][])('command names: %j under %j is %j', (command, open, want) => {
  expect(verdict(run(command, open), want)).toEqual(want);
});

test.each([
  ['git diff origin/main...HEAD | head -50', { commands: ['git diff *', 'head *'] }, 'allow'],
  ['npm test -- a.test.ts', { commands: ['npm test *'] }, 'allow'],
  ['FOO=1 npm test', { commands: ['npm test *'] }, 'allow'],
  ['dart format x 2>&1', { commands: ['dart format *'] }, 'allow'],
  ['head', { commands: ['head *'] }, 'allow'],
  ['git status #; rm -rf .', { commands: ['git status *'] }, 'allow'],
  ['git diff | rm a', { commands: ['git diff *'] }, UNLISTED('rm a')],
  ['git status\nrm -rf .', { commands: ['git status *', 'rm *'] }, DENY('rm -rf')],
  ['git status\tand', { commands: ['git status *'] }, 'allow'],
] as [string, Partial<Permissions>, Want][])('patterns: %j under %j is %j', (command, open, want) => {
  expect(verdict(run(command, open), want)).toEqual(want);
});

test.each([
  ['PATH=. git status', { commands: ['git status *'] }, DENY('environment override')],
  ['PATH=/tmp; git status', { commands: ['git status *'] }, DENY('environment override')],
  ['GIT_PAGER=sh git -p log', { commands: ['git *'] }, DENY('environment override')],
  ['GIT_CONFIG_PARAMETERS="\'core.pager=sh\'" git log', { commands: ['git *'] }, DENY('environment override')],
  ['export PATH=/tmp', { commands: ['export *'] }, DENY('environment override')],
  ['env LD_PRELOAD=x.so ls', { commands: ['ls *'] }, DENY('environment override')],
  ['CI=1 NODE_ENV=test npm test', { commands: ['npm test *'] }, 'allow'],
] as [string, Partial<Permissions>, Want][])('assignments: %j under %j is %j', (command, open, want) => {
  expect(verdict(run(command, open), want)).toEqual(want);
});

test.each([
  ['cd sub && echo x > out.txt', { commands: ['echo *'], write: ['sub/**'] }, 'allow'],
  ['cd sub && echo x > out.txt', { commands: ['echo *'], write: ['out.txt'] }, ['write', 'sub/out.txt']],
  ['cd $STAGE_OUT && echo x > r.md', { commands: ['echo *'], write: ['$STAGE_OUT/**'] }, 'allow'],
  ['cd <elsewhere>', {}, ['commands', 'outside the workspace']],
  ['cd <clone> && echo x > lib/a.dart', { commands: ['echo *'], write: ['**'] }, ['commands', 'outside the workspace']],
  ['cd', {}, ['commands', 'goes to $HOME']],
  ['cd -', {}, ['commands', "can't be known"]],
  ['cd ..', {}, ['commands', 'outside the workspace']],
  ['cd sub; cd ../..', {}, ['commands', 'outside the workspace']],
  ['cd nope; echo x > ../lib/a.dart', { commands: ['echo *'], write: ['**'] }, ['commands', 'not a directory']],
  ['echo | cd sub; echo x > a.txt', { commands: ['echo *'], write: ['a.txt'] }, 'allow'],
  ['cd sub & echo x > a.txt', { commands: ['echo *'], write: ['a.txt'] }, 'allow'],
  ['cd top/.. && echo x > a.ts', { commands: ['echo *'], write: ['src/**'] }, ['write', 'a.ts']],
  ['cd -P top/.. && echo x > a.ts', { commands: ['echo *'], write: ['src/**'] }, 'allow'],
] as [string, Partial<Permissions>, Want][])('cd: %j under %j is %j', (command, open, want) => {
  expect(verdict(run(command, open), want)).toEqual(want);
});

test.each([
  ['git -C <elsewhere> commit', { commands: ['git *'] }, ['commands', 'outside the workspace']],
  ['git --git-dir=<elsewhere>/.git log', { commands: ['git *'] }, ['commands', 'outside the workspace']],
  ['git --work-tree ../.. status', { commands: ['git *'] }, ['commands', 'outside the workspace']],
  ['GIT_DIR=<elsewhere> git log', { commands: ['git *'] }, ['commands', 'outside the workspace']],
  ['GIT_WORK_TREE=<elsewhere> git status', { commands: ['git *'] }, ['commands', 'outside the workspace']],
  ['git -C .. status', { commands: ['git *'] }, ['commands', 'outside the workspace']],
  ['git -C sub -C .. -C .. status', { commands: ['git *'] }, ['commands', 'outside the workspace']],
  ['git -C sub status', { commands: ['git *'] }, 'allow'],
  ['git diff --output=<elsewhere>/x', { commands: ['git diff *'] }, ['write', 'outside']],
  ['git diff --output <elsewhere>/x', { commands: ['git diff *'] }, ['write', 'outside']],
  ['git diff --outp=<elsewhere>/x', { commands: ['git diff *'] }, ['write', 'outside']],
  ['git diff --output=$STAGE_OUT/d.patch', { commands: ['git diff *'], write: ['$STAGE_OUT/**'] }, 'allow'],
  ['git $(echo checkout) main', { commands: ['git *', 'echo *'] }, CANT],
  ['git diff $(echo --output=/tmp/x)', { commands: ['git *', 'echo *'] }, CANT],
  ['git --frobnicate status', { commands: ['git *'] }, CANT],
] as [string, Partial<Permissions>, Want][])('git paths: %j under %j is %j', (command, open, want) => {
  expect(verdict(run(command, open), want)).toEqual(want);
});

test.each([
  ['echo x > $STAGE_OUT/r.md', { write: ['$STAGE_OUT/**'] }, 'allow'],
  ['echo x > "$STAGE_OUT/r.md"', { write: ['$STAGE_OUT/**'] }, 'allow'],
  ["echo x > '$STAGE_OUT/r.md'", { write: ['**'] }, ['write', "can't be resolved"]],
  ['echo x 2>/dev/null 2>&1 >/dev/stderr', {}, 'allow'],
  ['sort < src/a.ts', { read: ['src/**'] }, 'allow'],
  ['sort < src/a.ts', { read: [] }, ['read', 'src/a.ts']],
  ["cat <<'EOF' > notes.md\nx\nEOF", { write: [] }, ['write', 'notes.md']],
  ['echo x &> lib/a.dart', { write: ['src/**'] }, ['write', 'lib/a.dart']],
  ['echo x 3>lib/a.dart', { write: ['src/**'] }, ['write', 'lib/a.dart']],
  ['echo x >> lib/a.dart', { write: ['src/**'] }, ['write', 'lib/a.dart']],
  ['echo x >| lib/a.dart', { write: ['src/**'] }, ['write', 'lib/a.dart']],
  ['echo x>lib/a.dart', { write: ['src/**'] }, ['write', 'lib/a.dart']],
  ['echo x > ../../../lib/a.dart', { write: ['**'] }, ['write', 'outside']],
  ['echo x > $(echo lib/a.dart)', { write: ['**'] }, ['write', "can't be resolved"]],
  ['echo x > ~/x', { write: ['**'] }, ['write', "can't be resolved"]],
  ['echo x > *.ts', { write: ['**'] }, ['write', "can't be resolved"]],
  ['echo x > /dev/tcp/host/80', { write: ['**'] }, ['write', 'outside']],
  ['cat <<< src/a.ts', {}, 'allow'],
] as [string, Partial<Permissions>, Want][])('redirections: %j under %j is %j', (command, open, want) => {
  const commands = ['echo *', 'sort *', 'cat *'];
  expect(verdict(run(command, { commands, ...open }), want)).toEqual(want);
});

test.each([
  ['', {}, ['commands', "can't be checked: an empty command"]],
  ['  \n ', {}, ['commands', "can't be checked: an empty command"]],
  ['(cd x; ls)', { commands: ['ls *'] }, ['commands', "can't be checked: a subshell"]],
  ['for f in *; do rm $f; done', { commands: ['rm *'] }, ['commands', "can't be checked: a for loop"]],
  ['{rm,-rf,x}', {}, ['commands', "can't be checked: a brace expansion"]],
  ["$'rm' -rf x", {}, ['commands', "can't be checked: an ANSI-C quote"]],
  ['a |', { commands: ['a *'] }, ['commands', "can't be checked: a command that ends with |"]],
] as [string, Partial<Permissions>, Want][])('refusals: %j under %j is %j', (command, open, want) => {
  expect(verdict(run(command, open), want)).toEqual(want);
});

const DENIED = (text: string): Want => ['commands', `\`${text}\` is among the step's denied commands`];
const PROFILE = { commands: ['*'], deny: ['git push *', 'gh *', 'curl *'] };

test.each([
  ['git push origin HEAD', PROFILE, DENIED('git push origin HEAD')],
  ['git status --short', PROFILE, 'allow'],
  ['sed -n 1,5p src/a.ts | cut -c1-80', PROFILE, 'allow'],
  ['git log -1 && gh pr view 1', PROFILE, DENIED('gh pr view 1')],
  ["bash -c 'curl -s example.com'", PROFILE, DENIED('curl -s example.com')],
  ['echo $(gh auth token)', PROFILE, DENIED('gh auth token')],
  ['rm -rf src', PROFILE, DENY('rm -rf')],
  ['git push', { commands: ['git *'], deny: ['git push *'] }, DENIED('git push')],
] as [string, Partial<Permissions>, Want][])("a step's deny: %j under %j is %j", (command, open, want) => {
  expect(verdict(run(command, open), want)).toEqual(want);
});

const GIT_OPEN: Want = ['commands', "can't be checked: git's arguments hold an expansion"];
const GIT = { commands: ['git *'] };

test.each([
  ['git grep -n x -- src/adapters/git-worktree*', GIT, 'allow'],
  ['git log --oneline -- src/**/paths.ts', GIT, 'allow'],
  ['git commit -q -m "$(cat <<\'EOF\'\nfix: a thing\nEOF\n)"', { commands: ['git *', 'cat *'] }, 'allow'],
  ['git commit --message "$MSG"', GIT, 'allow'],
  ['git pu* origin', GIT, GIT_OPEN],
  ['git $SUB', GIT, GIT_OPEN],
  ['git diff *', GIT, GIT_OPEN],
  ['git diff -- -*', GIT, GIT_OPEN],
  ['git diff "$(echo --output=x)"', { commands: ['git *', 'echo *'] }, GIT_OPEN],
  ['git log -m "$X"', GIT, GIT_OPEN],
  ['ls | xargs git add', { commands: ['git *', 'ls *', 'xargs *'] }, GIT_OPEN],
] as [string, Partial<Permissions>, Want][])('git expansions: %j under %j is %j', (command, open, want) => {
  expect(verdict(run(command, open), want)).toEqual(want);
});

test('a command run from a cwd outside the roots is denied; from a subdirectory, relative paths start there', () => {
  const write = { commands: ['echo *'], write: ['sub/**'] };
  expect([
    verdict(run('echo x > a.txt', write, '<elsewhere>'), ['commands', 'working directory']),
    verdict(run('echo x > a.txt', write, join(layout.worktree, 'sub')), 'allow'),
  ]).toEqual([['commands', 'working directory'], 'allow']);
});

test('a reason quotes the refused command as written, cut at 200 characters', () => {
  const long = `unlisted ${'x'.repeat(300)}`;
  const decision = run(long, {});
  expect(decision.allow ? '' : decision.reason).toBe(`\`${long.slice(0, 200)}…\` matches none of the step's commands`);
});
