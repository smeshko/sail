import { expect, test } from 'bun:test';
import { type Decision, isDenial, RULES, type ToolCall } from '../../../src/engine/permissions';

// Compile-time only: a mcp call needs its server and an execute call needs its command. `bun run typecheck` checks
// these directives, and nothing here runs.
function incompleteCalls(): ToolCall[] {
  return [
    // @ts-expect-error TS2322: a mcp call without its server does not type-check
    { tool: 'get_issue', kind: 'mcp' },
    // @ts-expect-error TS2322: an execute call without its command does not type-check
    { tool: 'Bash', kind: 'execute' },
  ];
}
void incompleteCalls;

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('RULES holds the eleven rules and the nine deny rules, in D15 order', () => {
  expect(RULES).toEqual([
    'tool:not-listed',
    'mcp:not-listed',
    'read:outside-roots',
    'write:outside-roots',
    'write:not-allowed',
    'read:not-allowed',
    'redirect:not-allowed',
    'path:outside-roots',
    'command:unparseable',
    'command:not-listed',
    'git:outside-roots',
    'deny:rm-rf',
    'deny:git-push-force',
    'deny:git-reset-hard',
    'deny:git-clean-f',
    'deny:git-branch-D',
    'deny:git-checkout',
    'deny:git-switch',
    'deny:sudo',
    'deny:curl-pipe-shell',
  ]);
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('isDenial is true for a denial and false for an allow', () => {
  const denial: Decision = { deny: true, rule: 'tool:not-listed', reason: 'Read is not in the step tools' };
  const allow: Decision = { allow: true };
  expect(isDenial(denial)).toBe(true);
  expect(isDenial(allow)).toBe(false);
  if (isDenial(denial)) expect(denial.rule).toBe('tool:not-listed');
});
