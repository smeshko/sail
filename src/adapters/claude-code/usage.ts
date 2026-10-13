// Counts a session's usage once per assistant message, by message id. The SDK gives cost only on the result, so the
// cumulative cost is 0 on every update until the result's `total_cost_usd`. The result's own usage is authoritative when
// it counts any token; the tally is the fallback. Cache counts stay apart from the raw input count (TASK-003).
import type { HarnessEvent } from '../../ports/harness';
import type { Usage } from '../../ports/types';
import type { SDKAssistantMessage, SDKResultMessage } from './sdk';

export interface Tally {
  /** The cumulative `usage:update` for a message whose id is new, or nothing for one already counted. */
  onAssistant(message: SDKAssistantMessage): HarnessEvent | undefined;
  /** The final `usage:update`, carrying the session's total cost. */
  onResult(message: SDKResultMessage): HarnessEvent | undefined;
  /** What the session spent so far. */
  usage(): Usage;
}

/** The four token counts a usage update carries. */
interface Tokens {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
}

const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

/** The four counts of an SDK usage object, or nothing when one is missing or not a whole number. */
function tokensOf(usage: unknown): Tokens | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined;
  const fields = usage as Readonly<Record<string, unknown>>;
  const counts = {
    input: fields.input_tokens,
    cacheRead: fields.cache_read_input_tokens,
    cacheWrite: fields.cache_creation_input_tokens,
    output: fields.output_tokens,
  };
  return Object.values(counts).every(isCount) ? (counts as Tokens) : undefined;
}

const sum = (tokens: Tokens): number => tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;

/** A tally for the call `key`. */
export function createTally(_key: string): Tally {
  const seen = new Set<string>();
  const counted = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let reported: Tokens | undefined;
  let costUsd = 0;

  const current = (): Tokens => reported ?? { ...counted };
  const update = (tokens: Tokens, costUsdSoFar: number): HarnessEvent => ({
    type: 'usage:update',
    turn: seen.size,
    tokens,
    costUsdSoFar,
  });

  return {
    onAssistant(message) {
      const id = message.message.id;
      if (seen.has(id)) return undefined;
      const tokens = tokensOf(message.message.usage);
      if (tokens === undefined) return undefined;
      seen.add(id);
      counted.input += tokens.input;
      counted.cacheRead += tokens.cacheRead;
      counted.cacheWrite += tokens.cacheWrite;
      counted.output += tokens.output;
      return update(current(), 0);
    },
    onResult(message) {
      const cost = message.total_cost_usd;
      costUsd = typeof cost === 'number' && cost >= 0 ? cost : 0;
      const reportedTokens = tokensOf(message.usage);
      if (reportedTokens !== undefined && sum(reportedTokens) > 0) reported = reportedTokens;
      return update(current(), costUsd);
    },
    usage() {
      const tokens = current();
      return {
        inputTokens: tokens.input,
        cacheReadTokens: tokens.cacheRead,
        cacheWriteTokens: tokens.cacheWrite,
        outputTokens: tokens.output,
        costUsd,
      };
    },
  };
}
