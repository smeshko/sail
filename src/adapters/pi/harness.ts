// The pi Harness: one isolated in-process pi coding-agent session per request, under the contract claude-code keeps.
// Every tool call passes sail's gate (decide()); the session is offered only the tools its step can use and a `submit`
// tool that checks the output against the step's schema; the turn and dollar budgets are watched here, as pi has none,
// and a breach aborts the session. The dollar budget can overshoot by one message, as pi reports cost per message. Each
// pi event also goes to the request's onRaw, for a recording. Every shell a command starts leads a process group of its
// own, gone before run() returns. Every failure, an abort included, is the `error` outcome: run() never rejects.
import type { Env } from '../../ports/adapter';
import type { Harness, HarnessEvent, HarnessRequest } from '../../ports/harness';
import type { HarnessCapabilities, HarnessResult } from '../../ports/types';
import { type BudgetTimers, createBudgetWatch } from '../claude-code/budget';
import { whereYouWork } from '../claude-code/harness';
import { renderTranscript } from '../claude-code/transcript';
import { CODEX_PROVIDER, codexAccessToken, keychainCodexLogin } from './codex-login';
import { createGate, gateExtension } from './gate';
import { createPiSessionReader, type PiEvent, type PiSessionReader } from './messages';
import { bashEnv, createBashRunner } from './process';
import { toHarnessResult } from './result';
import { createPiSession, type PiSession, type PiSessionFactory } from './session';
import { SUBMIT_CONTRACT, type Submitted, submitTool } from './submission';
import { sessionTools } from './tool-call';

export interface PiHarnessOptions {
  /** The adapter context's environment, which the provider's credential and a command's environment are picked from. */
  readonly env: Env;
  readonly createSession?: PiSessionFactory;
  /** Milliseconds, for tool durations and the minutes a session has used. */
  readonly now?: () => number;
  /** The timers the minute budget runs on: the system's when left out. */
  readonly timers?: BudgetTimers;
  /** The Codex login's access token, for an `openai-codex` model: the keychain's login when left out. */
  readonly codexToken?: () => Promise<string>;
}

const SYSTEM_TIMERS: BudgetTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

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
  /** The session was created, so it ends with a `harness:session_end`. */
  started: boolean;
  ended: boolean;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Hands `event` to the request's onRaw, if it has one: a recorder's trouble never changes the session. */
function tap(request: HarnessRequest, event: PiEvent): void {
  try {
    request.onRaw?.(event);
  } catch {
    // A recording that fails is not a reason to fail the session.
  }
}

