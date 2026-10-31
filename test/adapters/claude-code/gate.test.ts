// The gate: the PreToolUse hook answers every tool call with the permission engine's verdict, canUseTool denies
// whatever still reaches it, and each denial is reported with its rule, the step's permissions under it and the reason
// (D1, D9, D11). A real workspace, with the call directories, a symlink out of it and one that climbs back in.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { createGate } from '../../../src/adapters/claude-code/gate';
import type { Denial } from '../../../src/adapters/claude-code/tool-call';
import { type DecideContext, decide } from '../../../src/engine/permissions';
import type { Permissions } from '../../../src/engine/permissions/types';

// The clone's checkout holds the workspace, as a run's worktree sits inside the repository it was cut from.
const base = mkdtempSync(join(tmpdir(), 'sail-gate-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const work = join(base, 'checkout', 'work');
const stageIn = join(base, 'in');
const stageOut = join(base, 'out');
for (const dir of [join(work, 'src'), join(work, 'sub', 'dir'), stageIn, stageOut, join(base, 'elsewhere')]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(join(work, 'README.md'), '# Readme\n');
writeFileSync(join(work, 'src', 'a.ts'), 'a\n');
writeFileSync(join(work, 'outside.txt'), 'inside, by this name\n');
writeFileSync(join(base, 'checkout', 'outside.txt'), 'secret\n');
writeFileSync(join(base, 'elsewhere', 'secret.txt'), 'secret\n');
writeFileSync(join(stageIn, 'brief.md'), '# Brief\n');
symlinkSync(join(base, 'elsewhere'), join(work, 'link'));
// `deep/../..` is the workspace to the kernel, and the checkout above it once normalised.
symlinkSync(join(work, 'sub', 'dir'), join(work, 'deep'));

const CTX: DecideContext = { worktree: work, stageIn, stageOut, env: { STAGE_IN: stageIn, STAGE_OUT: stageOut } };
const STEP: Permissions = {
  read: ['**'],
  write: ['$STAGE_OUT/**', '**'],
  commands: ['git status', 'ls *'],
};

/** A gate over `permissions`, and every denial it reported. */
function gate(permissions: Permissions = STEP, ctx: DecideContext = CTX) {
  const denials: [string, Denial][] = [];
  const made = createGate({ permissions, ctx, onDenied: (id, denial) => denials.push([id, denial]) });
  return { ...made, denials };
}

const signal = new AbortController().signal;

/** The hook input of one tool call, from the workspace unless `cwd` says otherwise. */
function pre(tool: string, input: unknown, id = 'toolu_1', extra: Partial<PreToolUseHookInput> = {}): HookInput {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    transcript_path: '',
    cwd: work,
    tool_name: tool,
    tool_input: input,
    tool_use_id: id,
    ...extra,
  };
}

const allowed = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
const deniedFor = (reason: string) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});

/** A hook's answer, as the CLI reads it. */
interface Answer {
  hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; permissionDecisionReason?: string };
}

const ask = async (g: Pick<ReturnType<typeof gate>, 'preToolUse'>, input: HookInput): Promise<Answer> =>
  (await g.preToolUse(input, undefined, { signal })) as Answer;

test("commands ['git status']: Bash tail README.md is denied by commands with decide()'s reason, and git status runs", async () => {
  const permissions: Permissions = { read: ['**'], write: ['$STAGE_OUT/**'], commands: ['git status'] };
  const g = gate(permissions);
  const tail = await ask(g, pre('Bash', { command: 'tail README.md' }, 'toolu_tail'));
  const status = await ask(g, pre('Bash', { command: 'git status' }, 'toolu_status'));
  const verdict = decide(
    { tool: 'Bash', kind: 'execute', paths: [], command: 'tail README.md', cwd: work },
    permissions,
    CTX,
  );
  const reason = verdict.allow ? '' : verdict.reason;
  expect(reason).not.toBe('');
  expect({ tail, status, denials: g.denials }).toEqual({
    tail: deniedFor(reason),
    status: allowed,
    denials: [['toolu_tail', { tool: 'Bash', rule: 'commands', permissions: { commands: ['git status'] }, reason }]],
  });
});

