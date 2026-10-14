// Synthetic Claude Code sessions (D12): builders typed as the Agent SDK's own messages, so a field the SDK renames fails
// `typecheck`, and scriptedQuery(), a stand-in for `query()` that plays one scripted stream per session. No test spawns
// Claude Code or reaches the network. writeScriptedClaudeCode() gives a copy of the fixture repository a harness
// adapter that is the built-in claude-code on such a query, so `sail` runs it offline.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type {
  ModelUsage,
  NonNullableUsage,
  Options,
  SDKAssistantMessage,
  SDKAssistantMessageError,
  SDKAuthStatusMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultError,
  SDKResultSuccess,
  SDKSystemMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { QueryFunction } from '../../src/adapters/claude-code/harness';

type Uuid = SDKAssistantMessage['uuid'];
type BetaMessage = SDKAssistantMessage['message'];
type ContentBlock = BetaMessage['content'][number];
type TurnUsage = BetaMessage['usage'];

const UUID: Uuid = '00000000-0000-4000-8000-000000000000';
export const SESSION_ID = 'cc-session-1';
export const MODEL = 'claude-sonnet-5';

/** Token counts, as a test writes them. */
export interface Tokens {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/** A turn's usage, as an assistant message carries it. */
export function turnUsage(tokens: Tokens = {}): TurnUsage {
  return {
    input_tokens: tokens.input ?? 0,
    output_tokens: tokens.output ?? 0,
    cache_read_input_tokens: tokens.cacheRead ?? 0,
    cache_creation_input_tokens: tokens.cacheWrite ?? 0,
    cache_creation: null,
    fallback_credit: null,
    inference_geo: null,
    iterations: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    speed: null,
  };
}

export function init(options: { sessionId?: string; model?: string } = {}): SDKSystemMessage {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'ANTHROPIC_API_KEY',
    claude_code_version: '2.1.282',
    cwd: '/work',
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit'],
    mcp_servers: [],
    model: options.model ?? MODEL,
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: UUID,
    session_id: options.sessionId ?? SESSION_ID,
  };
}

export interface AssistantOptions {
  readonly usage?: Tokens;
  /** The subagent's tool call it belongs to; null for the session's own turns. */
  readonly parent?: string | null;
  readonly error?: SDKAssistantMessageError;
}

/** An assistant message of turn `id`, holding `content`. */
export function assistant(id: string, content: ContentBlock[], options: AssistantOptions = {}): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      id,
      container: null,
      content,
      context_management: null,
      diagnostics: null,
      model: MODEL,
      role: 'assistant',
      stop_details: null,
      stop_reason: null,
      stop_sequence: null,
      type: 'message',
      usage: turnUsage(options.usage),
    },
    parent_tool_use_id: options.parent ?? null,
    ...(options.error === undefined ? {} : { error: options.error }),
    uuid: UUID,
    session_id: SESSION_ID,
  };
}

export const assistantText = (id: string, text: string, options: AssistantOptions = {}): SDKAssistantMessage =>
  assistant(id, [{ type: 'text', text, citations: null }], options);

export const assistantThinking = (id: string, thinking: string, options: AssistantOptions = {}): SDKAssistantMessage =>
  assistant(id, [{ type: 'thinking', thinking, signature: 'sig' }], options);

export const assistantRedacted = (id: string, options: AssistantOptions = {}): SDKAssistantMessage =>
  assistant(id, [{ type: 'redacted_thinking', data: 'opaque' }], options);

export const assistantToolUse = (
  id: string,
  callId: string,
  name: string,
  input: unknown,
  options: AssistantOptions = {},
): SDKAssistantMessage => assistant(id, [{ type: 'tool_use', id: callId, name, input }], options);

/** The user message that answers tool call `callId`. */
export function toolResult(
  callId: string,
  options: { isError?: boolean; parent?: string | null } = {},
): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: callId, content: 'ok', is_error: options.isError ?? false }],
    },
    parent_tool_use_id: options.parent ?? null,
    session_id: SESSION_ID,
  };
}

