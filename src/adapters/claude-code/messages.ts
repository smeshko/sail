// Reads a Claude Code session's SDK messages as sail's harness events (D3, D4, D14). The SDK sends one assistant
// message per content block, and the messages of one turn share its `message.id`, each carrying usage that isn't final
// until the turn is over: so a turn's usage is the last one its messages carried, and its `usage:update` is emitted
// when the turn closes. Cost comes only from the result. No partial message is asked for, and one that comes anyway
// emits nothing, so no chunk ever reaches the bus.
//
// STUB (TASK-003): signatures only, each returning a wrong value.
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessEvent } from '../../ports/harness';
import type { Usage } from '../../ports/types';

/** Token counts as a usage update carries them. */
interface Tokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface SessionReaderOptions {
  /** The adapter's name, which the session start reports. */
  readonly adapter: string;
  /** The model the request asked for: the session start's when the session reports none. */
  readonly model: string;
  /** Milliseconds, for a tool call's duration. */
  readonly now?: () => number;
}

/** What a session has said so far. */
export interface ReaderState {
  readonly sessionId?: string;
  readonly model?: string;
  readonly turns: number;
  readonly toolCalls: number;
  readonly denials: number;
  /** Tokens over the closed turns, or the result's totals once it has come, with its cost. */
  readonly spent: Usage;
  /** The provider's text of every failure the session reported before its result, in order. */
  readonly failures: readonly string[];
  /** Every event read or settled, in order. */
  readonly events: readonly HarnessEvent[];
}

export interface SessionReader {
  read(message: SDKMessage): HarnessEvent[];
  /** Closes the last turn, fails each tool still open, and gives the result's own usage update when there is one. */
  settle(result: SDKResultMessage | undefined): HarnessEvent[];
  state(): ReaderState;
  /** Marks a tool call as denied, so its end says so and the session counts it. */
  markDenied(toolUseId: string): void;
}

/** A result's tokens: `modelUsage` summed over its models, which counts subagents' turns too. */
export function resultTokens(_result: SDKResultMessage): Tokens {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

export function createSessionReader(_options: SessionReaderOptions): SessionReader {
  return {
    read: () => [],
    settle: () => [],
    state: () => ({ turns: 0, toolCalls: 0, denials: 0, spent: { costUsd: 0 }, failures: [], events: [] }),
    markDenied: () => undefined,
  };
}
