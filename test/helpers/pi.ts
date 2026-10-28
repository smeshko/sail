// pi session events as the SDK hands them over (`session.subscribe`), in the shapes of a recorded session.
import type { PiEvent } from '../../src/adapters/pi/messages';

export const PI_SESSION_ID = '0198f1c2-7d5b-7a3e-9a31-5b2f6a0c9d11';
export const PI_MODEL = 'groq/llama-3.3-70b-versatile';

export interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}

const usageOf = (usage: PiUsage = {}) => ({
  input: usage.input ?? 10,
  output: usage.output ?? 5,
  cacheRead: usage.cacheRead ?? 0,
  cacheWrite: usage.cacheWrite ?? 0,
  totalTokens: (usage.input ?? 10) + (usage.output ?? 5) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost ?? 0 },
});

export type PiBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; redacted?: boolean }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> };

export const agentStart = (): PiEvent => ({ type: 'agent_start' });

export function assistantEnd(
  content: PiBlock[],
  usage?: PiUsage,
  extra: { stopReason?: string; errorMessage?: string } = {},
): PiEvent {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content,
      api: 'openai-completions',
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      usage: usageOf(usage),
      stopReason: extra.stopReason ?? (content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop'),
      ...(extra.errorMessage === undefined ? {} : { errorMessage: extra.errorMessage }),
      timestamp: 1_760_000_000_000,
    },
  };
}

export const toolStart = (toolCallId: string, toolName: string, args: Record<string, unknown>): PiEvent => ({
  type: 'tool_execution_start',
  toolCallId,
  toolName,
  args,
});

export const toolEnd = (toolCallId: string, toolName: string, text: string, isError = false): PiEvent => ({
  type: 'tool_execution_end',
  toolCallId,
  toolName,
  result: { content: [{ type: 'text', text }], details: undefined },
  isError,
});

export const turnEnd = (): PiEvent => ({ type: 'turn_end', message: {}, toolResults: [] });
