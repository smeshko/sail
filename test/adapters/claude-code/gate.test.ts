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

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ("commands ['git status']: Bash tail README.md is denied by commands with decide()'s reason, and git status runs", async () => {
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

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('with no tools listed an MCP call is denied by tools, with an empty list; listed, by its name or its server, it runs', async () => {
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

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('a Write to an absolute path outside the workspace or to the checkout above it is denied by write, and into $STAGE_OUT runs', async () => {
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
  // biome-ignore format: TDD-PENDING TASK-002
  test
    .skip // TDD-PENDING TASK-002
    .each<[string, string, unknown, string]>([
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

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  .each<[string, string, unknown]>([
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

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ("a call's working directory is the one the CLI reports, and an empty one is the workspace", async () => {
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

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('canUseTool allows the submission and denies everything else under the rule of its kind, naming the fallback', async () => {
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

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('a missing $STAGE_OUT denies even a read the step allows: an empty root fails closed', async () => {
  const g = gate(STEP, { ...CTX, stageOut: '' });
  const answer = await ask(g, pre('Read', { file_path: 'README.md' }));
  expect(answer.hookSpecificOutput?.permissionDecision).toBe('deny');
  expect(g.denials.map(([, denial]) => denial.rule)).toEqual(['read']);
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('the hook never throws: an input it cannot read and a listener that throws still deny, and another event gets no decision', async () => {
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