test('with no tools listed an MCP call is denied by tools, with an empty list; listed, by its name or its server, it runs', async () => {
  const none = gate({ read: ['**'], write: [], commands: [] });
  const listed = gate({ read: ['**'], write: [], commands: [], tools: ['linear:get_issue'] });
  const answers = [
    await ask(none, pre('mcp__linear__get_issue', { id: 'ADW-1' })),
    await ask(listed, pre('mcp__linear__get_issue', { id: 'ADW-1' })),
    await ask(listed, pre('mcp__other__get_issue', {}, 'toolu_2', { mcp_server: { name: 'linear', source: 'user' } })),
    await ask(listed, pre('mcp__linear', {}, 'toolu_3')),
  ];
  expect(answers.map((answer) => answer.hookSpecificOutput)).toEqual([
    expect.objectContaining({ permissionDecision: 'deny' }),
    allowed.hookSpecificOutput,
    allowed.hookSpecificOutput,
    expect.objectContaining({ permissionDecision: 'deny' }),
  ]);
  expect(none.denials).toEqual([
    [
      'toolu_1',
      {
        tool: 'mcp__linear__get_issue',
        rule: 'tools',
        permissions: { tools: [] },
        reason: "linear:get_issue is not among the step's tools",
      },
    ],
  ]);
  expect(listed.denials).toEqual([
    [
      'toolu_3',
      {
        tool: 'mcp__linear',
        rule: 'tools',
        permissions: { tools: ['linear:get_issue'] },
        reason: "can't be checked: mcp__linear names no MCP tool",
      },
    ],
  ]);
});

test('a Write to an absolute path outside the workspace or to the checkout above it is denied by write, and into $STAGE_OUT runs', async () => {
  const g = gate();
  const answers = [
    await ask(g, pre('Write', { file_path: join(tmpdir(), 'sail-gate-elsewhere', 'x'), content: 'x' }, 'toolu_tmp')),
    await ask(g, pre('Write', { file_path: join(base, 'checkout', 'x.ts'), content: 'x' }, 'toolu_up')),
    await ask(g, pre('Write', { file_path: join(stageOut, 'spec.md'), content: '# Spec' }, 'toolu_out')),
  ];
  expect(answers.map((answer) => answer.hookSpecificOutput?.permissionDecision)).toEqual(['deny', 'deny', 'allow']);
  expect(g.denials.map(([id, denial]) => [id, denial.rule, denial.permissions])).toEqual([
    ['toolu_tmp', 'write', { write: STEP.write }],
    ['toolu_up', 'write', { write: STEP.write }],
  ]);
});

describe('every escape is denied under its rule, and the denial reported is the reason the model reads', () => {
  test.each<[string, string, unknown, string]>([
    ['an absolute path outside', 'Read', { file_path: '/etc/hosts' }, 'read'],
    ['.. out of the workspace', 'Read', { file_path: '../outside.txt' }, 'read'],
    ['a symlink out of the workspace', 'Read', { file_path: 'link/secret.txt' }, 'read'],
    ['a new file through that symlink', 'Write', { file_path: 'link/new.txt', content: 'x' }, 'write'],
    [
      '.. after a symlink, which the CLI may normalise to above the workspace',
      'Read',
      { file_path: 'deep/../../outside.txt' },
      'read',
    ],
    ['an absolute path behind a space', 'Read', { file_path: ' /etc/hosts' }, 'read'],
    ['a ~ path behind a space', 'Edit', { file_path: ' ~/.zshrc', old_string: 'a', new_string: 'b' }, 'write'],
    ['a $VAR path the CLI would write literally', 'Write', { file_path: '$STAGE_OUT/spec.md', content: 'x' }, 'write'],
    ['a write into $STAGE_IN', 'Write', { file_path: join(stageIn, 'brief.md'), content: 'x' }, 'write'],
    ['a write under .git', 'Write', { file_path: '.git/config', content: 'x' }, 'write'],
    ['an absolute Glob pattern outside', 'Glob', { pattern: '/etc/*' }, 'read'],
    ['a Glob through the symlink', 'Glob', { pattern: '*', path: 'link' }, 'read'],
    ['a Glob pattern that climbs out of its path', 'Glob', { pattern: '../../*', path: 'sub' }, 'read'],
    ['a Glob pattern that climbs after a wildcard', 'Glob', { pattern: 'src/*/../../../*' }, 'read'],
    ['a Grep of the parent folder', 'Grep', { pattern: 'x', path: '..' }, 'read'],
    ['an allowed command chained to another', 'Bash', { command: 'git status && tail README.md' }, 'commands'],
    ['an allowed command followed by another', 'Bash', { command: 'git status; rm -rf /' }, 'commands'],
    ['a command substitution', 'Bash', { command: 'ls $(cat ~/.ssh/id_rsa)' }, 'commands'],
    ['an allowed command in the background', 'Bash', { command: 'git status', run_in_background: true }, 'commands'],
    ['a command that is no string', 'Bash', { command: 7 }, 'commands'],
    ['an MCP tool, with no servers', 'mcp__x__y', {}, 'tools'],
    ['a built-in the step does not list', 'WebFetch', { url: 'https://example.com', prompt: 'x' }, 'tools'],
    ['a subagent', 'Agent', { prompt: 'x', description: 'x' }, 'tools'],
    ['a tool no one knows', 'Frobnicate', {}, 'tools'],
    ['a tool with no name', '', {}, 'tools'],
    ['a write with no input at all', 'Write', null, 'write'],
  ])('%s', async (_, tool, input, rule) => {
    const g = gate();
    const answer = await ask(g, pre(tool, input, 'toolu_9'));
    const [id, denial] = g.denials[0] ?? ['', undefined];
    expect({
      decision: answer.hookSpecificOutput?.permissionDecision,
      heard: g.denials.length,
      id,
      rule: denial?.rule as string | undefined,
      sameReason: answer.hookSpecificOutput?.permissionDecisionReason === denial?.reason && denial?.reason !== '',
    }).toEqual({ decision: 'deny', heard: 1, id: 'toolu_9', rule, sameReason: true });
  });
});

