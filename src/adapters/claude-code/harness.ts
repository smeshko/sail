// The claude-code Harness: one session per run, through the Agent SDK's query(). Each SDK message is mapped to sail's
// events, counted once per message, and turned into the run's result. The session ends exactly once, and `run` never
// rejects: every failure, an abort included, resolves as `error`.
//
// This module is the adapter's composition point, and the SDK is reached through sdk.ts alone. Permissions are not
// enforced here yet: `permissions: false` until phase 7.3 adds the PreToolUse gate. Until then the session's tools
// (Read, Write, Edit, Glob, Grep, Bash) run ungated in the worktree, which is why no workflow names this harness before
// 7.3 and why the live demonstration runs in a scratch copy.
import type { AdapterDefinition } from '../../ports/adapter';
import type { Harness, HarnessEvent, HarnessRequest } from '../../ports/harness';
import type { HarnessCapabilities, HarnessResult } from '../../ports/types';
import { cloudProviderOf, requires } from './auth';
import { type MapState, mapMessage, startMapping } from './messages';
import { sessionOptions } from './options';
import { resultOf } from './result';
import { type Options, type SDKMessage, query as sdkQuery } from './sdk';
import { renderTranscript } from './transcript';
import { createTally, type Tally } from './usage';

/** The SDK's query, as the adapter calls it. Tests inject a scripted one, so no test starts a process. */
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export interface ClaudeCodeOptions {
  readonly query?: QueryFn;
  /** The environment the session is started from. Defaults to the process environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The clock durations are measured on. */
  readonly now?: () => number;
}

/** The Agent SDK version this adapter is built on. package.json pins the same version exactly. */
const SDK_VERSION = '0.3.282';

const CAPABILITIES: HarnessCapabilities = {
  structuredOutput: true,
  permissions: false,
  usage: true,
  abort: true,
  budgets: ['turns', 'usd'],
};

interface Deps {
  readonly query: QueryFn;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => number;
}

/** What one session has seen so far, and the events it has emitted. */
interface Session {
  readonly request: HarnessRequest;
  readonly events: HarnessEvent[];
  readonly state: MapState;
  readonly tally: Tally;
  readonly deps: Deps;
  sessionId: string;
  turns: number;
  toolCalls: number;
}

/** Emits an event: it is kept for the transcript, then handed to the caller, whose throw propagates. */
function emit(session: Session, event: HarnessEvent): void {
  session.events.push(event);
  session.request.onEvent?.(event);
}

/** A session's transcript so far. */
function transcriptOf(session: Session): string {
  const provider = cloudProviderOf(session.deps.env);
  return renderTranscript(session.events, provider === undefined ? {} : { provider });
}

/** An error result for the session as it stands: what it spent, and the transcript it has. */
function failure(session: Session, message: string, reason: 'harness' | 'budget_exceeded' = 'harness'): HarnessResult {
  return {
    outcome: 'error',
    message,
    reason,
    sessionId: session.sessionId,
    usage: session.tally.usage(),
    transcript: transcriptOf(session),
    raw: null,
  };
}

/** Takes one SDK message: its events, its usage, and, for a result, the run's result. */
function accept(session: Session, message: SDKMessage): HarnessResult | undefined {
  for (const event of mapMessage(message, session.state)) {
    if (event.type === 'tool:start') session.toolCalls++;
    emit(session, event);
  }
  if (message.type === 'system' || message.type === 'result') session.sessionId = message.session_id;
  if (message.type === 'assistant') {
    const update = session.tally.onAssistant(message);
    if (update !== undefined) {
      session.turns++;
      emit(session, update);
    }
    return undefined;
  }
  if (message.type !== 'result') return undefined;
  const final = session.tally.onResult(message);
  // A failed session's cost still counts in its session end, but it gives no final usage update: its end is the error.
  if (message.subtype === 'success' && final !== undefined) emit(session, final);
  return resultOf(message, {
    sessionId: message.session_id,
    usage: session.tally.usage(),
    transcript: transcriptOf(session),
  });
}

