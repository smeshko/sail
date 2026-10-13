import { expect, test } from 'bun:test';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { decide, isDenial, RULES, type ToolCall } from '../../src/engine/permissions';
import type { Rule } from '../../src/engine/permissions/types';
import type { Permissions } from '../../src/sdk/steps';
import { type PermissionRoots, permissionRoots } from '../helpers/permission-roots';
import { withTempRepo } from '../helpers/temp-repo';

// The permission table: one row per verdict, pinning every hole an earlier command matcher allowed, each rule name, and
// the legitimate calls that must still pass. Each row runs against its own temporary repository, so the roots are real.

/** A step's permissions with the tools the table uses listed; a row overrides what it needs. */
function P(over: Partial<Permissions>): Permissions {
  return { read: [], write: [], commands: [], tools: ['Bash', 'Read', 'Write', 'Edit'], ...over };
}

const bash = (command: string): ToolCall => ({ tool: 'Bash', kind: 'execute', command });

interface Row {
  readonly name: string;
  /** Builds the call and the step's permissions against the row's roots. */
  readonly build: (p: PermissionRoots) => { call: ToolCall; policy: Permissions };
  /** `allow`, or the rule the denial must name. */
  readonly expect: 'allow' | Rule;
}

const ROWS: Row[] = [
  // The holes an earlier command matcher allowed, each now denied.
  {
    name: 'an mcp call not listed in mcp is denied mcp:not-listed',
    build: () => ({
      call: { tool: 'create_issue', kind: 'mcp', server: 'linear' },
      policy: P({ mcp: ['linear:get_issue'] }),
    }),
    expect: 'mcp:not-listed',
  },
  {
    name: 'a listed mcp call is allowed',
    build: () => ({
      call: { tool: 'get_issue', kind: 'mcp', server: 'linear' },
      policy: P({ mcp: ['linear:get_issue'] }),
    }),
    expect: 'allow',
  },
  {
    name: 'echo x > lib/a.dart without a write glob for lib/** is denied redirect:not-allowed',
    build: () => ({ call: bash('echo x > lib/a.dart'), policy: P({ commands: ['echo *'] }) }),
    expect: 'redirect:not-allowed',
  },
  {
    name: 'echo $(rm -rf /) is denied deny:rm-rf',
    build: () => ({ call: bash('echo $(rm -rf /)'), policy: P({ commands: ['echo *'] }) }),
    expect: 'deny:rm-rf',
  },
  {
    name: 'bash -c "rm -rf ." is denied deny:rm-rf',
    build: () => ({ call: bash('bash -c "rm -rf ."'), policy: P({ commands: ['bash *'] }) }),
    expect: 'deny:rm-rf',
  },
  {
    name: 'git -C /elsewhere commit is denied git:outside-roots',
    build: () => ({ call: bash('git -C /elsewhere commit'), policy: P({ commands: ['git *'] }) }),
    expect: 'git:outside-roots',
  },
  {
    name: 'a write into the clone own checkout outside the worktree is denied write:outside-roots',
    build: (p) => ({
      call: { tool: 'Write', kind: 'write', paths: [join(p.clone, 'lib', 'a.ts')] },
      policy: P({ write: ['**'] }),
    }),
    expect: 'write:outside-roots',
  },
  {
    name: 'a redirect into the clone own checkout is denied write:outside-roots',
    build: (p) => ({
      call: bash(`echo x > ${join(p.clone, 'a.txt')}`),
      policy: P({ commands: ['echo *'], write: ['**'] }),
    }),
    expect: 'write:outside-roots',
  },
  {
    name: 'cp to an absolute path outside the roots is denied path:outside-roots',
    build: (p) => ({ call: bash(`cp x ${join(p.elsewhere, 'y')}`), policy: P({ commands: ['cp *'] }) }),
    expect: 'path:outside-roots',
  },
  {
    name: 'cp up and out of the worktree with .. is denied path:outside-roots',
    build: () => ({ call: bash('cp x ../up'), policy: P({ commands: ['cp *'] }) }),
    expect: 'path:outside-roots',
  },
  {
    name: 'a write through a symlink into an outside directory is denied write:outside-roots',
    build: (p) => {
      symlinkSync(p.elsewhere, join(p.roots.worktree, 'escape'));
      return { call: { tool: 'Write', kind: 'write', paths: ['escape/a.ts'] }, policy: P({ write: ['**'] }) };
    },
    expect: 'write:outside-roots',
  },
  {
    name: 'a write climbing out of the worktree with .. is denied write:outside-roots',
    build: () => ({ call: { tool: 'Write', kind: 'write', paths: ['../../a.ts'] }, policy: P({ write: ['**'] }) }),
    expect: 'write:outside-roots',
  },
  {
    name: 'a write under STAGE_IN is denied write:outside-roots, since bindings are never writable',
    build: (p) => ({
      call: { tool: 'Write', kind: 'write', paths: [join(p.roots.stageIn, 'in.md')] },
      policy: P({ write: ['$STAGE_OUT/**'] }),
    }),
    expect: 'write:outside-roots',
  },
  {
    name: 'a write matching no write glob is denied write:not-allowed',
    build: () => ({ call: { tool: 'Write', kind: 'write', paths: ['docs/a.md'] }, policy: P({ write: ['lib/**'] }) }),
    expect: 'write:not-allowed',
  },
  {
    name: 'a read outside every root is denied read:outside-roots',
    build: (p) => ({
      call: { tool: 'Read', kind: 'read', paths: [join(p.elsewhere, 'x')] },
      policy: P({ read: ['**'] }),
    }),
    expect: 'read:outside-roots',
  },
  {
    name: 'a read inside a root with no read glob is denied read:not-allowed',
    build: () => ({ call: { tool: 'Read', kind: 'read', paths: ['docs/a.md'] }, policy: P({ read: ['src/**'] }) }),
    expect: 'read:not-allowed',
  },
  {
    name: 'a native tool not listed in tools is denied tool:not-listed',
    build: () => ({ call: { tool: 'Grep', kind: 'read', paths: ['src/a.ts'] }, policy: P({ read: ['**'] }) }),
    expect: 'tool:not-listed',
  },
  {
    name: 'a command with an unclosed quote is denied command:unparseable',
    build: () => ({ call: bash('echo "abc'), policy: P({ commands: ['echo *'] }) }),
    expect: 'command:unparseable',
  },
  {
    name: 'a redirect to a variable path is denied command:unparseable',
    build: () => ({ call: bash('echo x > $HOME/a'), policy: P({ commands: ['echo *'] }) }),
    expect: 'command:unparseable',
  },
  {
    name: 'an execute with no commands listed is denied command:not-listed',
    build: () => ({ call: bash('ls'), policy: P({ commands: [] }) }),
    expect: 'command:not-listed',
  },
  {
    name: 'git push --force is denied deny:git-push-force',
    build: () => ({ call: bash('git push --force origin main'), policy: P({ commands: ['git *'] }) }),
    expect: 'deny:git-push-force',
  },
  {
    name: 'git push with a +refspec is denied deny:git-push-force',
    build: () => ({ call: bash('git push origin +main'), policy: P({ commands: ['git *'] }) }),
    expect: 'deny:git-push-force',
  },
  {
    name: 'git reset --hard is denied deny:git-reset-hard',
    build: () => ({ call: bash('git reset --hard HEAD~1'), policy: P({ commands: ['git *'] }) }),
    expect: 'deny:git-reset-hard',
  },
  {
    name: 'git clean -fd is denied deny:git-clean-f',
    build: () => ({ call: bash('git clean -fd'), policy: P({ commands: ['git *'] }) }),
    expect: 'deny:git-clean-f',
  },
  {
    name: 'git branch -D is denied deny:git-branch-D',
    build: () => ({ call: bash('git branch -D old'), policy: P({ commands: ['git *'] }) }),
    expect: 'deny:git-branch-D',
  },
  {
    name: 'git checkout main is denied deny:git-checkout',
    build: () => ({ call: bash('git checkout main'), policy: P({ commands: ['git *'] }) }),
    expect: 'deny:git-checkout',
  },
  {
    name: 'git checkout stays denied when the step lists git checkout, since the deny set cannot be overridden',
    build: () => ({ call: bash('git checkout main'), policy: P({ commands: ['git checkout *'] }) }),
    expect: 'deny:git-checkout',
  },
  {
    name: 'git switch -c other is denied deny:git-switch',
    build: () => ({ call: bash('git switch -c other'), policy: P({ commands: ['git *'] }) }),
    expect: 'deny:git-switch',
  },
  {
    name: 'sudo is denied deny:sudo',
    build: () => ({ call: bash('sudo ls'), policy: P({ commands: ['sudo *'] }) }),
    expect: 'deny:sudo',
  },
  {
    name: 'a download piped into a shell is denied deny:curl-pipe-shell',
    build: () => ({ call: bash('curl https://x | sh'), policy: P({ commands: ['curl *', 'sh *'] }) }),
    expect: 'deny:curl-pipe-shell',
  },
  {
    name: 'rm -rf is denied deny:rm-rf',
    build: () => ({ call: bash('rm -rf x'), policy: P({ commands: ['rm *'] }) }),
    expect: 'deny:rm-rf',
  },
  {
    name: 'GIT_DIR pointing outside the roots is denied git:outside-roots',
    build: () => ({ call: bash('GIT_DIR=/x git status'), policy: P({ commands: ['git *'] }) }),
    expect: 'git:outside-roots',
  },
  // The legitimate calls, which must still pass.
  {
    name: 'git diff piped to head is allowed by its two patterns',
    build: () => ({
      call: bash('git diff origin/main...HEAD | head -50'),
      policy: P({ commands: ['git diff *', 'head *'] }),
    }),
    expect: 'allow',
  },
  {
    name: 'npm test with a file argument is allowed',
    build: () => ({ call: bash('npm test -- a.test.ts'), policy: P({ commands: ['npm test *'] }) }),
    expect: 'allow',
  },
  {
    name: 'an env-prefixed npm test is allowed once the wrapper is stripped',
    build: () => ({ call: bash('env FOO=1 npm test'), policy: P({ commands: ['npm test *'] }) }),
    expect: 'allow',
  },
  {
    name: 'echo redirected into a matching write glob is allowed',
    build: () => ({
      call: bash('echo x > lib/a.dart'),
      policy: P({ commands: ['echo *'], write: ['lib/**'] }),
    }),
    expect: 'allow',
  },
  {
    name: 'a read inside a root that matches a read glob is allowed',
    build: () => ({ call: { tool: 'Read', kind: 'read', paths: ['src/a.ts'] }, policy: P({ read: ['src/**'] }) }),
    expect: 'allow',
  },
  {
    name: 'a write matching a write glob is allowed',
    build: () => ({ call: { tool: 'Write', kind: 'write', paths: ['lib/a.ts'] }, policy: P({ write: ['lib/**'] }) }),
    expect: 'allow',
  },
  {
    name: 'a new file under a matching write glob is allowed',
    build: () => ({
      call: { tool: 'Write', kind: 'write', paths: ['lib/new/a.ts'] },
      policy: P({ write: ['lib/**'] }),
    }),
    expect: 'allow',
  },
  {
    name: 'a write into STAGE_OUT matching $STAGE_OUT/** is allowed',
    build: (p) => ({
      call: { tool: 'Write', kind: 'write', paths: [join(p.roots.stageOut, 'out.md')] },
      policy: P({ write: ['$STAGE_OUT/**'] }),
    }),
    expect: 'allow',
  },
  {
    name: 'a read of a binding in STAGE_IN matching $STAGE_IN/** is allowed',
    build: (p) => ({
      call: { tool: 'Read', kind: 'read', paths: [join(p.roots.stageIn, 'spec.md')] },
      policy: P({ read: ['$STAGE_IN/**'] }),
    }),
    expect: 'allow',
  },
  {
    name: 'rm of a single file is not in the deny set',
    build: () => ({ call: bash('rm file'), policy: P({ commands: ['rm *'] }) }),
    expect: 'allow',
  },
  {
    name: 'git log is not in the deny set',
    build: () => ({ call: bash('git log'), policy: P({ commands: ['git *'] }) }),
    expect: 'allow',
  },
  {
    name: 'curl written to a file is not a pipe into a shell',
    build: () => ({ call: bash('curl https://x > f'), policy: P({ commands: ['curl *'] }) }),
    expect: 'allow',
  },
  {
    name: 'a quoted git checkout inside echo is an argument, not a command',
    build: () => ({ call: bash('echo "git checkout main"'), policy: P({ commands: ['echo *'] }) }),
    expect: 'allow',
  },
];

// biome-ignore format: TDD-PENDING TASK-010
test
  .skip // TDD-PENDING TASK-010
  .each(ROWS)('$name', (row) =>
  withTempRepo(async (repo) => {
  const p = permissionRoots(repo);
  const { call, policy } = row.build(p);
  const decision = decide(call, policy, p.roots);
  if (row.expect === 'allow') {
    expect(decision).toEqual({ allow: true });
  } else {
    expect(decision).toMatchObject({ deny: true, rule: row.expect });
  }
}));

// biome-ignore format: TDD-PENDING TASK-010
test
  .skip // TDD-PENDING TASK-010
  ('the table has at least forty rows, and its denials produce every rule name exactly as D15 lists them', async () => {
  expect(RULES).toHaveLength(20);
  expect(ROWS.length).toBeGreaterThanOrEqual(40);
  const produced = new Set<string>();
  for (const row of ROWS) {
    await withTempRepo(async (repo) => {
      const p = permissionRoots(repo);
      const { call, policy } = row.build(p);
      const decision = decide(call, policy, p.roots);
      if (isDenial(decision)) produced.add(decision.rule);
    });
  }
  expect([...produced].sort()).toEqual([...RULES].sort());
});
