// The claude-code Harness: one isolated Agent SDK `query()` session per request. The session gets the step's model,
// the workspace, the paths its preamble names (D23), the submission envelope and the turn and dollar budgets, and none
// of the user's own Claude Code settings, skills, memory or MCP servers (D8). Its messages become events as they come,
// every session that started ends once, and every failure, an abort included, is the `error` outcome: run() never
// rejects.
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

/**
 * The text appended to the preset system prompt: where the session works, then how it submits. The session has no
 * shell, so it can't read its environment: a prompt that names `$STAGE_OUT` resolves only through the values given
 * here (D23).
 */
export function appendedSystemPrompt(request: HarnessRequest): string {
  const variables = Object.entries(request.env).map(([name, value]) => `- \`$${name}\`: ${value}`);
  return [
    '## Where you work',
    '',
    `Your working directory is the workspace, ${request.cwd}. You have no shell, so you can't read environment`,
    'variables: where a prompt names one of these, it means the value given.',
    '',
    ...variables,
    '',
    'A file the step produces goes straight into `$STAGE_OUT` under its own name, as `$STAGE_OUT/<name>`, not into a',
    'directory below it.',
    '',
    SUBMIT_CONTRACT,
  ].join('\n');
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
    // The CLI allows some reads and writes of its own (task, plan, scratchpad and memory files) before it asks
    // canUseTool. A whole-tool ask rule is checked ahead of those, so every file tool call reaches the guard.
    settings: { autoMemoryEnabled: false, permissions: { ask: [...FILE_TOOLS] } },
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
    systemPrompt: { type: 'preset', preset: 'claude_code', append: appendedSystemPrompt(request) },
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

/** How far a session got: what it said, whether its onEvent still listens, and whether it started and ended. */
interface Progress {
  readonly said: HarnessEvent[];
  deaf: boolean;
  /** `query()` was called, so the session ends with a `harness:session_end` (D21). */
  started: boolean;
  ended: boolean;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createClaudeCodeHarness(options: ClaudeCodeHarnessOptions): Harness {
  const query = options.query ?? sdkQuery;

  async function session(
    request: HarnessRequest,
    reader: SessionReader,
    sessionAt: Options & { abortController: AbortController },
    progress: Progress,
  ): Promise<HarnessResult> {
    const { said } = progress;
    /** Emits `event`; an onEvent that throws hears no more, and its throw ends the session. */
    const emit = (event: HarnessEvent): void => {
      said.push(event);
      if (progress.deaf) return;
      try {
        request.onEvent?.(event);
      } catch (error) {
        progress.deaf = true;
        throw error;
      }
    };
    const stopped = () => request.signal?.aborted === true;

    let result: SDKResultMessage | undefined;
    let thrown: { error: unknown } | undefined;
    try {
      progress.started = true;
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
    progress.ended = true;
    try {
      emit({
        type: 'harness:session_end',
        ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
        outcome,
        reason: ended.endReason,
        turns: state.turns,
        toolCalls: state.toolCalls,
        denials: state.denials,
        usage: state.spent,
      });
    } catch (error) {
      // An onEvent that throws on the end fails the session as one that throws earlier does, keeping what it spent.
      if (ended.result.outcome === 'error') return { ...ended.result, transcript };
      const message = `claude-code: ${messageOf(error)}`;
      const { sessionId, usage, raw } = ended.result;
      const failed = renderTranscript(said, { outcome: 'error', message, costEstimate: ended.costEstimate });
      return { outcome: 'error', message, reason: 'harness', sessionId, usage, transcript: failed, raw };
    }
    return { ...ended.result, transcript };
  }

  /**
   * The error result of a throw that the session's own handling didn't catch, from building its options or reading its
   * end: a session that started still ends, unless its onEvent won't listen.
   */
  function failedOutright(request: HarnessRequest, reader: SessionReader, progress: Progress, error: unknown) {
    const message = `claude-code: ${messageOf(error)}`;
    const state = reader.state();
    if (progress.started && !progress.ended && !progress.deaf) {
      try {
        request.onEvent?.({ type: 'error:harness', message });
        request.onEvent?.({
          type: 'harness:session_end',
          ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
          outcome: 'error',
          reason: 'failed',
          turns: state.turns,
          toolCalls: state.toolCalls,
          denials: state.denials,
          usage: state.spent,
        });
      } catch {
        // An onEvent that throws hears no more.
      }
    }
    const said = [...progress.said, { type: 'error:harness', message } as const];
    return {
      outcome: 'error',
      message,
      reason: 'harness',
      sessionId: state.sessionId ?? '',
      usage: state.spent,
      transcript: renderTranscript(said, { outcome: 'error', message }),
      raw: null,
    } satisfies HarnessResult;
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
      const progress: Progress = { said: [], deaf: false, started: false, ended: false };
      let onAbort: (() => void) | undefined;
      try {
        const sessionAt = sessionOptions(request, options.env, (toolUseId) => reader.markDenied(toolUseId));
        onAbort = () => sessionAt.abortController.abort();
        request.signal?.addEventListener('abort', onAbort, { once: true });
        return await session(request, reader, sessionAt, progress);
      } catch (error) {
        // A harness never rejects (ADR-0008).
        return failedOutright(request, reader, progress, error);
      } finally {
        if (onAbort !== undefined) request.signal?.removeEventListener('abort', onAbort);
      }
    },
    capabilities: () => ({ ...CAPABILITIES, budgets: [...CAPABILITIES.budgets] }),
  };
}
