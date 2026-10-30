// Path rules: a path resolves as the kernel would, lands in the worktree, $STAGE_IN, $STAGE_OUT or outside, and is
// checked against the read or write globs (D5, D6). Every case is built on disk under a realpath'd temp directory.
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  checkRead,
  checkWrite,
  expand,
  insideRoots,
  MAX_LINKS,
  place,
  resolvePhysical,
  roots,
} from '../../../src/engine/permissions/paths';
import type { Decision } from '../../../src/engine/permissions/types';
import { makeLayout, perms } from '../../helpers/permissions';

const layout = makeLayout();
afterAll(() => layout.remove());
const { clone, worktree, stageIn, stageOut, elsewhere, ctx } = layout;

// The links the rows go through, all inside the worktree.
layout.link('wlib', join(clone, 'lib'));
layout.link('out', elsewhere);
layout.link('dang', join(clone, 'new', 'x.dart'));
layout.link('top', join(worktree, 'src', 'deep'));
layout.link('esc', join(clone, 'lib'));
layout.link('in', 'src');
layout.link('l1', 'l2');
layout.link('l2', 'l1');
mkdirSync(join(clone, 'lib', 'deeper'), { recursive: true });
layout.link('esc2', join(clone, 'lib', 'deeper'));
for (let i = 0; i <= MAX_LINKS; i++) layout.link(`chain/c${i}`, i === MAX_LINKS ? '../src' : `c${i + 1}`);

type Want = 'allow' | [string, string];

const phraseOf = (want: Want): string => (want === 'allow' ? '' : want[1]);

/** A verdict as 'allow', or its rule beside whether its reason holds `phrase`. */
function verdict(decision: Decision, phrase: string): Want {
  if (decision.allow) return 'allow';
  return [decision.rule, decision.reason.includes(phrase) ? phrase : decision.reason];
}

test("the engine's records beside $STAGE_OUT are outside it: a write to result.json, session.log or try-2/ is denied, one into out/ is allowed", () => {
  const call = dirname(stageOut);
  const write = perms({ write: ['$STAGE_OUT/**'] });
  const at = roots(ctx);
  expect(
    [join(call, 'result.json'), join(call, 'session.log'), join(call, 'try-2', 'x'), join(stageOut, 'x')].map((path) =>
      place(path, at),
    ),
  ).toEqual(['outside', 'outside', 'outside', 'stage-out']);
  const denied = [join(call, 'result.json'), join(call, 'session.log'), join(call, 'try-2', 'x')].map(
    (path) => checkWrite([path], write, ctx).allow,
  );
  expect(denied).toEqual([false, false, false]);
  expect(checkWrite([join(stageOut, 'x')], write, ctx).allow).toBe(true);
});

test('a path lands in $STAGE_IN, $STAGE_OUT, the worktree or outside; $STAGE_IN first, and without case', () => {
  const at = roots(ctx);
  const cases = [
    join(worktree, 'src', 'a.ts'),
    worktree,
    join(stageIn, 'brief.md'),
    stageIn,
    join(stageOut, 'spec.md'),
    stageOut,
    join(dirname(stageOut), 'IN', 'x.md'),
    join(clone, 'lib', 'a.dart'),
    `${worktree}-2/x`,
    elsewhere,
  ];
  expect(cases.map((path) => place(path, at))).toEqual([
    'worktree',
    'worktree',
    'stage-in',
    'stage-in',
    'stage-out',
    'stage-out',
    'stage-in',
    'outside',
    'outside',
    'outside',
  ]);
});

test.each([
  ['src/a.ts', { write: ['src/**'] }, 'allow'],
  ['src/new/b.ts', { write: ['src/**'] }, 'allow'],
  ['lib/a.dart', { write: ['src/**'] }, ['write', 'lib/a.dart']],
  ['$STAGE_OUT/spec.md', { write: ['$STAGE_OUT/**'] }, 'allow'],
  ['$STAGE_OUT/spec.md', { write: ['**'] }, ['write', "matches none of the step's write globs"]],
  ['spec.md', { write: ['$STAGE_OUT/**'] }, ['write', "matches none of the step's write globs"]],
  ['src/a.ts', { write: [`${worktree}/**`] }, ['write', "matches none of the step's write globs"]],
] as [string, { write: string[] }, Want][])('write %s under %j: %j', (path, open, expected) => {
  expect(verdict(checkWrite([path], perms(open), ctx), phraseOf(expected))).toEqual(expected);
});

