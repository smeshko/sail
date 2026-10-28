// Reads a pi session's events as sail's harness events. pi closes an assistant message before it runs the tools that
// message asked for, so a message's thoughts, text and cost come out at its `message_end`, each tool call at its
// `tool_execution_start` and `_end`, and a turn's `usage:update` when the turn ends, after its tools: cumulative tokens
// and the cost so far, which pi reports per message. A denial is held until its call's end, so `permission:denied`
// never precedes the call's `tool:start`.
import type { HarnessEvent } from '../../ports/harness';
import type { Usage } from '../../ports/types';
import { RESULT_LENGTH, type ReaderState } from '../claude-code/messages';
import type { Denial } from '../claude-code/tool-call';

/** One event of a pi session, as `session.subscribe` hands it over: only the fields the reader uses are named. */
export interface PiEvent {
  readonly type: string;
  readonly [field: string]: unknown;
}

export interface PiReaderOptions {
  /** The model the request asked for, which the session start reports. */
  readonly model: string;
  /** The session's id, which the session start reports. */
  readonly sessionId: string;
  /** Milliseconds, for a tool call's duration. */
  readonly now?: () => number;
}

export interface PiSessionReader {
  read(event: PiEvent): HarnessEvent[];
  /** Fails each tool still open and emits each denial still held. */
  settle(): HarnessEvent[];
  state(): ReaderState;
  /**
   * Marks a tool call as denied, so its end says so and the session counts it. A denial given is held until the call's
   * end, and emitted as `permission:denied` just before it.
   */
  markDenied(toolCallId: string, denial?: Denial): void;
}

type Fields = Record<string, unknown>;

const fieldsOf = (value: unknown): Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : {};

const numberOf = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** The text a tool result carries, its text blocks joined and cut to `RESULT_LENGTH`. An image or other block adds none. */
function resultOf(result: unknown): string {
  const content = fieldsOf(result).content;
  const texts = Array.isArray(content)
    ? content.flatMap((block) => {
        const fields = fieldsOf(block);
        return fields.type === 'text' && typeof fields.text === 'string' ? [fields.text] : [];
      })
    : [];
  const found = texts.join('\n').trimEnd();
  return found.length > RESULT_LENGTH ? `${found.slice(0, RESULT_LENGTH)}…` : found;
}

export function createPiSessionReader(options: PiReaderOptions): PiSessionReader {
  const now = () => options.now?.() ?? Date.now();
  const events: HarnessEvent[] = [];
  const failures: string[] = [];
  const open = new Map<string, number>();
  const denied = new Set<string>();
  const held = new Map<string, Denial>();
  let started = false;
  let turns = 0;
  let toolCalls = 0;
  let spent: { [K in keyof Usage]-?: number } = {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };

  const out = (found: HarnessEvent[]): HarnessEvent[] => {
    events.push(...found);
    return found;
  };

  const denialOf = (callId: string): HarnessEvent[] => {
    const denial = held.get(callId);
    if (denial === undefined) return [];
    held.delete(callId);
    return [{ type: 'permission:denied', callId, ...denial }];
  };

  const endTool = (callId: string, status: 'completed' | 'failed', result = ''): HarnessEvent[] => {
    const startedAt = open.get(callId) ?? now();
    open.delete(callId);
    return [
      ...denialOf(callId),
      {
        type: 'tool:end',
        callId,
        status: denied.has(callId) ? 'denied' : status,
        durationMs: Math.max(0, now() - startedAt),
        ...(result === '' ? {} : { result }),
      },
    ];
  };

  function assistant(message: Fields): HarnessEvent[] {
    const found: HarnessEvent[] = [];
    const usage = fieldsOf(message.usage);
    spent = {
      inputTokens: spent.inputTokens + numberOf(usage.input),
      cacheReadTokens: spent.cacheReadTokens + numberOf(usage.cacheRead),
      cacheWriteTokens: spent.cacheWriteTokens + numberOf(usage.cacheWrite),
      outputTokens: spent.outputTokens + numberOf(usage.output),
      costUsd: spent.costUsd + numberOf(fieldsOf(usage.cost).total),
    };
    if (message.stopReason === 'error' && typeof message.errorMessage === 'string') {
      failures.push(message.errorMessage);
    }
    for (const entry of Array.isArray(message.content) ? message.content : []) {
      const block = fieldsOf(entry);
      if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
        found.push({ type: 'agent:message', text: block.text });
      } else if (block.type === 'thinking') {
        const text = block.redacted === true ? '[redacted]' : String(block.thinking ?? '');
        found.push({ type: 'agent:thinking', text });
      }
    }
    return found;
  }

  return {
    read(event) {
      switch (event.type) {
        case 'agent_start':
          if (started) return [];
          started = true;
          return out([
            { type: 'harness:session_start', adapter: 'pi', sessionId: options.sessionId, model: options.model },
          ]);
        case 'message_end': {
          const message = fieldsOf(event.message);
          return message.role === 'assistant' ? out(assistant(message)) : [];
        }
        case 'tool_execution_start':
          toolCalls++;
          open.set(String(event.toolCallId), now());
          return out([
            { type: 'tool:start', callId: String(event.toolCallId), tool: String(event.toolName), input: event.args },
          ]);
        case 'tool_execution_end':
          return out(
            endTool(String(event.toolCallId), event.isError === true ? 'failed' : 'completed', resultOf(event.result)),
          );
        case 'turn_end': {
          turns++;
          return out([
            {
              type: 'usage:update',
              turn: turns,
              tokens: {
                input: spent.inputTokens,
                cacheRead: spent.cacheReadTokens,
                cacheWrite: spent.cacheWriteTokens,
                output: spent.outputTokens,
              },
              costUsdSoFar: spent.costUsd,
            },
          ]);
        }
        default:
          return [];
      }
    },
    settle() {
      const found: HarnessEvent[] = [];
      for (const callId of [...open.keys()]) found.push(...endTool(callId, 'failed'));
      for (const callId of [...held.keys()]) found.push(...denialOf(callId));
      return out(found);
    },
    state: () => ({
      ...(started ? { sessionId: options.sessionId, model: options.model } : {}),
      turns,
      toolCalls,
      denials: denied.size,
      spent,
      failures: [...failures],
      events: [...events],
    }),
    markDenied(toolCallId, denial) {
      denied.add(toolCallId);
      if (denial !== undefined) held.set(toolCallId, denial);
    },
  };
}
