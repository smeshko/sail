// The gate every tool call of a pi session passes before it runs: the extension's tool_call hook answers with the
// permission engine's verdict, a block with the reason the model reads, and each denial is reported with its rule.
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Denial } from '../../../src/adapters/claude-code/tool-call';
import { createGate, gateExtension, type PiToolCall } from '../../../src/adapters/pi/gate';
import type { DecideContext } from '../../../src/engine/permissions';
import type { Permissions } from '../../../src/engine/permissions/types';

const base = mkdtempSync(join(tmpdir(), 'sail-pi-gate-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const work = join(base, 'checkout', 'work');
const stageIn = join(base, 'in');
const stageOut = join(base, 'out');
for (const dir of [join(work, 'src'), join(work, 'docs'), stageIn, stageOut]) mkdirSync(dir, { recursive: true });
writeFileSync(join(work, 'README.md'), '# Readme\n');
writeFileSync(join(work, 'src', 'a.ts'), 'a\n');

const CTX: DecideContext = { worktree: work, stageIn, stageOut, env: { STAGE_IN: stageIn, STAGE_OUT: stageOut } };
const STEP: Permissions = { read: ['**'], write: ['$STAGE_OUT/**'], commands: ['git status', 'ls *'] };

function gate(permissions: Permissions = STEP, ctx: DecideContext = CTX) {
  const denials: [string, Denial][] = [];
  const made = createGate({ permissions, ctx, onDenied: (id, denial) => denials.push([id, denial]) });
  return { ...made, denials };
}

const call = (toolName: string, input: unknown, toolCallId = 'c1'): PiToolCall => ({ toolCallId, toolName, input });

test('a bash command outside permissions.commands is blocked under commands, and onDenied is told', () => {
  const g = gate();
  const verdict = g.toolCall(call('bash', { command: 'rm file' }));
  expect({ verdict, denials: g.denials }).toEqual({
    verdict: { block: true, reason: expect.stringContaining('rm') },
    denials: [
      ['c1', { tool: 'bash', rule: 'commands', permissions: { commands: STEP.commands }, reason: expect.any(String) }],
    ],
  });
  expect(g.denials[0]?.[1].reason).toBe(verdict && 'reason' in verdict ? verdict.reason : '');
});

test('a bash command inside permissions.commands is allowed and reports nothing', () => {
  const g = gate();
  expect({ verdict: g.toolCall(call('bash', { command: 'git status' })), denials: g.denials }).toEqual({
    verdict: undefined,
    denials: [],
  });
});

test('a write to a path outside permissions.write is blocked under write', () => {
  const g = gate();
  const verdict = g.toolCall(call('write', { path: join(work, 'src', 'a.ts'), content: 'x' }, 'c2'));
  expect(verdict?.block).toBe(true);
  expect(g.denials.map(([id, denial]) => [id, denial.tool, denial.rule, denial.permissions])).toEqual([
    ['c2', 'write', 'write', { write: STEP.write }],
  ]);
});

test('a write inside $STAGE_OUT is allowed', () => {
  const g = gate();
  expect(g.toolCall(call('write', { path: join(stageOut, 'spec.md'), content: 'x' }))).toBeUndefined();
});

test('a bash command sent to the background is blocked with refusedCommand’s reason', () => {
  const g = gate({ ...STEP, commands: ['sleep *'] });
  const verdict = g.toolCall(call('bash', { command: 'sleep 9 &' }, 'c3'));
  expect(verdict).toEqual({
    block: true,
    reason: "can't be checked: a command run in the background with & can outlive the session",
  });
  expect(g.denials.map(([, denial]) => denial.rule)).toEqual(['commands']);
});

test('an unknown tool is blocked under tools, and submit is always allowed', () => {
  const g = gate();
  const unknown = g.toolCall(call('web_fetch', { url: 'http://example.com' }, 'c4'));
  const submit = g.toolCall(call('submit', { outcome: 'done' }, 'c5'));
  expect({ unknown, submit, denials: g.denials.map(([id, denial]) => [id, denial.rule]) }).toEqual({
    unknown: { block: true, reason: "can't be checked: web_fetch is no tool the gate knows" },
    submit: undefined,
    denials: [['c4', 'tools']],
  });
});

test('a grep of a folder no read glob covers is blocked under read, and one a folder glob covers is allowed', () => {
  const g = gate({ ...STEP, read: ['src/**', 'README.md'] });
  const uncovered = g.toolCall(call('grep', { pattern: 'x', path: 'docs' }, 'c6'));
  const covered = g.toolCall(call('grep', { pattern: 'x', path: join(work, 'src') }, 'c7'));
  expect({ covered, blocked: uncovered?.block, rules: g.denials.map(([id, denial]) => [id, denial.rule]) }).toEqual({
    covered: undefined,
    blocked: true,
    rules: [['c6', 'read']],
  });
});

test('a gate whose call directories are not all set blocks every call', () => {
  const g = gate(STEP, { ...CTX, stageOut: '' });
  const verdict = g.toolCall(call('read', { path: join(work, 'README.md') }, 'c8'));
  expect({ verdict, rule: g.denials[0]?.[1].rule }).toEqual({
    verdict: { block: true, reason: "read: can't be decided: the call's directories aren't all set" },
    rule: 'read',
  });
});

test('a listener that throws does not turn a block into an allow', () => {
  const g = createGate({
    permissions: STEP,
    ctx: CTX,
    onDenied: () => {
      throw new Error('listener broke');
    },
  });
  expect(g.toolCall(call('bash', { command: 'rm file' }))?.block).toBe(true);
});

test('the extension registers the tool_call hook, which answers with the gate’s verdict', () => {
  const g = gate();
  const hooks: [string, (event: PiToolCall) => unknown][] = [];
  gateExtension(g)({ on: (event, handler) => hooks.push([event, handler]) });
  expect(hooks.map(([event]) => event)).toEqual(['tool_call']);
  expect(hooks[0]?.[1](call('bash', { command: 'git status' }))).toBeUndefined();
  expect(hooks[0]?.[1](call('bash', { command: 'rm file' }))).toEqual({ block: true, reason: expect.any(String) });
});