export function streamEvent(): SDKPartialAssistantMessage {
  return {
    type: 'stream_event',
    event: { type: 'message_stop' },
    parent_tool_use_id: null,
    uuid: UUID,
    session_id: SESSION_ID,
  };
}

export function authStatus(error?: string): SDKAuthStatusMessage {
  return {
    type: 'auth_status',
    isAuthenticating: false,
    output: [],
    ...(error === undefined ? {} : { error }),
    uuid: UUID,
    session_id: SESSION_ID,
  };
}

/** One model's share of a result's usage. */
export function modelUsage(tokens: Tokens, costUSD: number, provider?: string): ModelUsage {
  return {
    inputTokens: tokens.input ?? 0,
    outputTokens: tokens.output ?? 0,
    cacheReadInputTokens: tokens.cacheRead ?? 0,
    cacheCreationInputTokens: tokens.cacheWrite ?? 0,
    webSearchRequests: 0,
    costUSD,
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    ...(provider === undefined ? {} : { provider }),
  };
}

/** The tokens and cost of a result whose session spent `tokens` on one model for `costUsd`. */
export const SPENT: Tokens = { input: 120, output: 340, cacheRead: 5000, cacheWrite: 800 };
export const COST = 0.0425;

/** A result's main-loop usage: the SDK carries it, and the reader takes `modelUsage` instead. */
const MAIN_LOOP: NonNullableUsage = turnUsage() as unknown as NonNullableUsage;

export interface ResultOptions {
  readonly sessionId?: string;
  readonly numTurns?: number;
  readonly cost?: number;
  readonly models?: Record<string, ModelUsage>;
}

const resultBase = (options: ResultOptions) => ({
  type: 'result' as const,
  duration_ms: 1200,
  duration_api_ms: 900,
  num_turns: options.numTurns ?? 2,
  stop_reason: null,
  total_cost_usd: options.cost ?? COST,
  usage: MAIN_LOOP,
  modelUsage: options.models ?? { [MODEL]: modelUsage(SPENT, options.cost ?? COST) },
  permission_denials: [],
  uuid: UUID,
  session_id: options.sessionId ?? SESSION_ID,
});

export function resultSuccess(
  options: ResultOptions & { structured?: unknown; isError?: boolean; result?: string } = {},
): SDKResultSuccess {
  return {
    ...resultBase(options),
    subtype: 'success',
    is_error: options.isError ?? false,
    result: options.result ?? 'Done.',
    ...('structured' in options ? { structured_output: options.structured } : {}),
  };
}

export function resultError(
  subtype: SDKResultError['subtype'],
  options: ResultOptions & { errors?: string[] } = {},
): SDKResultError {
  return { ...resultBase(options), subtype, is_error: true, errors: options.errors ?? [] };
}

/** A done submission of `output`. */
export const done = (output: unknown) => ({ outcome: 'done', output });

/** Something a scripted session does that is no message: each is acted out when its turn in the stream comes. */
export type Act =
  /** Writes `text` to `file` in the session's `$STAGE_OUT`. */
  | { readonly act: 'write'; readonly file: string; readonly text: string }
  /** Asks the session's `canUseTool` about a tool call. */
  | {
      readonly act: 'useTool';
      readonly tool: string;
      readonly input: Record<string, unknown>;
      readonly toolUseID: string;
    }
  /** Waits until the session's controller aborts, then throws as the SDK does. */
  | { readonly act: 'waitForAbort' }
  /** Throws, as a broken stream does. */
  | { readonly act: 'throw'; readonly message: string };

export type Step = SDKMessage | Act;
export type Stream = readonly Step[];

export interface ScriptedQuery extends QueryFunction {
  /** Each session's prompt and options, in order. */
  readonly calls: { prompt: string; options: Options }[];
  /** What each `canUseTool` asked answered, in order. */
  readonly verdicts: unknown[];
}

const isAct = (step: Step): step is Act => 'act' in step;