test.each([
  ['src', ['src/**'], 'allow'],
  ['', ['**'], 'allow'],
  ['.', ['src/**'], ['read', "matches none of the step's read globs"]],
  ['src/a.ts', ['src/**'], 'allow'],
  ['lib/a.dart', ['src/**'], ['read', 'lib/a.dart']],
  ['$STAGE_IN/brief.md', [], 'allow'],
  ['$STAGE_OUT/spec.md', [], 'allow'],
  [join(clone, 'lib', 'a.dart'), ['**'], ['read', 'outside']],
] as [string, string[], Want][])('read %j under %j: %j', (path, read, expected) => {
  const paths = path === '' ? [worktree] : [path];
  expect(verdict(checkRead(paths, perms({ read }), ctx), phraseOf(expected))).toEqual(expected);
});

test('a read denial names the path as given and where it resolved', () => {
  const decision = checkRead([join(clone, 'lib', 'a.dart')], perms({ read: ['**'] }), ctx);
  expect(decision).toEqual({
    allow: false,
    rule: 'read',
    reason: `read ${join(clone, 'lib', 'a.dart')} → ${join(clone, 'lib', 'a.dart')}: outside the workspace, $STAGE_IN and $STAGE_OUT`,
  });
});

test.each([
  ['$STAGE_IN/brief.md', '$STAGE_IN'],
  ['$STAGE_IN/new.md', '$STAGE_IN'],
  [join(dirname(stageOut), 'IN', 'brief.md'), '$STAGE_IN'],
  ['.git/config', '.git'],
  ['.GIT/config', '.git'],
  ['sub/.git/hooks/x', '.git'],
  ['.git', '.git'],
  ['$STAGE_OUT/.Git/x', '.git'],
])('no write reaches %s, even under write: ** and $STAGE_OUT/**', (path, phrase) => {
  expect(verdict(checkWrite([path], perms({ write: ['**', '$STAGE_OUT/**'] }), ctx), phrase)).toEqual([
    'write',
    phrase,
  ]);
});

test.each([[join(clone, 'lib', 'a.dart')], ['../../../lib/a.dart'], ['wlib/a.dart'], ['esc/deeper/../a.dart']])(
  "a write into the clone's own checkout, %s, is outside the worktree",
  (path) => {
    expect(verdict(checkWrite([path], perms({ write: ['**'] }), ctx), 'outside')).toEqual(['write', 'outside']);
  },
);

test.each([
  ['out/x', 'outside', 'a link inside pointing outside is outside'],
  ['dang', 'outside', 'a dangling link whose target would be outside is outside'],
  ['esc2/../a.dart', 'outside', "link/.. is the link target's parent, outside here"],
])('symlinks: %s is %s: %s', (path, phrase) => {
  expect(verdict(checkWrite([path], perms({ write: ['**'] }), ctx), phrase)).toEqual(['write', phrase]);
});

test("link/.. resolves from the link target's parent, and a link inside pointing inside is inside", () => {
  const write = perms({ write: ['src/**'] });
  expect(resolvePhysical('top/../a.ts', worktree)).toEqual({ ok: true, path: join(worktree, 'src', 'a.ts') });
  expect([
    verdict(checkWrite(['top/../a.ts'], write, ctx), ''),
    verdict(checkWrite(['in/a.ts'], write, ctx), ''),
  ]).toEqual(['allow', 'allow']);
});

test('a link loop, and a chain of more than 40 links, are denials that say so', () => {
  expect(verdict(checkRead(['l1/x'], perms({ read: ['**'] }), ctx), 'symbolic links')).toEqual([
    'read',
    'symbolic links',
  ]);
  expect([resolvePhysical('chain/c1', worktree).ok, resolvePhysical('chain/c0', worktree)]).toEqual([
    true,
    { ok: false, reason: expect.stringContaining(`more than ${MAX_LINKS} symbolic links`) },
  ]);
});

