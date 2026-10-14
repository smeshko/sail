// Reads a Claude Code session's SDK messages as sail's harness events (D3, D4, D14). The SDK sends one assistant
// message per content block, and the messages of one turn share its `message.id`, each carrying usage that isn't final
// until the turn is over: so a turn's usage is the last one its messages carried, and its `usage:update` is emitted
// when the turn closes. Cost comes only from the result. No partial message is asked for, and one that comes anyway
// emits nothing, so no chunk ever reaches the bus.
import type { SDKAssistantMessage, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessEvent } from '../../ports/harness';
import type { Usage } from '../../ports/types';
import type { Denial } from './tool-call';

type TurnUsage = SDKAssistantMessage['message']['usage'];

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
  markDenied(toolUseId: string, denial?: Denial): void;
}

const ZERO: Tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

const tokensOf = (usage: TurnUsage): Tokens => ({
  input: usage.input_tokens ?? 0,
  cacheRead: usage.cache_read_input_tokens ?? 0,
  cacheWrite: usage.cache_creation_input_tokens ?? 0,
  output: usage.output_tokens ?? 0,
});

const add = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  output: a.output + b.output,
});

const usageOf = (tokens: Tokens, costUsd: number): Usage => ({
  inputTokens: tokens.input,
  cacheReadTokens: tokens.cacheRead,
  cacheWriteTokens: tokens.cacheWrite,
  outputTokens: tokens.output,
  costUsd,
});

/** A result's tokens: `modelUsage` summed over its models, which counts subagents' turns too. */
export function resultTokens(result: SDKResultMessage): Tokens {
  return Object.values(result.modelUsage).reduce<Tokens>(
    (sum, model) =>
      add(sum, {
        input: model.inputTokens,
        cacheRead: model.cacheReadInputTokens,
        cacheWrite: model.cacheCreationInputTokens,
        output: model.outputTokens,
      }),
    ZERO,
  );
}

/** The text an assistant message carries, its text blocks joined. */
const textOf = (message: SDKAssistantMessage): string =>
  message.message.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();

export function createSessionReader(options: SessionReaderOptions): SessionReader {
  const now = () => options.now?.() ?? Date.now();
  const events: HarnessEvent[] = [];
  const failures: string[] = [];
  const open = new Map<string, number>();
  const denied = new Set<string>();
  let sessionId: string | undefined;
  let model: string | undefined;
  let turns = 0;
  let toolCalls = 0;
  let spent: Usage = usageOf(ZERO, 0);
  // The last usage each of the session's own turns carried, by message id. A tool's result can come between two
  // messages of one turn, since the CLI runs a tool while the model still writes, so a turn closed early is reopened by
  // its id's next message and its usage replaced, never added twice.
  const turnUsage = new Map<string, TurnUsage>();
  let openTurn: string | undefined;

  const out = (found: HarnessEvent[]): HarnessEvent[] => {
    events.push(...found);
    return found;
  };

  /** Closes the open turn, giving the usage update of every turn so far. */
  const closeTurn = (): HarnessEvent[] => {
    if (openTurn === undefined) return [];
    openTurn = undefined;
    turns = turnUsage.size;
    const closed = [...turnUsage.values()].reduce<Tokens>((sum, usage) => add(sum, tokensOf(usage)), ZERO);
    spent = usageOf(closed, 0);
    return [{ type: 'usage:update', turn: turns, tokens: closed, costUsdSoFar: 0 }];
  };

  const endTool = (callId: string, status: 'completed' | 'failed'): HarnessEvent => {
    const started = open.get(callId) ?? now();
    open.delete(callId);
    return {
      type: 'tool:end',
      callId,
      status: denied.has(callId) ? 'denied' : status,
      durationMs: Math.max(0, now() - started),
    };
  };

  function assistant(message: SDKAssistantMessage): HarnessEvent[] {
    const found: HarnessEvent[] = [];
    // A subagent's messages are no turns of this session: their tokens reach it through the result's modelUsage.
    if (message.parent_tool_use_id === null) {
      if (openTurn !== undefined && openTurn !== message.message.id) found.push(...closeTurn());
      openTurn = message.message.id;
      turnUsage.set(openTurn, message.message.usage);
    }
    if (message.error !== undefined) failures.push(textOf(message) || message.error);
    for (const block of message.message.content) {
      switch (block.type) {
        case 'text':
          if (block.text !== '') found.push({ type: 'agent:message', text: block.text });
          break;
        case 'thinking':
          found.push({ type: 'agent:thinking', text: block.thinking });
          break;
        case 'redacted_thinking':
          found.push({ type: 'agent:thinking', text: '[redacted]' });
          break;
        case 'tool_use':
          toolCalls++;
          open.set(block.id, now());
          found.push({ type: 'tool:start', callId: block.id, tool: block.name, input: block.input });
          break;
      }
    }
    return found;
  }

  function user(message: Extract<SDKMessage, { type: 'user' }>): HarnessEvent[] {
    const { content } = message.message;
    if (typeof content === 'string') return [];
    const found: HarnessEvent[] = [];
    for (const block of content) {
      if (block.type !== 'tool_result' || !open.has(block.tool_use_id)) continue;
      if (message.parent_tool_use_id === null) found.push(...closeTurn());
      found.push(endTool(block.tool_use_id, block.is_error === true ? 'failed' : 'completed'));
    }
    return found;
  }

  return {
    read(message) {
      switch (message.type) {
        case 'system':
          if (message.subtype !== 'init' || sessionId !== undefined) return [];
          sessionId = message.session_id;
          model = message.model || options.model;
          return out([{ type: 'harness:session_start', adapter: options.adapter, sessionId, model }]);
        case 'assistant':
          return out(assistant(message));
        case 'user':
          return out(user(message));
        case 'auth_status':
          if (message.error !== undefined) failures.push(message.error);
          return [];
        default:
          return [];
      }
    },
    settle(result) {
      const found = closeTurn();
      for (const callId of [...open.keys()]) found.push(endTool(callId, 'failed'));
      if (result !== undefined) {
        turns = Math.max(turns, result.num_turns);
        const tokens = resultTokens(result);
        spent = usageOf(tokens, result.total_cost_usd);
        found.push({ type: 'usage:update', turn: Math.max(1, turns), tokens, costUsdSoFar: result.total_cost_usd });
      }
      return out(found);
    },
    state: () => ({
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(model === undefined ? {} : { model }),
      turns,
      toolCalls,
      denials: denied.size,
      spent,
      failures: [...failures],
      events: [...events],
    }),
    markDenied(toolUseId) {
      denied.add(toolUseId);
    },
  };
}
