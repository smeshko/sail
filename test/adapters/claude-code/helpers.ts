// What the claude-code tests share: SDK messages as the CLI writes them (only the fields the adapter reads), a request for
// one session, and a scripted query that plays messages back and records what the adapter did with them. No test here
// starts a process or reaches the network.

import type { QueryFn } from '../../../src/adapters/claude-code/harness';
import type {
  Options,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from '../../../src/adapters/claude-code/sdk';
import type { HarnessRequest } from '../../../src/ports/harness';

export const SESSION_ID = '5d1f3c2e-8a4b-4c3d-9e2f-0a1b2c3d4e5f';
export const MODEL = 'claude-test-model';

/** A message as the SDK's own type names it. The builders are typed loosely: the adapter reads only what they set. */
const as = <T>(message: object): T => message as unknown as T;

/** The `system` message the CLI writes at the start of a session. */
export function init(sessionId = SESSION_ID, model = MODEL): SDKSystemMessage {
  return as<SDKSystemMessage>({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model,
    apiKeySource: 'ANTHROPIC_API_KEY',
  });
}

/** Token counts as the SDK's usage object gives them. */
export interface Tokens {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** An assistant message with message id `id`, content `blocks` and `usage` (zero when left out). */
export function assistant(id: string, blocks: readonly object[], usage: Tokens = {}): SDKAssistantMessage {
  return as<SDKAssistantMessage>({
    type: 'assistant',
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    message: {
      id,
      role: 'assistant',
      model: MODEL,
      content: blocks,
      usage: {
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      },
    },
  });
}

export const text = (value: string) => ({ type: 'text', text: value });
export const thinking = (value: string) => ({ type: 'thinking', thinking: value, signature: 'sig' });
export const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'tool_use',
  id,
  name,
  input,
});

/** A user message carrying one tool result for `toolUseId`. */
export function toolResult(toolUseId: string, isError = false, content = 'ok'): SDKUserMessage {
  return as<SDKUserMessage>({
    type: 'user',
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
  });
}

/** The result of a session that ran to `subtype: 'success'`, with its final text, structured output and totals. */
export function success(options: {
  structured?: unknown;
  result?: string;
  cost?: number;
  usage?: Tokens;
  sessionId?: string;
}): SDKResultMessage {
  const usage = options.usage ?? {};
  return as<SDKResultMessage>({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    result: options.result ?? '',
    stop_reason: 'end_turn',
    total_cost_usd: options.cost ?? 0,
    usage: {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    },
    modelUsage: {},
    permission_denials: [],
    session_id: options.sessionId ?? SESSION_ID,
    ...(options.structured === undefined ? {} : { structured_output: options.structured }),
  });
}

/** The result of a session that ended in an error subtype. */
export function failure(
  subtype:
    | 'error_during_execution'
    | 'error_max_turns'
    | 'error_max_budget_usd'
    | 'error_max_structured_output_retries',
  errors: readonly string[] = [],
  cost = 0,
): SDKResultMessage {
  return as<SDKResultMessage>({
    type: 'result',
    subtype,
    is_error: true,
    num_turns: 3,
    stop_reason: null,
    total_cost_usd: cost,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    errors: [...errors],
    session_id: SESSION_ID,
  });
}

/** The envelope a session submits when it is done: the step's output inside `outcome: 'done'`. */
export const done = (output: unknown) => ({ outcome: 'done', output });
/** The envelope a session submits when it is blocked. */
export const blocked = (reason: string) => ({ outcome: 'blocked', reason });

/** A request for one session. Each field can be replaced. */
export function requestOf(overrides: Partial<HarnessRequest> = {}): HarnessRequest {
  return {
    key: 'spec#1',
    try: 1,
    prompt: 'Write the spec.',
    cwd: '/work/fixture',
    env: { STAGE_IN: '/work/in', STAGE_OUT: '/work/out' },
    model: MODEL,
    permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: [] },
    budget: { maxTurns: 5, maxUsd: 1, maxMinutes: 5 },
    outputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    ...overrides,
  };
}

/** One scripted session: the messages it yields, and what it does instead of yielding the rest. */
export interface Script {
  readonly messages: readonly SDKMessage[];
  /** Throws `failWith` before the message at this index, or after the last message when it equals the count. */
  readonly failAfter?: number;
  readonly failWith?: unknown;
  /** Throws from `query()` itself, before any message. */
  readonly throwNow?: unknown;
}

/** What the adapter did with the scripted query: its calls, the messages it took, and each stream it closed. */
export class Probe {
  readonly calls: { prompt: string; options: Options }[] = [];
  /** Messages the adapter pulled from a stream. */
  yielded = 0;
  /** Streams the adapter closed, through return() or by running to the end. */
  closed = 0;
}

async function* play(script: Script, probe: Probe): AsyncGenerator<SDKMessage> {
  try {
    for (const [index, message] of script.messages.entries()) {
      if (script.failAfter === index) throw script.failWith;
      probe.yielded++;
      yield message;
    }
    if (script.failAfter === script.messages.length) throw script.failWith;
  } finally {
    probe.closed++;
  }
}

/** A query that plays the script for each prompt, and records every call in `probe`. A prompt with no script yields nothing. */
export function scriptedQuery(scripts: Readonly<Record<string, Script>>, probe: Probe = new Probe()): QueryFn {
  return ({ prompt, options }) => {
    probe.calls.push({ prompt, options });
    const script = scripts[prompt] ?? { messages: [] };
    if (script.throwNow !== undefined) throw script.throwNow;
    return play(script, probe);
  };
}

/** The message types of a list of harness events, in order. */
export const typesOf = (events: readonly { type: string }[]): string[] => events.map((event) => event.type);
