// The price table: it reproduces the SDK's own costs for recorded sessions, matches a model's id variants, and reads an
// unknown model high.
import { expect, test } from 'bun:test';
import {
  DEAREST,
  PRICES,
  type PriceEntry,
  priceOf,
  type TurnUsage,
  turnCost,
} from '../../../src/adapters/claude-code/pricing';
import { turnUsage } from '../../helpers/claude-code';

const entry = (id: string) => PRICES[id] as PriceEntry;

const SESSIONS = 'test/fixtures/sessions/fake-1-claude-code';

interface RecordedModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  canonicalModel: string;
}

const usageOf = (m: RecordedModelUsage): TurnUsage => ({
  ...turnUsage({
    input: m.inputTokens,
    output: m.outputTokens,
    cacheRead: m.cacheReadInputTokens,
    cacheWrite: m.cacheCreationInputTokens,
  }),
});

async function recorded(file: string): Promise<[string, RecordedModelUsage][]> {
  const session = JSON.parse(await Bun.file(`${SESSIONS}/${file}`).text()) as {
    tries: { raw: { modelUsage?: Record<string, RecordedModelUsage> }[] }[];
  };
  const entries = session.tries
    .flatMap((t) => t.raw)
    .flatMap((raw) => (raw.modelUsage === undefined ? [] : [Object.entries(raw.modelUsage)]));
  return entries[0] ?? [];
}

test('the table reproduces the SDK cost of recorded Opus 5.5, Sonnet 5 and Haiku 4.5 sessions exactly, cache writes at the 1h rate', async () => {
  const found: Record<string, [number, number]> = {};
  for (const file of ['spec#1.json', 'implement#2.json']) {
    for (const [id, m] of await recorded(file))
      found[`${file}:${m.canonicalModel}`] = [turnCost(id, usageOf(m)), m.costUSD];
  }
  expect(found).toEqual({
    'spec#1.json:claude-haiku-4-5': [0.001246, 0.001246],
    'spec#1.json:claude-opus-5-5': [0.1212982, 0.1212982],
    'implement#2.json:claude-haiku-4-5': [0.00122, 0.00122],
    'implement#2.json:claude-sonnet-5': [0.5163638, 0.5163638],
  });
});

test('priceOf matches dated, [1m], Bedrock and Vertex ids, and prefers claude-opus-5-5 over claude-opus-5', () => {
  expect({
    dated: priceOf('claude-haiku-4-5-20251001'),
    long: priceOf('claude-sonnet-5[1m]'),
    bedrock: priceOf('us.anthropic.claude-sonnet-4-5-20250929-v1:0'),
    vertex: priceOf('claude-sonnet-4-5@20250929'),
    longest: priceOf('claude-opus-5-5'),
    shorter: priceOf('claude-opus-5-20260101'),
  }).toEqual({
    dated: entry('claude-haiku-4-5'),
    long: entry('claude-sonnet-5'),
    bedrock: entry('claude-sonnet-4-5'),
    vertex: entry('claude-sonnet-4-5'),
    longest: entry('claude-opus-5-5'),
    shorter: entry('claude-opus-5'),
  });
});

test('a key followed by a digit is no match: an unknown model gets the dearest rate of every column', () => {
  expect(priceOf('claude-sonnet-55')).toBe(DEAREST);
  expect(priceOf('some-other-model')).toBe(DEAREST);
  const tiers = Object.values(PRICES).flatMap((e) => (e.over ? [e, e.over.prices] : [e]));
  for (const tier of tiers) {
    expect(DEAREST.input).toBeGreaterThanOrEqual(tier.input);
    expect(DEAREST.cacheWrite5m).toBeGreaterThanOrEqual(tier.cacheWrite5m);
    expect(DEAREST.cacheWrite1h).toBeGreaterThanOrEqual(tier.cacheWrite1h);
    expect(DEAREST.cacheRead).toBeGreaterThanOrEqual(tier.cacheRead);
    expect(DEAREST.output).toBeGreaterThanOrEqual(tier.output);
  }
  expect(DEAREST).toEqual({ input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1, output: 50 });
  expect(turnCost('some-other-model', turnUsage({ input: 1_000_000 }))).toBe(10);
});

test('a Haiku 5.5 turn over 100,000 prompt tokens is priced at the upper tier', () => {
  expect({
    under: turnCost('claude-haiku-5-5', turnUsage({ input: 100_000, output: 1_000_000 })),
    over: turnCost('claude-haiku-5-5', turnUsage({ input: 100_001, output: 1_000_000 })),
    overByCache: turnCost('claude-haiku-5-5', turnUsage({ input: 1, cacheRead: 100_000, output: 1_000_000 })),
  }).toEqual({ under: 0.51, over: 2.5500005, overByCache: 2.5050005 });
});

test('cache writes are priced at the 5m rate for the 5m part and at the 1h rate for the rest', () => {
  const usage = {
    ...turnUsage({ cacheWrite: 3_000_000 }),
    cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 2_000_000 },
  } as TurnUsage;
  expect(turnCost('claude-sonnet-5', usage)).toBe(10.5);
});