test.each<[string, string, unknown]>([
  ['a Read in the workspace', 'Read', { file_path: 'README.md' }],
  ['a Read of $STAGE_IN', 'Read', { file_path: join(stageIn, 'brief.md') }],
  ['a Write into $STAGE_OUT', 'Write', { file_path: join(stageOut, 'notes', 'spec.md'), content: 'x' }],
  ['a path with a trailing space, inside either way', 'Read', { file_path: 'src/a.ts ' }],
  ['a Glob of the workspace', 'Glob', { pattern: '**/*.ts' }],
  ['a Grep of a folder', 'Grep', { pattern: 'a', path: 'src' }],
  ['an allowed command', 'Bash', { command: 'git status' }],
  ['an allowed pattern', 'Bash', { command: 'ls src' }],
  ['the submission, whatever its input', 'StructuredOutput', { outcome: 'done', output: { anything: true } }],
])('allows %s, and reports nothing', async (_, tool, input) => {
  const g = gate();
  expect({ answer: await ask(g, pre(tool, input)), denials: g.denials }).toEqual({ answer: allowed, denials: [] });
});

test("a call's working directory is the one the CLI reports, and an empty one is the workspace", async () => {
  const g = gate({ read: ['src/**'], write: [], commands: [] });
  const answers = [
    await ask(g, pre('Read', { file_path: 'a.ts' }, 't1', { cwd: join(work, 'src') })),
    await ask(g, pre('Read', { file_path: 'a.ts' }, 't2', { cwd: work })),
    await ask(g, pre('Read', { file_path: 'a.ts' }, 't3', { cwd: '' })),
    await ask(g, pre('Read', { file_path: 'etc/hosts' }, 't4', { cwd: '/' })),
  ];
  expect(answers.map((answer) => answer.hookSpecificOutput?.permissionDecision)).toEqual([
    'allow',
    'deny',
    'deny',
    'deny',
  ]);
});

