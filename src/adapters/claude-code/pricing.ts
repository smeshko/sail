// Prices a Claude Code turn's tokens, so a session sail cuts short before the SDK's result still records what it spent.
// An estimate only: the result's `total_cost_usd` replaces it whenever it comes.
import type { SDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk';

export type TurnUsage = SDKAssistantMessage['message']['usage'];

/** Dollars per million tokens. */
export interface Prices {
  readonly input: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
  readonly cacheRead: number;
  readonly output: number;
}

export interface PriceEntry extends Prices {
  /** The prices of a turn whose prompt runs past `tokens`. */
  readonly over?: { readonly tokens: number; readonly prices: Prices };
}

const p = (input: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number, output: number): Prices => ({
  input,
  cacheWrite5m,
  cacheWrite1h,
  cacheRead,
  output,
});

/** Prices by canonical model id. */
export const PRICES: Readonly<Record<string, PriceEntry>> = {
  'claude-fable-5-1': p(10, 12.5, 20, 0.25, 50),
  'claude-mythos-5-1': p(10, 12.5, 20, 0.25, 50),
  'claude-fable-5': p(10, 12.5, 20, 1, 50),
  'claude-mythos-5': p(10, 12.5, 20, 1, 50),
  'claude-opus-5-5': p(4, 5, 8, 0.2, 20),
  'claude-opus-5': p(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-8': p(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-7': p(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-6': p(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-5': p(5, 6.25, 10, 0.5, 25),
  'claude-sonnet-5-5': p(2, 2.5, 4, 0.1, 10),
  'claude-sonnet-5': p(2, 2.5, 4, 0.2, 10),
  'claude-sonnet-4-6': p(3, 3.75, 6, 0.3, 15),
  'claude-sonnet-4-5': p(3, 3.75, 6, 0.3, 15),
  'claude-haiku-5-5': {
    ...p(0.1, 0.125, 0.2, 0.01, 0.5),
    over: { tokens: 100_000, prices: p(0.5, 0.625, 1, 0.05, 2.5) },
  },
  'claude-haiku-4-5': p(1, 1.25, 2, 0.1, 5),
};

const COLUMNS: readonly (keyof Prices)[] = ['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output'];

/** The dearest rate in each column across the table, which a model the table doesn't know is priced at. */
export const DEAREST: Prices = (() => {
  const tiers = Object.values(PRICES).flatMap((entry) => (entry.over ? [entry, entry.over.prices] : [entry]));
  const column = (key: keyof Prices): number => Math.max(...tiers.map((tier) => tier[key]));
  const [input, cacheWrite5m, cacheWrite1h, cacheRead, output] = COLUMNS.map(column) as [
    number,
    number,
    number,
    number,
    number,
  ];
  return { input, cacheWrite5m, cacheWrite1h, cacheRead, output };
})();

const KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);

/** The entry for the longest table key `model` contains, where no digit follows the key, else the dearest rates. */
export function priceOf(model: string): PriceEntry {
  for (const key of KEYS) {
    let at = model.indexOf(key);
    while (at !== -1) {
      if (!/\d/.test(model.charAt(at + key.length))) return PRICES[key] as PriceEntry;
      at = model.indexOf(key, at + 1);
    }
  }
  return DEAREST;
}

/** A turn's cost in dollars, rounded to the 1e-7 the SDK reports. */
export function turnCost(model: string, usage: TurnUsage): number {
  const entry = priceOf(model);
  const input = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const prices = entry.over && input + cacheRead + cacheWrite > entry.over.tokens ? entry.over.prices : entry;
  const write5m = Math.min(usage.cache_creation?.ephemeral_5m_input_tokens ?? 0, cacheWrite);
  const write1h = cacheWrite - write5m;
  const dollars =
    (input * prices.input +
      cacheRead * prices.cacheRead +
      write5m * prices.cacheWrite5m +
      write1h * prices.cacheWrite1h +
      output * prices.output) /
    1_000_000;
  return Math.round(dollars * 1e7) / 1e7;
}
