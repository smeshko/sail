// The credential preflight: which variables a session needs. This group is small and self-contained, because the rule
// for a local Claude Code login is still open (TASK-004, plan Decisions). A change to the rule changes these tests only.
import { expect, test } from 'bun:test';
import { requires } from '../../../src/adapters/claude-code/auth';

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('with no cloud provider flag set, a session needs ANTHROPIC_API_KEY', () => {
  expect(requires({}, {})).toEqual(['ANTHROPIC_API_KEY']);
});

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('with CLAUDE_CODE_USE_BEDROCK set, a session needs no key, because the cloud provider holds the credentials', () => {
  expect(requires({}, { CLAUDE_CODE_USE_BEDROCK: '1' })).toEqual([]);
});

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('with CLAUDE_CODE_USE_VERTEX set, a session needs no key, because the cloud provider holds the credentials', () => {
  expect(requires({}, { CLAUDE_CODE_USE_VERTEX: '1' })).toEqual([]);
});