test('canUseTool allows the submission and denies everything else under the rule of its kind, naming the fallback', async () => {
  const g = gate();
  const use = (tool: string, input: Record<string, unknown>, id: string) =>
    g.canUseTool(tool, input, { signal, toolUseID: id, requestId: 'r1' });
  const submitted = await use('StructuredOutput', { outcome: 'done' }, 'u0');
  const tools = ['Read', 'Write', 'NotebookEdit', 'Bash', 'mcp__x__y', 'Frobnicate'];
  const answers = [];
  for (const tool of tools) answers.push(await use(tool, { file_path: 'README.md', command: 'ls' }, `u-${tool}`));
  const throwing = new Proxy({} as Record<string, unknown>, {
    get: () => {
      throw new Error('unreadable');
    },
  });
  answers.push(await use('Read', throwing, 'u-proxy'));
  const message = (tool: string) => `${tool} reached the fallback: the gate decides every tool call before it runs`;
  expect(submitted).toEqual({ behavior: 'allow', updatedInput: { outcome: 'done' } });
  expect(answers).toEqual([...tools, 'Read'].map((tool) => ({ behavior: 'deny', message: message(tool) })));
  expect(g.denials.map(([id, denial]) => [id, denial.rule, denial.reason])).toEqual([
    ['u-Read', 'read', message('Read')],
    ['u-Write', 'write', message('Write')],
    ['u-NotebookEdit', 'write', message('NotebookEdit')],
    ['u-Bash', 'commands', message('Bash')],
    ['u-mcp__x__y', 'tools', message('mcp__x__y')],
    ['u-Frobnicate', 'tools', message('Frobnicate')],
    ['u-proxy', 'tools', message('Read')],
  ]);
});

test('canUseTool allows the call the hook just allowed, as Claude Code asks again for its protected paths, and that call alone', async () => {
  const g = gate();
  const use = (tool: string, input: Record<string, unknown>, id: string) =>
    g.canUseTool(tool, input, { signal, toolUseID: id, requestId: 'r1' });
  const write = { file_path: '.claude/CLAUDE.md', content: 'x' };
  const answers = [];
  for (const id of ['u-same', 'u-other-input', 'u-other-tool', 'u-denied']) {
    answers.push((await ask(g, pre('Write', write, id))).hookSpecificOutput?.permissionDecision);
  }
  answers.push(
    (await ask(g, pre('Bash', { command: 'tail README.md' }, 'u-bash'))).hookSpecificOutput?.permissionDecision,
  );
  const message = (tool: string) => `${tool} reached the fallback: the gate decides every tool call before it runs`;
  const deny = (tool: string) => ({ behavior: 'deny' as const, message: message(tool) });
  expect(answers).toEqual(['allow', 'allow', 'allow', 'allow', 'deny']);
  expect(await use('Write', write, 'u-same')).toEqual({ behavior: 'allow', updatedInput: write });
  // Asked once: the same id again is the fallback's.
  expect(await use('Write', write, 'u-same')).toEqual(deny('Write'));
  expect(await use('Write', { ...write, file_path: '../outside.txt' }, 'u-other-input')).toEqual(deny('Write'));
  expect(await use('Edit', write, 'u-other-tool')).toEqual(deny('Edit'));
  expect(await use('Write', write, 'u-never-hooked')).toEqual(deny('Write'));
  expect(await use('Bash', { command: 'tail README.md' }, 'u-bash')).toEqual(deny('Bash'));
  expect(g.denials.map(([id]) => id)).toEqual([
    'u-bash',
    'u-same',
    'u-other-input',
    'u-other-tool',
    'u-never-hooked',
    'u-bash',
  ]);
});

test('a missing $STAGE_OUT denies even a read the step allows: an empty root fails closed', async () => {
  const g = gate(STEP, { ...CTX, stageOut: '' });
  const answer = await ask(g, pre('Read', { file_path: 'README.md' }));
  expect(answer.hookSpecificOutput?.permissionDecision).toBe('deny');
  expect(g.denials.map(([, denial]) => denial.rule)).toEqual(['read']);
});

test('the hook never throws: an input it cannot read and a listener that throws still deny, and another event gets no decision', async () => {
  const throwing = new Proxy({} as Record<string, unknown>, {
    get: () => {
      throw new Error('unreadable');
    },
  });
  const g = gate();
  const unreadable = await ask(g, pre('Bash', throwing));
  const deaf = createGate({
    permissions: STEP,
    ctx: CTX,
    onDenied: () => {
      throw new Error('not listening');
    },
  });
  const stillDenied = await ask(deaf, pre('Read', { file_path: '/etc/hosts' }));
  const other = await ask(g, {
    hook_event_name: 'SessionStart',
    session_id: 's1',
    transcript_path: '',
    cwd: work,
    source: 'startup',
  });
  expect({
    unreadable,
    stillDenied: stillDenied.hookSpecificOutput?.permissionDecision,
    other,
  }).toEqual({
    unreadable: deniedFor("Bash: can't be decided: unreadable"),
    stillDenied: 'deny',
    other: {},
  });
});

