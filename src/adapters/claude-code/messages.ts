// Maps one SDK message to the harness events it gives: the session's start, its text and thinking, its tool calls and
// their ends. Result messages are read by result.ts, usage by usage.ts, and stream events and unknown types give nothing.
import type { HarnessEvent } from '../../ports/harness';
import type { SDKMessage } from './sdk';

/** What the mapper carries from one message to the next. */
export interface MapState {
  readonly key: string;
  readonly model: string;
  readonly now: () => number;
  /** Tool calls started and not yet ended, by call id, with the time each started. */
  readonly open: Map<string, number>;
  /** Whether the session has started. */
  started: boolean;
}

/** A state for one call's session. */
export function startMapping(key: string, model: string, now: () => number): MapState {
  return { key, model, now, open: new Map(), started: false };
}

/** A content block as the SDK's messages carry it. Only the fields the mapper reads are typed. */
type Block = { readonly type: string } & Readonly<Record<string, unknown>>;

/** The events of one assistant block: its thinking, its text, or the start of a tool call. */
function assistantBlock(block: Block, state: MapState): HarnessEvent[] {
  switch (block.type) {
    case 'thinking':
      return [{ type: 'agent:thinking', text: String(block.thinking) }];
    case 'text':
      return [{ type: 'agent:message', text: String(block.text) }];
    case 'tool_use': {
      const callId = String(block.id);
      state.open.set(callId, state.now());
      return [{ type: 'tool:start', callId, tool: String(block.name), input: block.input }];
    }
    default:
      return [];
  }
}

/** The end of one tool call, when its start is open. A result for a call not open gives nothing and reads no clock. */
function userBlock(block: Block, state: MapState): HarnessEvent[] {
  if (block.type !== 'tool_result') return [];
  const callId = String(block.tool_use_id);
  const started = state.open.get(callId);
  if (started === undefined) return [];
  state.open.delete(callId);
  const status = block.is_error === true ? 'failed' : 'completed';
  return [{ type: 'tool:end', callId, status, durationMs: state.now() - started }];
}

/** The content of a message as blocks: a plain string carries none. */
function blocksOf(content: unknown): Block[] {
  return Array.isArray(content) ? (content as Block[]) : [];
}

/** The events of one SDK message, in the message's order. */
export function mapMessage(message: SDKMessage, state: MapState): HarnessEvent[] {
  switch (message.type) {
    case 'system': {
      if (message.subtype !== 'init' || state.started) return [];
      state.started = true;
      return [
        { type: 'harness:session_start', adapter: 'claude-code', sessionId: message.session_id, model: state.model },
      ];
    }
    case 'assistant':
      return blocksOf(message.message.content).flatMap((block) => assistantBlock(block, state));
    case 'user':
      return blocksOf(message.message.content).flatMap((block) => userBlock(block, state));
    default:
      return [];
  }
}
