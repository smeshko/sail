// The claude-code Harness: one isolated Agent SDK `query()` session per request. The session gets the step's model,
// the workspace, the paths its preamble names (D23), the submission envelope and the turn and dollar budgets, and none
// of the user's own Claude Code settings, skills, memory or MCP servers (D8). Its messages become events as they come,
// every session that started ends once, and every failure, an abort included, is the `error` outcome: run() never
// rejects.
//
// Every tool call passes the gate first (7.3 D1): its PreToolUse hook asks the permission engine, and canUseTool denies
// whatever still reaches it. The session is offered only the tools its step can use (D2). The CLI scrubs the provider's
// credentials from the Bash tool's environment (D3), returns that tool to the workspace after each command (D4), and
// runs it under bash, the shell decide() reads. Each SDK message also goes to the request's onRaw as it comes, for a recording (11.3 D3). The Claude Code process leads a process group of its own, and run() returns only once that group is gone (D7). A session sail cuts short, by its minutes or an aborted request, is interrupted first so the SDK's result records its cost, and aborted after INTERRUPT_GRACE_MS without one.
import type { Options, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { allowlisted } from '../../engine/env-allowlist';
import type { Env } from '../../ports/adapter';
import type { Harness, HarnessEvent, HarnessRequest } from '../../ports/harness';
import type { HarnessCapabilities, HarnessResult } from '../../ports/types';
import { type BudgetTimers, createBudgetWatch } from './budget';
import { createGate } from './gate';
import { createSessionReader, type SessionReader } from './messages';
import { createSpawner } from './process';
import { toHarnessResult } from './result';
import { SUBMIT_CONTRACT, submissionEnvelope } from './submission';
import { type Denial, sessionTools } from './tool-call';
import { renderTranscript } from './transcript';

/** What the harness calls to start a session: the SDK's `query()`, or a test's stand-in. */
export type QueryFunction = (params: {
  prompt: string;
  options: Options;
}) => AsyncIterable<SDKMessage> & { interrupt?: () => Promise<unknown> };

/** How long a cut session is given to send its result before its controller is aborted. */
export const INTERRUPT_GRACE_MS = 10_000;

export interface ClaudeCodeHarnessOptions {
  /** The adapter context's environment, which the session's is picked from. */
  readonly env: Env;
  readonly query?: QueryFunction;
  /** Milliseconds, for tool durations and the minutes a session has used. */
  readonly now?: () => number;
  /** The timers the minute budget runs on: the system's when left out (D14). */
  readonly timers?: BudgetTimers;
}

/** Hands `message` to the request's onRaw, if it has one: a recorder's trouble never changes the session. */
function tap(request: HarnessRequest, message: SDKMessage): void {
  try {
    request.onRaw?.(message);
  } catch {
    // A recording that fails is not a reason to fail the session.
  }
}

const SYSTEM_TIMERS: BudgetTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The switches every session runs with, which nothing else in its environment overrides. The CLI runs the Bash tool
 * under zsh when it finds one, but decide() reads commands as bash, and the two differ (zsh's `>!` writes its next
 * word), so the shell is bash. Background tasks are off, as a background command is denied anyway (D8).
 */
const SWITCHES: Readonly<Record<string, string>> = {
  CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
  CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1',
  CLAUDE_CODE_SHELL: '/bin/bash',
  SHELL: '/bin/bash',
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
};

/** The session's environment: the allowlisted names of `env`, the preamble, which wins a clash, then the switches. */
export function sessionEnv(preamble: Readonly<Record<string, string>>, env: Env): Record<string, string> {
  const picked = Object.entries(env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && allowlisted(entry[0]),
  );
  return {
    ...Object.fromEntries(picked),
    CLAUDE_AGENT_SDK_CLIENT_APP: 'sail',
    ...preamble,
    ...SWITCHES,
  };
}

/**
 * The text appended to the preset system prompt: where the session works, then how it submits. A session without a
 * shell can't read its environment: a prompt that names `$STAGE_OUT` resolves only through the values given here (D23).
 * A session with one has them in its environment too (D16).
 */
export function appendedSystemPrompt(request: HarnessRequest): string {
  return [whereYouWork(request, sessionTools(request.permissions).tools.includes('Bash')), '', SUBMIT_CONTRACT].join(
    '\n',
  );
}

/** Where the session works, the same text for any harness: `hasShell` is whether the session is offered a shell. */
export function whereYouWork(request: HarnessRequest, hasShell: boolean): string {
  const variables = Object.entries(request.env).map(([name, value]) => `- \`$${name}\`: ${value}`);
  const shell = hasShell
    ? [
        `Your working directory is the workspace, ${request.cwd}. Where a prompt names one of these environment`,
        'variables, it means the value given: the same values are in your environment.',
      ]
    : [
        `Your working directory is the workspace, ${request.cwd}. You have no shell, so you can't read environment`,
        'variables: where a prompt names one of these, it means the value given.',
      ];
  return [
    '## Where you work',
    '',
    ...shell,
    '',
    ...variables,
    '',
    'A file the step produces goes straight into `$STAGE_OUT` under its own name, as `$STAGE_OUT/<name>`, not into a',
    'directory below it.',
  ].join('\n');
}

/** The SDK options of `request`'s session, with a controller of its own and the gate. */
export function sessionOptions(
  request: HarnessRequest,
  env: Env,
  onDenied?: (toolUseId: string, denial: Denial) => void,
): Options & { abortController: AbortController } {
  const stageDirs = [request.env.STAGE_IN, request.env.STAGE_OUT].filter(
    (dir): dir is string => dir !== undefined && dir !== '',
  );
  const gate = createGate({
    permissions: request.permissions,
    // An empty root makes decide() deny, never allow (7.1 D4).
    ctx: {
      worktree: request.cwd,
      stageOut: request.env.STAGE_OUT ?? '',
      stageIn: request.env.STAGE_IN ?? '',
      env: request.env,
    },
    ...(onDenied === undefined ? {} : { onDenied }),
  });
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
    // Adaptive is the default; summarized display makes a thinking block carry its text, which the dashboard's timeline
    // shows, where the default omits it.
    thinking: { type: 'adaptive', display: 'summarized' },
    ...sessionTools(request.permissions),
    permissionMode: 'default',
    hooks: { PreToolUse: [{ hooks: [gate.preToolUse] }] },
    canUseTool: gate.canUseTool,
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
  budgets: ['turns', 'usd', 'minutes'],
};

/** How far a session got: what it said, whether its onEvent still listens, and whether it started and ended. */
interface Progress {
  readonly said: HarnessEvent[];
  deaf: boolean;
  /** `query()` was called, so the session ends with a `harness:session_end` (D21). */
  started: boolean;
  ended: boolean;
  /** Cuts the running session short: set by session(), so a request's abort goes through its interrupt first. */
  cut?: () => void;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createClaudeCodeHarness(options: ClaudeCodeHarnessOptions): Harness {
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
    const abort = () => {
      waitingForResult = false;
      sessionAt.abortController.abort();
    };

    let result: SDKResultMessage | undefined;
    let thrown: { error: unknown } | undefined;
    let overMinutes = false;
    let running: ReturnType<QueryFunction> | undefined;
    let cutDone = false;
    // Set while a cut session is given INTERRUPT_GRACE_MS to send its result.
    let waitingForResult = false;
    let grace: unknown;
    const timers = options.timers ?? SYSTEM_TIMERS;
    // A session sail cuts is interrupted first, so the SDK sends the result that holds its exact cost; the controller
    // aborts when that doesn't come in time, or at once when the query can't be interrupted.
    const cut = () => {
      if (cutDone) return;
      cutDone = true;
      const interrupt = running?.interrupt?.bind(running);
      if (interrupt === undefined) {
        abort();
        return;
      }
      waitingForResult = true;
      grace = timers.set(abort, INTERRUPT_GRACE_MS);
      try {
        interrupt().catch(abort);
      } catch {
        abort();
      }
    };
    progress.cut = cut;
    const quietly = (event: HarnessEvent) => {
      try {
        emit(event);
      } catch (error) {
        thrown ??= { error };
      }
    };
    const watch = createBudgetWatch({
      budget: request.budget,
      timers,
      now: () => options.now?.() ?? Date.now(),
      emit: quietly,
      onOverMinutes: () => {
        overMinutes = true;
        cut();
      },
    });
    try {
      progress.started = true;
      watch.start();
      // The SDK is imported by the first session, not with the CLI: it is most of what a sail process would load at
      // start, and only an agent step needs it.
      const query = options.query ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
      running = query({ prompt: request.prompt, options: sessionAt });
      for await (const message of running) {
        tap(request, message);
        for (const event of reader.read(message)) emit(event);
        watch.turn(reader.state().turns);
        if (message.type === 'result') result = message;
        if (waitingForResult ? result !== undefined : stopped()) break;
      }
    } catch (error) {
      // After an error result the SDK throws, restating it as "Claude Code returned an error result: …". The result,
      // already read, says more: a budget's name, its subtype. A throw from onEvent fails the session all the same.
      if (result?.is_error !== true || progress.deaf) thrown = { error };
      sessionAt.abortController.abort();
    } finally {
      // The loop is over, so an abort from here on has nothing to cut.
      cutDone = true;
      watch.stop();
      if (grace !== undefined) timers.clear(grace);
    }

    for (const event of reader.settle(result)) quietly(event);
    const state = reader.state();
    // Budget events go out before the error and the end (D12).
    watch.turn(state.turns);
    if (result !== undefined) {
      const over =
        result.subtype === 'error_max_turns' ? 'turns' : result.subtype === 'error_max_budget_usd' ? 'usd' : undefined;
      watch.settle({ usd: result.total_cost_usd, turns: result.num_turns, over });
    }
    const ended = toHarnessResult({
      result,
      reader: state,
      budget: request.budget,
      aborted: stopped(),
      overMinutes,
      ...(options.now === undefined ? {} : { now: new Date(options.now()) }),
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
      // Each session's process leads a group of its own, gone before run() returns (D7).
      const spawner = createSpawner();
      try {
        const sessionAt = {
          ...sessionOptions(request, options.env, (toolUseId, denial) => reader.markDenied(toolUseId, denial)),
          spawnClaudeCodeProcess: spawner.spawn,
        };
        onAbort = () => (progress.cut ?? (() => sessionAt.abortController.abort()))();
        request.signal?.addEventListener('abort', onAbort, { once: true });
        return await session(request, reader, sessionAt, progress);
      } catch (error) {
        // A harness never rejects (ADR-0008).
        return failedOutright(request, reader, progress, error);
      } finally {
        if (onAbort !== undefined) request.signal?.removeEventListener('abort', onAbort);
        await spawner.reap();
      }
    },
    capabilities: () => ({ ...CAPABILITIES, budgets: [...CAPABILITIES.budgets] }),
  };
}
