// Usage accounting: each assistant message counted once by message id, cumulative usage updates, and the session's total
// from the result (TASK-003). The per-message table is the cross-check against ADW's executor: the result's usage is
// authoritative, and the cache counts stay apart from the input count.
import { expect, test } from 'bun:test';
import type { SDKAssistantMessage, SDKResultMessage } from '../../../src/adapters/claude-code/sdk';
import { createTally } from '../../../src/adapters/claude-code/usage';
import { assistant, success, type Tokens, text, toolUse } from './helpers';

const KEY = 'spec#1';

/** An assistant message whose usage field `field` is `value`, the others zero. */
function brokenUsage(id: string, field: keyof Tokens, value: unknown): SDKAssistantMessage {
  const message = assistant(id, [text('x')]) as unknown as { message: { usage: Record<string, unknown> } };
  message.message.usage[field] = value;
  return message as unknown as SDKAssistantMessage;
}

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('two assistant messages with one message id count once: the repeat gives no usage update and adds no tokens', () => {
  const tally = createTally(KEY);
  const first = tally.onAssistant(
    assistant('msg_1', [text('Reading.'), toolUse('toolu_1', 'Read', { file_path: 'a.md' })], {
      input_tokens: 100,
      output_tokens: 20,
    }),
  );
  const repeat = tally.onAssistant(
    assistant('msg_1', [toolUse('toolu_2', 'Read', { file_path: 'b.md' })], { input_tokens: 100, output_tokens: 20 }),
  );
  expect(first).toEqual({
    type: 'usage:update',
    turn: 1,
    tokens: { input: 100, cacheRead: 0, cacheWrite: 0, output: 20 },
    costUsdSoFar: 0,
  });
  expect(repeat).toBeUndefined();
  expect(tally.usage().inputTokens).toBe(100);
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('each new message id gives a usage update numbered by the ids so far, with cumulative tokens from the four counts', () => {
  const tally = createTally(KEY);
  const first = tally.onAssistant(
    assistant('msg_1', [text('a')], {
      input_tokens: 100,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 10,
      output_tokens: 20,
    }),
  );
  const second = tally.onAssistant(
    assistant('msg_2', [text('b')], {
      input_tokens: 30,
      cache_creation_input_tokens: 5,
      output_tokens: 7,
    }),
  );
  expect([first, second]).toEqual([
    {
      type: 'usage:update',
        turn: 1,
      tokens: { input: 100, cacheRead: 50, cacheWrite: 10, output: 20 },
      costUsdSoFar: 0,
    },
    {
      type: 'usage:update',
        turn: 2,
      tokens: { input: 130, cacheRead: 50, cacheWrite: 15, output: 27 },
      costUsdSoFar: 0,
    },
  ]);
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('the result gives a final usage update at the same turn, with the result usage tokens and the total cost', () => {
  const tally = createTally(KEY);
  tally.onAssistant(assistant('msg_1', [text('a')], { input_tokens: 100, output_tokens: 20 }));
  tally.onAssistant(assistant('msg_2', [text('b')], { input_tokens: 30, output_tokens: 7 }));
  const final = tally.onResult(
    success({
      cost: 0.0421,
      usage: { input_tokens: 130, output_tokens: 28, cache_read_input_tokens: 50, cache_creation_input_tokens: 15 },
    }),
  );
  expect(final).toEqual({
    type: 'usage:update',
    turn: 2,
    tokens: { input: 130, cacheRead: 50, cacheWrite: 15, output: 28 },
    costUsdSoFar: 0.0421,
  });
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('a result with no usage gives its total cost with the tokens the tally counted', () => {
  const tally = createTally(KEY);
  tally.onAssistant(assistant('msg_1', [text('a')], { input_tokens: 100, output_tokens: 20 }));
  const bare = { ...success({ cost: 0.05 }) } as Record<string, unknown>;
  delete bare.usage;
  expect(tally.onResult(bare as unknown as SDKResultMessage)).toEqual({
    type: 'usage:update',
    turn: 1,
    tokens: { input: 100, cacheRead: 0, cacheWrite: 0, output: 20 },
    costUsdSoFar: 0.05,
  });
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('usage() gives the raw input count apart from the cache counts, and the session cost from the result', () => {
  const tally = createTally(KEY);
  tally.onAssistant(
    assistant('msg_1', [text('a')], { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 }),
  );
  tally.onAssistant(assistant('msg_2', [text('b')], { input_tokens: 30, cache_creation_input_tokens: 5, output_tokens: 7 }));
  tally.onResult(success({ cost: 0.0421 }));
  expect(tally.usage()).toEqual({
    inputTokens: 130,
    cacheReadTokens: 50,
    cacheWriteTokens: 5,
    outputTokens: 27,
    costUsd: 0.0421,
  });
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('a result with no total cost counts no cost, and its usage update says zero', () => {
  const tally = createTally(KEY);
  tally.onAssistant(assistant('msg_1', [text('a')], { input_tokens: 100, output_tokens: 20 }));
  const bare = { ...success({}) } as Record<string, unknown>;
  delete bare.total_cost_usd;
  const final = tally.onResult(bare as unknown as SDKResultMessage);
  expect([final, tally.usage().costUsd]).toEqual([
    {
      type: 'usage:update',
        turn: 1,
      tokens: { input: 100, cacheRead: 0, cacheWrite: 0, output: 20 },
      costUsdSoFar: 0,
    },
    0,
  ]);
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('a message whose usage count is missing or not a whole number gives nothing and adds nothing, and a valid one after it still counts', () => {
  const tally = createTally(KEY);
  const fractional = tally.onAssistant(brokenUsage('msg_bad', 'input_tokens', 1.5));
  const missing = tally.onAssistant(brokenUsage('msg_missing', 'output_tokens', undefined));
  const valid = tally.onAssistant(assistant('msg_2', [text('b')], { input_tokens: 40, output_tokens: 3 }));
  expect([fractional, missing]).toEqual([undefined, undefined]);
  expect(valid).toEqual({
    type: 'usage:update',
    turn: 1,
    tokens: { input: 40, cacheRead: 0, cacheWrite: 0, output: 3 },
    costUsdSoFar: 0,
  });
  expect(tally.usage().inputTokens).toBe(40);
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('the last cumulative cost update equals the result total cost, to within 1e-9, over a three-message session', () => {
  const tally = createTally(KEY);
  const updates = [
    tally.onAssistant(assistant('msg_1', [text('a')], { input_tokens: 10, output_tokens: 1 })),
    tally.onAssistant(assistant('msg_2', [text('b')], { input_tokens: 20, output_tokens: 2 })),
    tally.onAssistant(assistant('msg_3', [text('c')], { input_tokens: 30, output_tokens: 3 })),
    tally.onResult(success({ cost: 0.123456789, usage: { input_tokens: 60, output_tokens: 6 } })),
  ];
  const last = updates.at(-1);
  const lastCost = last?.type === 'usage:update' ? last.costUsdSoFar : Number.NaN;
  expect(Math.abs(lastCost - 0.123456789)).toBeLessThan(1e-9);
  expect(updates.slice(0, 3).map((update) => (update?.type === 'usage:update' ? update.costUsdSoFar : null))).toEqual([
    0, 0, 0,
  ]);
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('one message id repeated over three messages adds its usage once, not three times', () => {
  const tally = createTally(KEY);
  const updates = [1, 2, 3].map(() =>
    tally.onAssistant(assistant('msg_1', [text('a')], { input_tokens: 100, output_tokens: 20 })),
  );
  expect(updates.filter((update) => update !== undefined)).toHaveLength(1);
  expect(tally.usage()).toEqual({ inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20, costUsd: 0 });
});