/** A `query()` that plays `streams[n]` for the nth session, and the last stream for every one after it. */
export function scriptedQuery(streams: readonly Stream[]): ScriptedQuery {
  const calls: { prompt: string; options: Options }[] = [];
  const verdicts: unknown[] = [];
  const play = async function* (stream: Stream, options: Options): AsyncGenerator<SDKMessage, void> {
    for (const step of stream) {
      if (!isAct(step)) {
        yield step;
        continue;
      }
      switch (step.act) {
        case 'write': {
          const path = join(options.env?.STAGE_OUT ?? '', step.file);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, step.text);
          break;
        }
        case 'useTool': {
          const signal = options.abortController?.signal ?? new AbortController().signal;
          verdicts.push(
            await options.canUseTool?.(step.tool, step.input, { signal, toolUseID: step.toolUseID, requestId: 'r1' }),
          );
          break;
        }
        case 'waitForAbort': {
          const signal = options.abortController?.signal;
          if (signal !== undefined && !signal.aborted) {
            await new Promise((settle) => signal.addEventListener('abort', settle, { once: true }));
          }
          throw new Error('Claude Code process aborted by user');
        }
        case 'throw':
          throw new Error(step.message);
      }
    }
  };
  const query = (params: { prompt: string; options: Options }) => {
    calls.push(params);
    const stream = streams[Math.min(calls.length, streams.length) - 1] ?? [];
    return play(stream, params.options);
  };
  return Object.assign(query, { calls, verdicts });
}

/** A session that writes `spec.md`, says one thing over two turns, and submits `output`. */
export function specSession(output: unknown, options: ResultOptions = {}, spec = '# Spec\n'): Stream {
  return [
    init(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    { act: 'write', file: 'spec.md', text: spec },
    assistantToolUse('m1', 'tool-1', 'Write', { file_path: 'spec.md' }, { usage: { input: 60, output: 120 } }),
    toolResult('tool-1'),
    assistantText('m2', 'Spec written.', { usage: { input: 60, output: 220 } }),
    resultSuccess({ ...options, structured: done(output) }),
  ];
}

/** The stream of a session whose API key the provider refused. */
export const INVALID_KEY = 'Invalid API key · Fix external API key';
export function invalidKeySession(): Stream {
  return [
    init(),
    assistantText('m1', INVALID_KEY, { error: 'authentication_failed' }),
    resultSuccess({
      isError: true,
      result: INVALID_KEY,
      numTurns: 1,
      cost: 0,
      models: {},
    }),
  ];
}

const HELPER = resolve(import.meta.dir, 'claude-code.ts');
const ADAPTER = resolve(import.meta.dir, '..', '..', 'src', 'adapters', 'claude-code', 'index.ts');
export const SCRIPTED_ADAPTER = './adapters/claude-code-scripted.ts';

/**
 * Gives the repository at `repoDir` a harness adapter that is the built-in claude-code, with its `requires` and
 * `versions`, on a query that plays `streams`, and points `project.yaml`'s harness at it.
 */
export function writeScriptedClaudeCode(repoDir: string, streams: readonly Stream[]): void {
  const sail = join(repoDir, '.sail');
  writeFileSync(join(sail, 'claude-code-streams.json'), `${JSON.stringify(streams)}\n`);
  const source = `// The built-in claude-code harness on a scripted query(): a test's, written by writeScriptedClaudeCode().
import { readFileSync } from 'node:fs';
import { claudeCodeAdapters, createClaudeCodeHarness } from ${JSON.stringify(ADAPTER)};
import { scriptedQuery } from ${JSON.stringify(HELPER)};

const streams = JSON.parse(readFileSync(${JSON.stringify(join(sail, 'claude-code-streams.json'))}, 'utf8'));
const builtin = claudeCodeAdapters.harness;

export default {
  requires: builtin.requires,
  versions: builtin.versions,
  create: (_options, context) => createClaudeCodeHarness({ env: context.env, query: scriptedQuery(streams) }),
};
`;
  mkdirSync(join(sail, 'adapters'), { recursive: true });
  writeFileSync(join(sail, SCRIPTED_ADAPTER), source);
  const config = join(sail, 'project.yaml');
  const text = readFileSync(config, 'utf8');
  if (!text.includes('harness: { use: fake }')) throw new Error(`${config} has no fake harness to replace`);
  writeFileSync(config, text.replace('harness: { use: fake }', `harness: { use: ${SCRIPTED_ADAPTER} }`));
}