// Review R1-4: a Grep of a folder reads every file below it, so a read glob that matches the folder alone, or only some
// of what is below it, doesn't let it run.
test.each<[string, string[], Record<string, unknown>, 'allow' | 'deny']>([
  ['src/* matches src/ itself, not what is below it', ['src/*'], { pattern: 'a', path: 'src' }, 'deny'],
  ['* matches the workspace by its empty path, not every file in it', ['*'], { pattern: 'a' }, 'deny'],
  [
    'src/**/*.ts covers the .ts files below src/, not all of them',
    ['src/**/*.ts'],
    { pattern: 'a', path: 'src' },
    'deny',
  ],
  ['src/** does not cover the workspace', ['src/**'], { pattern: 'a' }, 'deny'],
  ['src/** covers all of src/', ['src/**'], { pattern: 'a', path: 'src' }, 'allow'],
  ['** covers the workspace', ['**'], { pattern: 'a' }, 'allow'],
  ['**/* covers a folder in it', ['**/*'], { pattern: 'a', path: 'sub' }, 'allow'],
  ['sub/**/* covers a folder below sub/', ['sub/**/*'], { pattern: 'a', path: 'sub/dir' }, 'allow'],
  ['a Grep of one file is one read of it', ['src/*'], { pattern: 'a', path: 'src/a.ts' }, 'allow'],
  ['$STAGE_IN is open whatever the read globs say', ['src/*'], { pattern: 'a', path: stageIn }, 'allow'],
])('a Grep with read %s', async (_, read, input, expected) => {
  const g = gate({ ...STEP, read });
  const answer = await ask(g, pre('Grep', input));
  expect({
    decision: answer.hookSpecificOutput?.permissionDecision,
    rules: g.denials.map(([, denial]) => denial.rule),
  }).toEqual({ decision: expected, rules: expected === 'deny' ? ['read'] : [] });
});

// Review R1-5: a step that lists a tool which runs commands, or work later or elsewhere, still can't have it run.
test.each<[string, Record<string, unknown>, string]>([
  ['Monitor', { command: 'cat /etc/hosts', description: 'x', timeout_ms: 1000 }, 'commands'],
  ['Workflow', { script: 'x' }, 'tools'],
  ['RemoteTrigger', { action: 'run' }, 'tools'],
  ['ScheduleWakeup', { prompt: 'x' }, 'tools'],
  ['Agent', { prompt: 'x', description: 'x', isolation: 'remote' }, 'tools'],
])('a listed %s is denied', async (tool, input, rule) => {
  const g = gate({ ...STEP, tools: [tool] });
  const answer = await ask(g, pre(tool, input));
  expect({
    decision: answer.hookSpecificOutput?.permissionDecision,
    rules: g.denials.map(([, denial]) => denial.rule as string),
  }).toEqual({ decision: 'deny', rules: [rule] });
});

// Review R2-1, R2-2, R2-3: decide() reads every command as bash, and allowed git diff's --no-index reads any file. A
// shell other than bash, a background job however it is spelled, and --no-index are refused, at any depth.
describe("with the fixture spec stage's commands, what decide() can't see is denied by commands", () => {
  const FIXTURE: Permissions = {
    read: ['**'],
    write: ['$STAGE_OUT/**'],
    commands: ['git log *', 'git diff *', 'sleep *', 'find *'],
  };
  test.each<[string, string, 'allow' | 'deny']>([
    ['zsh, whose >! writes its next word', "zsh -c 'cd $STAGE_OUT && git log -1 >! /tmp/outside-target'", 'deny'],
    ['zsh, its name escaped', "z\\sh -c 'git log -1'", 'deny'],
    ['zsh, by its path inside bash -c', 'bash -c \'/bin/zsh -c "git log -1"\'', 'deny'],
    ['sh, which is dash on Linux, where &> sends a job to the background', "sh -c 'sleep 30 &>/dev/null'", 'deny'],
    ['a background & after an escaped >', "bash -c 'sleep 30' \\>&", 'deny'],
    ['a background & after an escaped &', 'sleep 30 \\&& git log -1', 'deny'],
    ['a background & in a substitution', 'git log $(sleep 30 &)', 'deny'],
    ['git diff --no-index', 'git diff --no-index /dev/null /etc/hosts', 'deny'],
    ['git diff --no-index inside bash -c', "bash -c 'git diff --no-index /dev/null /etc/hosts'", 'deny'],
    // git diff turns --no-index on by itself when an operand lies outside the worktree.
    ['git diff of an absolute path outside', 'git diff /dev/null /etc/hosts', 'deny'],
    ['git diff of a path that climbs out', 'git diff README.md ../../outside.txt', 'deny'],
    ['git diff of what find hands it', 'find src -name a.ts -exec git diff README.md {} \\;', 'deny'],
    ['git diff of revisions and a path inside', 'git diff HEAD~1..HEAD -- src/a.ts', 'allow'],
    ['allowed commands chained, with a redirection of stderr', 'git log -1 2>&1 && git diff HEAD', 'allow'],
  ])('%s', async (_, command, expected) => {
    const g = gate(FIXTURE);
    const answer = await ask(g, pre('Bash', { command }));
    expect({
      decision: answer.hookSpecificOutput?.permissionDecision,
      rules: g.denials.map(([, denial]) => denial.rule as string),
    }).toEqual({ decision: expected, rules: expected === 'deny' ? ['commands'] : [] });
  });
});

