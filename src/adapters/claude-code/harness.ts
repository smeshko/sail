// The claude-code Harness: one isolated Agent SDK `query()` session per request. The session gets the step's model,
// the workspace, the submission envelope and the turn and dollar budgets, and none of the user's own Claude Code
// settings, skills, memory or MCP servers (D8). Its messages become events as they come, every session that started
// ends once, and every failure, an abort included, is the `error` outcome: run() never rejects.
//
// For 7.3: the session's environment carries the provider's credentials (D7). No tool can read it while Bash is
// unavailable; once 7.3 enables Bash, it must scrub or deny that. 7.3 also checks that the process is gone after an
// abort: here the abort only fires the session's controller.
import {
  type Options,
  type SDKMessage,
  type SDKResultMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import type { Env } from '../../ports/adapter';
import type { Harness, HarnessEvent, HarnessRequest } from '../../ports/harness';
import type { HarnessCapabilities, HarnessResult } from '../../ports/types';
import { createFileGuard, FILE_TOOLS } from './guard';
import { createSessionReader, type SessionReader } from './messages';
import { toHarnessResult } from './result';
import { SUBMIT_CONTRACT, submissionEnvelope } from './submission';
import { renderTranscript } from './transcript';

/** What the harness calls to start a session: the SDK's `query()`, or a test's stand-in. */
export type QueryFunction = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export interface ClaudeCodeHarnessOptions {
  /** The adapter context's environment, which the session's is picked from. */
  readonly env: Env;
  readonly query?: QueryFunction;
  /** Milliseconds, for tool durations. */
  readonly now?: () => number;
}

/** The names of sail's environment a session may see, beside its call's preamble (D7). */
export const ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_*',
  'TERM',
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_*',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'AWS_*',
  'CLOUD_ML_REGION',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
];

const allowed = (name: string): boolean =>
  ENV_ALLOWLIST.some((entry) => (entry.endsWith('*') ? name.startsWith(entry.slice(0, -1)) : name === entry));

/** The session's environment: the allowlisted names of `env`, then the call's preamble, which wins a clash. */
export function sessionEnv(preamble: Readonly<Record<string, string>>, env: Env): Record<string, string> {
  const picked = Object.entries(env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && allowed(entry[0]),
  );
  return { ...Object.fromEntries(picked), CLAUDE_AGENT_SDK_CLIENT_APP: 'sail', ...preamble };
}

/** The SDK options of `request`'s session, with a controller of its own and the file guard. */
export function sessionOptions(
  request: HarnessRequest,
  env: Env,
  onDenied?: (toolUseId: string, reason: string) => void,
): Options & { abortController: AbortController } {
  const stageDirs = [request.env.STAGE_IN, request.env.STAGE_OUT].filter(
    (dir): dir is string => dir !== undefined && dir !== '',
  );
  return {
    abortController: new AbortController(),
    cwd: request.cwd,
    model: request.model,
    env: sessionEnv(request.env, env),
    additionalDirectories: [...new Set(stageDirs)],
    settingSources: [],
    settings: { autoMemoryEnabled: false },
    skills: [],
    strictMcpConfig: true,
    mcpServers: {},
    persistSession: false,
    includePartialMessages: false,
    tools: [...FILE_TOOLS],
    permissionMode: 'default',
    canUseTool: createFileGuard({
      roots: [request.cwd, ...stageDirs],
      cwd: request.cwd,
      ...(onDenied === undefined ? {} : { onDenied }),
    }),
    outputFormat: { type: 'json_schema', schema: submissionEnvelope(request.outputSchema) },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: SUBMIT_CONTRACT },
    maxTurns: request.budget.maxTurns,
    maxBudgetUsd: request.budget.maxUsd,
  };
}

const CAPABILITIES: HarnessCapabilities = {
  structuredOutput: true,
  permissions: true,
  usage: true,
  abort: true,
  budgets: ['turns', 'usd'],
};

export function createClaudeCodeHarness(options: ClaudeCodeHarnessOptions): Harness {
  const query = options.query ?? sdkQuery;

  async function session(
    request: HarnessRequest,
    reader: SessionReader,
    sessionAt: Options & { abortController: AbortController },
  ): Promise<HarnessResult> {
    const said: HarnessEvent[] = [];
    let deaf = false;
    /** Emits `event`; an onEvent that throws hears no more, and its throw ends the session. */
    const emit = (event: HarnessEvent): void => {
      said.push(event);
      if (deaf) return;
      try {
        request.onEvent?.(event);
      } catch (error) {
        deaf = true;
        throw error;
      }
    };
    const stopped = () => request.signal?.aborted === true;

    let result: SDKResultMessage | undefined;
    let thrown: { error: unknown } | undefined;
    try {
      for await (const message of query({ prompt: request.prompt, options: sessionAt })) {
        for (const event of reader.read(message)) emit(event);
        if (message.type === 'result') result = message;
        if (stopped()) break;
      }
    } catch (error) {
      thrown = { error };
      sessionAt.abortController.abort();
    }

    const quietly = (event: HarnessEvent) => {
      try {
        emit(event);
      } catch (error) {
        thrown ??= { error };
      }
    };
    for (const event of reader.settle(result)) quietly(event);
    const state = reader.state();
    const ended = toHarnessResult({
      result,
      reader: state,
      budget: request.budget,
      aborted: stopped(),
      ...(thrown === undefined ? {} : { thrown }),
    });
    const { outcome } = ended.result;
    if (ended.result.outcome === 'error') quietly({ type: 'error:harness', message: ended.result.message });
    const transcript = renderTranscript(said, {
      outcome,
      ...(ended.result.outcome === 'blocked' ? { message: ended.result.reason } : {}),
      costEstimate: ended.costEstimate,
    });
    quietly({
      type: 'harness:session_end',
      ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
      outcome,
      reason: ended.endReason,
      turns: state.turns,
      toolCalls: state.toolCalls,
      denials: state.denials,
      usage: state.spent,
    });
    return { ...ended.result, transcript };
  }

  return {
    name: 'claude-code',
    async run(request) {
      if (request.signal?.aborted) {
        return {
          outcome: 'error',
          message: 'aborted',
          reason: 'harness',
          sessionId: '',
          usage: { costUsd: 0 },
          transcript: '',
          raw: null,
        };
      }
      const reader = createSessionReader({
        adapter: 'claude-code',
        model: request.model,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      const sessionAt = sessionOptions(request, options.env, (toolUseId) => reader.markDenied(toolUseId));
      const onAbort = () => sessionAt.abortController.abort();
      request.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        return await session(request, reader, sessionAt);
      } finally {
        request.signal?.removeEventListener('abort', onAbort);
      }
    },
    capabilities: () => ({ ...CAPABILITIES, budgets: [...CAPABILITIES.budgets] }),
  };
}
