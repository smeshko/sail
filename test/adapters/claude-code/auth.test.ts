// The credential preflight: which variables a session needs. This group is small and self-contained, because the rule
// for a local Claude Code login is still open (TASK-004, plan Decisions). A change to the rule changes these tests only.
import { expect, test } from 'bun:test';
import { requires } from '../../../src/adapters/claude-code/auth';

test('with no cloud provider flag set, a session needs ANTHROPIC_API_KEY', () => {
  expect(requires({}, {})).toEqual(['ANTHROPIC_API_KEY']);
});

test('with CLAUDE_CODE_USE_BEDROCK set, a session needs no key, because the cloud provider holds the credentials', () => {
  expect(requires({}, { CLAUDE_CODE_USE_BEDROCK: '1' })).toEqual([]);
});

test('with CLAUDE_CODE_USE_VERTEX set, a session needs no key, because the cloud provider holds the credentials', () => {
  expect(requires({}, { CLAUDE_CODE_USE_VERTEX: '1' })).toEqual([]);
});

test('a cloud flag that the SDK reads as off, 0 or false, does not select the cloud, so a session still needs the key', () => {
  // review #1.3: the SDK parses a flag as on only for a trimmed, case-insensitive 1, true, yes or on.
  expect([
    requires({}, { CLAUDE_CODE_USE_BEDROCK: '0' }),
    requires({}, { CLAUDE_CODE_USE_VERTEX: 'false' }),
    requires({}, { CLAUDE_CODE_USE_BEDROCK: '' }),
  ]).toEqual([['ANTHROPIC_API_KEY'], ['ANTHROPIC_API_KEY'], ['ANTHROPIC_API_KEY']]);
});

test('a cloud flag the SDK reads as on, in any case and with spaces around it, selects the cloud', () => {
  expect([
    requires({}, { CLAUDE_CODE_USE_BEDROCK: ' TRUE ' }),
    requires({}, { CLAUDE_CODE_USE_VERTEX: 'yes' }),
  ]).toEqual([[], []]);
});