// What Claude Code saves of a long tool output sits beside the session's transcript, under `<session id>/tool-results/`:
// the agent is told to Read it, so the gate lets it, and nothing else of `~/.claude`.
describe("a session's saved tool output", () => {
  const project = join(base, 'home', '.claude', 'projects', 'proj');
  const transcript = join(project, 's1.jsonl');
  const saved = join(project, 's1', 'tool-results', 'out.txt');
  const other = join(project, 's2', 'tool-results', 'out.txt');
  mkdirSync(join(project, 's1', 'tool-results'), { recursive: true });
  mkdirSync(join(project, 's2', 'tool-results'), { recursive: true });
  writeFileSync(transcript, '{}\n');
  writeFileSync(saved, 'long output\n');
  writeFileSync(other, 'another session\n');
  writeFileSync(join(project, 'settings.json'), '{}\n');
  symlinkSync(join(base, 'elsewhere', 'secret.txt'), join(project, 's1', 'tool-results', 'link.txt'));
  const session = { session_id: 's1', transcript_path: transcript };

  const verdictOf = async (tool: string, input: unknown, extra: Partial<PreToolUseHookInput> = session) => {
    const g = gate();
    const answer = await ask(g, pre(tool, input, 'toolu_1', extra));
    return {
      decision: answer.hookSpecificOutput?.permissionDecision,
      rules: g.denials.map(([, denial]) => denial.rule as string),
    };
  };
  const runs = { decision: 'allow', rules: [] };
  const deniedByRead = { decision: 'deny', rules: ['read'] };

  test("a Read of the session's tool-results file runs", async () => {
    expect(await verdictOf('Read', { file_path: saved })).toEqual(runs);
  });

  test("a Read of the transcript, of another file under ~/.claude, or of another session's tool-results is denied by read", async () => {
    expect([
      await verdictOf('Read', { file_path: transcript }),
      await verdictOf('Read', { file_path: join(project, 'settings.json') }),
      await verdictOf('Read', { file_path: other }),
      await verdictOf('Read', {
        file_path: join(project, 's1', 'tool-results', '..', '..', 's2', 'tool-results', 'out.txt'),
      }),
    ]).toEqual([deniedByRead, deniedByRead, deniedByRead, deniedByRead]);
  });

  test('a tool-results entry linking outside it is denied by read', async () => {
    expect(await verdictOf('Read', { file_path: join(project, 's1', 'tool-results', 'link.txt') })).toEqual(
      deniedByRead,
    );
  });

  test("a Grep or Bash cat of the tool-results file is decided as before: denied, as it lies outside the step's read globs", async () => {
    expect([
      await verdictOf('Grep', { pattern: 'long', path: saved }),
      await verdictOf('Bash', { command: `cat ${saved}` }),
    ]).toEqual([deniedByRead, { decision: 'deny', rules: ['commands'] }]);
  });

  test('with no transcript_path the Read is denied as before', async () => {
    expect([
      await verdictOf('Read', { file_path: saved }, { session_id: 's1', transcript_path: '' }),
      await verdictOf('Read', { file_path: saved }, { session_id: '', transcript_path: transcript }),
    ]).toEqual([deniedByRead, deniedByRead]);
  });
});
