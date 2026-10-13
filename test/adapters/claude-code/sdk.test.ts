// The SDK boundary (TASK-001). Typecheck proves the option and message names against the pinned typings: the typed
// literals and field reads below fail `bun run typecheck` if the SDK lacks one. At runtime, sdk.ts re-exports the SDK's
// query and nothing else, so importing it starts nothing.
import { expect, test } from 'bun:test';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKResultMessage } from '../../../src/adapters/claude-code/sdk';
import * as adapterSdk from '../../../src/adapters/claude-code/sdk';

// Compile-time: each option the plan names exists on Options, with the plan's shape.
const _options: Options = {
  outputFormat: { type: 'json_schema', schema: { type: 'object' } },
  settingSources: [],
  maxTurns: 2,
  maxBudgetUsd: 0.05,
  abortController: new AbortController(),
  includePartialMessages: false,
  allowedTools: ['Read'],
  systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Submit once.' },
  cwd: '/work/fixture',
  model: 'claude-test-model',
  env: { STAGE_IN: '/work/in' },
  permissionMode: 'default',
};

// Compile-time: each result field the adapter reads exists on the result union, and the success-only field is read
// only after a narrowing on the subtype.
function _readResult(message: SDKResultMessage): string {
  const cost: number = message.total_cost_usd;
  const turns: number = message.num_turns;
  const errored: boolean = message.is_error;
  const models: object = message.modelUsage;
  const counted: object = message.usage;
  if (message.subtype === 'success')
    return `${message.result}${String(message.structured_output)}${cost}${turns}${errored}${Object.keys(models).length}${Object.keys(counted).length}`;
  return `${message.subtype}${message.errors.join()}`;
}

test('sdk.ts re-exports the SDK query and nothing else at runtime, so importing it starts nothing', () => {
  expect(Object.keys(adapterSdk)).toEqual(['query']);
  expect(adapterSdk.query).toBe(sdk.query);
});