test('.. below a directory that does not exist is not resolved lexically', () => {
  expect(resolvePhysical('nope/../../x', worktree)).toEqual({
    ok: false,
    reason: expect.stringContaining("doesn't exist"),
  });
});

test('$STAGE_OUT, braced or bare, expands from the env; an unknown variable, ~ and ~user leave a path unresolvable', () => {
  expect([
    expand('$STAGE_OUT/x.md', ctx.env),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, not a template
    expand('${STAGE_OUT}/x.md', ctx.env),
    expand('$NOPE/x', ctx.env),
    expand('~/x', ctx.env),
    expand('~user/x', ctx.env),
  ]).toEqual([
    { ok: true, path: join(stageOut, 'x.md') },
    { ok: true, path: join(stageOut, 'x.md') },
    { ok: false, reason: expect.stringContaining('$NOPE') },
    { ok: false, reason: expect.stringContaining('~') },
    { ok: false, reason: expect.stringContaining('~user') },
  ]);
  expect(verdict(checkWrite(['$NOPE/x'], perms({ write: ['**'] }), ctx), '$NOPE')).toEqual(['write', '$NOPE']);
  expect(verdict(checkRead(['~/x'], perms({ read: ['**'] }), ctx), '~')).toEqual(['read', '~']);
});

test('/dev/null, /dev/stdout and /dev/stderr take writes with no write globs; any other /dev path is outside', () => {
  expect([
    verdict(checkWrite(['/dev/null', '/dev/stdout', '/dev/stderr'], perms(), ctx), ''),
    verdict(checkWrite(['/dev/zero'], perms({ write: ['**'] }), ctx), 'outside'),
  ]).toEqual(['allow', ['write', 'outside']]);
});

test('relative paths resolve from the cwd; a cwd outside the roots is itself a denial', () => {
  const write = perms({ write: ['src/**'] });
  expect([
    verdict(checkWrite(['a.ts'], write, ctx, join(worktree, 'src')), ''),
    verdict(checkWrite(['a.ts'], write, ctx), "matches none of the step's write globs"),
    verdict(checkWrite(['src/a.ts'], write, ctx, clone), 'working directory'),
    verdict(checkRead([join(worktree, 'src', 'a.ts')], perms({ read: ['**'] }), ctx, elsewhere), 'working directory'),
  ]).toEqual([
    'allow',
    ['write', "matches none of the step's write globs"],
    ['write', 'working directory'],
    ['read', 'working directory'],
  ]);
});

test('roots reached through a symlink are realpathed: the same calls decide the same way', () => {
  const alias = join(layout.root, 'alias');
  symlinkSync(clone, alias);
  const via = (path: string) => path.replace(clone, alias);
  const aliased = {
    ...ctx,
    worktree: via(worktree),
    stageOut: via(stageOut),
    stageIn: via(stageIn),
    env: { ...ctx.env, STAGE_OUT: via(stageOut), STAGE_IN: via(stageIn) },
  };
  expect([
    verdict(checkWrite([join(via(worktree), 'src', 'a.ts')], perms({ write: ['src/**'] }), aliased), ''),
    verdict(checkWrite(['$STAGE_OUT/spec.md'], perms({ write: ['$STAGE_OUT/**'] }), aliased), ''),
    verdict(checkWrite([join(worktree, 'lib', 'a.dart')], perms({ write: ['src/**'] }), aliased), 'lib/a.dart'),
  ]).toEqual(['allow', 'allow', ['write', 'lib/a.dart']]);
});

test('insideRoots resolves a directory for cd and git, and says why one outside is refused', () => {
  expect([insideRoots('src', ctx), insideRoots(elsewhere, ctx), insideRoots('..', ctx)]).toEqual([
    { ok: true, path: join(worktree, 'src') },
    { ok: false, reason: expect.stringContaining('outside the workspace') },
    { ok: false, reason: expect.stringContaining('outside the workspace') },
  ]);
});