export function createPiHarness(options: PiHarnessOptions): Harness {
  const createSession = options.createSession ?? createPiSession;
  const codexToken = options.codexToken ?? (() => codexAccessToken(keychainCodexLogin(options.env)));
  const now = () => options.now?.() ?? Date.now();

  async function converse(
    request: HarnessRequest,
    session: PiSession,
    reader: PiSessionReader,
    progress: Progress,
    submitted: () => Submitted | undefined,
  ): Promise<HarnessResult> {
    const { said } = progress;
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

    let thrown: { error: unknown } | undefined;
    let over: 'turns' | 'usd' | 'minutes' | undefined;
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      session.abort().catch(() => undefined);
    };
    const quietly = (event: HarnessEvent) => {
      try {
        emit(event);
      } catch (error) {
        thrown ??= { error };
        stop();
      }
    };
    const watch = createBudgetWatch({
      budget: request.budget,
      timers: options.timers ?? SYSTEM_TIMERS,
      now,
      emit: quietly,
      onOverMinutes: () => {
        if (submitted() === undefined) over ??= 'minutes';
        stop();
      },
    });
    const unsubscribe = session.subscribe((event) => {
      tap(request, event);
      for (const found of reader.read(event)) quietly(found);
      const { turns, spent } = reader.state();
      if (event.type === 'turn_end') watch.turn(turns);
      if (over === undefined && submitted() === undefined) {
        if (event.type === 'message_end' && spent.costUsd !== undefined && spent.costUsd >= request.budget.maxUsd) {
          over = 'usd';
        } else if (event.type === 'turn_end' && turns >= request.budget.maxTurns) {
          over = 'turns';
        }
      }
      // A kept submission ends the session with its turn: pi goes on while another call in its batch didn't end it.
      const kept = event.type === 'turn_end' && submitted() !== undefined;
      if (over !== undefined || stopped() || kept) stop();
    });
    try {
      watch.start();
      if (!stopped()) await session.prompt(request.prompt);
    } catch (error) {
      thrown ??= { error };
    } finally {
      watch.stop();
      unsubscribe();
    }

    for (const event of reader.settle()) quietly(event);
    const state = reader.state();
    // Budget events go out before the error and the end.
    watch.turn(state.turns);
    watch.settle({ usd: state.spent.costUsd ?? 0, turns: state.turns, over: over === 'minutes' ? undefined : over });
    const submission = submitted();
    const ended = toHarnessResult({
      reader: state,
      ...(submission === undefined ? { submission: undefined } : { submission }),
      budget: request.budget,
      aborted: stopped(),
      ...(over === undefined ? {} : { over }),
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
      const message = `pi: ${messageOf(error)}`;
      const { sessionId, usage, raw } = ended.result;
      const failed = renderTranscript(said, { outcome: 'error', message, costEstimate: ended.costEstimate });
      return { outcome: 'error', message, reason: 'harness', sessionId, usage, transcript: failed, raw };
    }
    return { ...ended.result, transcript };
  }

  /** The error result of a throw the session's own handling didn't catch: a session that started still ends. */
  function failedOutright(
    request: HarnessRequest,
    reader: PiSessionReader | undefined,
    progress: Progress,
    error: unknown,
  ) {
    const message = `pi: ${messageOf(error)}`;
    const state = reader?.state();
    const usage = state?.spent ?? { costUsd: 0 };
    if (progress.started && !progress.ended && !progress.deaf && state !== undefined) {
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
          usage,
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
      sessionId: state?.sessionId ?? '',
      usage,
      transcript: renderTranscript(said, { outcome: 'error', message }),
      raw: null,
    } satisfies HarnessResult;
  }

  return {
    name: 'pi',
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
      const progress: Progress = { said: [], deaf: false, started: false, ended: false };
      let reader: PiSessionReader | undefined;
      let session: PiSession | undefined;
      let onAbort: (() => void) | undefined;
      // Each command's shell leads a group of its own, gone before run() returns.
      const runner = createBashRunner({ env: bashEnv(request.env, options.env) });
      try {
        let submission: Submitted | undefined;
        const tools = sessionTools(request.permissions);
        const gate = createGate({
          permissions: request.permissions,
          // An empty root makes decide() deny, never allow.
          ctx: {
            worktree: request.cwd,
            stageOut: request.env.STAGE_OUT ?? '',
            stageIn: request.env.STAGE_IN ?? '',
            env: request.env,
          },
          onDenied: (toolCallId, denial) => reader?.markDenied(toolCallId, denial),
        });
        const codex = request.model.startsWith(`${CODEX_PROVIDER}/`);
        const apiKey = codex ? await codexToken() : undefined;
        session = await createSession({
          cwd: request.cwd,
          model: request.model,
          systemPrompt: [whereYouWork(request, tools.includes('bash')), '', SUBMIT_CONTRACT].join('\n'),
          tools,
          gate: gateExtension(gate),
          submit: submitTool(request.outputSchema, (found) => {
            submission ??= found;
          }),
          bash: runner.operations,
          env: options.env,
          ...(apiKey === undefined ? {} : { apiKey }),
        });
        const live = session;
        reader = createPiSessionReader({
          model: request.model,
          sessionId: live.sessionId === '' ? crypto.randomUUID() : live.sessionId,
          ...(options.now === undefined ? {} : { now: options.now }),
        });
        progress.started = true;
        onAbort = () => {
          live.abort().catch(() => undefined);
        };
        request.signal?.addEventListener('abort', onAbort, { once: true });
        return await converse(request, live, reader, progress, () => submission);
      } catch (error) {
        // A harness never rejects (ADR-0008).
        return failedOutright(request, reader, progress, error);
      } finally {
        if (onAbort !== undefined) request.signal?.removeEventListener('abort', onAbort);
        try {
          await runner.reap();
        } finally {
          await session?.dispose().catch(() => undefined);
        }
      }
    },
    capabilities: () => ({ ...CAPABILITIES, budgets: [...CAPABILITIES.budgets] }),
  };
}