/** Plays the session's messages until one ends it, the stream runs out, or the request aborts. */
async function drive(session: Session, options: Options): Promise<HarnessResult> {
  for await (const message of session.deps.query({ prompt: session.request.prompt, options })) {
    const result = accept(session, message);
    if (result !== undefined) return result;
    if (session.request.signal?.aborted === true) return failure(session, 'aborted');
  }
  return failure(session, 'the session ended without a result message');
}

/** Why a session ended, in the harness's own words. */
function reasonOf(result: HarnessResult): string {
  switch (result.outcome) {
    case 'done':
      return 'submitted';
    case 'blocked':
      return 'blocked';
    case 'error':
      return result.message === 'aborted' ? 'aborted' : (result.reason ?? 'failed');
  }
}

/**
 * Ends the session once. An error gets its `error:harness` first, unless nothing started (`reportError` is false). An
 * onEvent that throws hears no more, so its throws are swallowed and the result stands.
 */
function conclude(session: Session, result: HarnessResult, reportError: boolean): HarnessResult {
  const quietly = (event: HarnessEvent) => {
    try {
      emit(session, event);
    } catch {
      // An onEvent that throws hears no more.
    }
  };
  if (reportError && result.outcome === 'error') quietly({ type: 'error:harness', message: result.message });
  quietly({
    type: 'harness:session_end',
    ...(session.sessionId === '' ? {} : { sessionId: session.sessionId }),
    outcome: result.outcome,
    reason: reasonOf(result),
    turns: session.turns,
    toolCalls: session.toolCalls,
    denials: 0,
    usage: result.usage,
  });
  return result;
}

/** Runs one session for `request`. It never rejects. */
async function runSession(request: HarnessRequest, deps: Deps): Promise<HarnessResult> {
  const session: Session = {
    request,
    events: [],
    state: startMapping(request.key, request.model, deps.now),
    tally: createTally(request.key),
    deps,
    sessionId: '',
    turns: 0,
    toolCalls: 0,
  };
  if (request.signal?.aborted === true) return conclude(session, failure(session, 'aborted'), false);

  const controller = new AbortController();
  const stop = () => controller.abort();
  request.signal?.addEventListener('abort', stop, { once: true });
  try {
    const plan = sessionOptions(request, { env: deps.env, abortController: controller });
    if ('refused' in plan) {
      return conclude(session, failure(session, plan.refused.message, plan.refused.reason), false);
    }
    return conclude(session, await drive(session, plan.options), true);
  } catch (error) {
    // The SDK rejects with its own text when its process is aborted, so an abort is read from the signal (review #1.6).
    const message =
      request.signal?.aborted === true ? 'aborted' : error instanceof Error ? error.message : String(error);
    return conclude(session, failure(session, message), true);
  } finally {
    request.signal?.removeEventListener('abort', stop);
  }
}

/** The claude-code harness. Its session environment is `env`, and its clock is `now`. */
export function createClaudeCodeHarness(options: ClaudeCodeOptions = {}): Harness {
  const deps: Deps = {
    query: options.query ?? sdkQuery,
    env: options.env ?? process.env,
    now: options.now ?? Date.now,
  };
  return {
    name: 'claude-code',
    capabilities: () => CAPABILITIES,
    run: (request) => runSession(request, deps),
  };
}

/** The definition the adapter registry reads. The harness takes no options from `project.yaml`. */
export const claudeCodeAdapters: AdapterDefinition<Harness> = {
  requires,
  versions: () => ({ 'claude-agent-sdk': SDK_VERSION }),
  create(options, context) {
    const unknown = Object.keys(options);
    if (unknown.length > 0) throw new Error(`claude-code harness: option ${unknown.join(', ')} is not known`);
    return createClaudeCodeHarness({ env: context.env });
  },
};
