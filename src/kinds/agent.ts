// The agent kind: one try of an agent step. It renders the prompt, runs one session on the harness, and checks what
// came back against the step's contract: the output against its schema, and every declared file in `$STAGE_OUT`. A
// corrective try is its call's to start.
//
// The harness is a port, and a repository may bring its own adapter, so nothing it returns or emits is trusted. A
// result that isn't one, a rejection and a throw are all harness errors. Its events are forwarded as they come, apart
// from the session's end: the kind emits that once, when the session is over, with the usage the harness returned.
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { prepareAgentPrompt } from '../engine/agent-prompt';
import { runRelative } from '../engine/call-dir';
import { type ContractError, producesProblems, recordFiles, validateOutput } from '../engine/contract';
import { preamble } from '../engine/preamble';
import type { CallEmit } from '../events/types';
import type { Harness, HarnessEvent, HarnessRequest } from '../ports/harness';
import { HarnessResult, Usage } from '../ports/types';
import type { AgentStep } from '../sdk/steps';
import type { StepContext, StepKind, StepRun } from './index';

const POLICIES = ['retry-once', 'fail'];

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The schema the agent submits against: the output schema's input, as draft-07. Zod throws on what it can't write. */
function submissionSchema(step: AgentStep): { schema: Record<string, unknown> } | { problem: string } {
  try {
    return { schema: z.toJSONSchema(step.output, { target: 'draft-07', io: 'input' }) as Record<string, unknown> };
  } catch (error) {
    return { problem: `output can't be written as JSON Schema for the agent to submit against: ${messageOf(error)}` };
  }
}

function problems(step: AgentStep): string[] {
  const found = [...producesProblems(step.produces)];
  const { maxTurns, maxUsd, maxMinutes } = step.budget;
  if (!(Number.isInteger(maxTurns) && maxTurns >= 1)) {
    found.push(`budget.maxTurns must be a whole number of 1 or more: ${maxTurns}`);
  }
  if (!(Number.isFinite(maxUsd) && maxUsd >= 0)) found.push(`budget.maxUsd must be a number of 0 or more: ${maxUsd}`);
  if (!(Number.isFinite(maxMinutes) && maxMinutes > 0)) {
    found.push(`budget.maxMinutes must be a positive number: ${maxMinutes}`);
  }
  if (step.onInvalidOutput !== undefined && !POLICIES.includes(step.onInvalidOutput)) {
    found.push(`onInvalidOutput must be 'retry-once' or 'fail': ${String(step.onInvalidOutput)}`);
  }
  const submission = submissionSchema(step);
  if ('problem' in submission) found.push(submission.problem);
  return found;
}

/** Why `value` can't be written as JSON and read back the same, or undefined when it can. */
function unwritable(value: unknown, at = 'the output', seen = new Set<object>()): string | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? undefined : `${at} is ${value}`;
  if (typeof value !== 'object') return `${at} is ${value === undefined ? 'undefined' : `a ${typeof value}`}`;
  if (seen.has(value)) return `${at} holds itself`;
  const plain = Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value));
  if (!plain) return `${at} is not a plain object`;
  // Array.from, not map: a hole in an array is an undefined member, which JSON would write as null.
  const members: [string, unknown][] = Array.isArray(value)
    ? Array.from(value, (item, index) => [`${at}[${index}]`, item])
    : Object.entries(value).map(([key, item]) => [`${at}.${key}`, item]);
  // Only what holds itself is refused: the same object in two places is written twice.
  seen.add(value);
  for (const [where, item] of members) {
    const problem = unwritable(item, where, seen);
    if (problem !== undefined) return problem;
  }
  seen.delete(value);
  return undefined;
}

type Checked = { ok: true; data: unknown } | { ok: false; message: string };

/**
 * Checks what the agent submitted against the step's schema, which holds what a JSON Schema can't say, and that what it
 * parsed to can be written to `result.json`.
 */
function checkOutput(step: AgentStep, submitted: unknown): Checked {
  const checked = validateOutput(step.output, submitted);
  if (!checked.ok) return { ok: false, message: `the output doesn't match its schema:\n${checked.message}` };
  const problem = unwritable(checked.data);
  if (problem !== undefined) return { ok: false, message: `the output can't be written as JSON: ${problem}` };
  return checked;
}

/** What a session's events said of it, for a harness that ends none or returns nothing. */
interface Seen {
  sessionId?: string;
  turns: number;
  toolCalls: number;
  denials: number;
  messages: string[];
  /** The harness reported its own failure. */
  failed: boolean;
  /** The last end the harness emitted, held back. */
  end?: Extract<HarnessEvent, { type: 'harness:session_end' }>;
  /** What the session last said it had spent: the running total of a usage update, or its own end's. */
  spent: Usage | undefined;
}

const tokenCount = z.number().int().nonnegative();

/** The running total a usage update gives, as the port types it. */
const RunningTotal = z.object({
  tokens: z.object({ input: tokenCount, cacheRead: tokenCount, cacheWrite: tokenCount, output: tokenCount }),
  costUsdSoFar: Usage.shape.costUsd,
});

/** What a usage update says its session has spent so far, or undefined when what it says is no usage. */
function spentBy(update: unknown): Usage | undefined {
  const said = RunningTotal.safeParse(update);
  if (!said.success) return undefined;
  const { tokens, costUsdSoFar } = said.data;
  return {
    inputTokens: tokens.input,
    cacheReadTokens: tokens.cacheRead,
    cacheWriteTokens: tokens.cacheWrite,
    outputTokens: tokens.output,
    costUsd: costUsdSoFar,
  };
}

/** Listens to a session: each event goes on to `emit` as it comes, apart from the session's end, which is held back. */
function listen(emit: CallEmit): { seen: Seen; onEvent: (event: HarnessEvent) => void } {
  const seen: Seen = { turns: 0, toolCalls: 0, denials: 0, messages: [], failed: false, spent: undefined };
  const onEvent = (event: HarnessEvent): void => {
    switch (event.type) {
      case 'harness:session_end':
        seen.end = event;
        seen.spent = Usage.safeParse(event.usage).data ?? seen.spent;
        return;
      case 'harness:session_start':
        seen.sessionId = event.sessionId;
        break;
      case 'usage:update':
        seen.turns = Math.max(seen.turns, event.turn);
        seen.spent = spentBy(event) ?? seen.spent;
        break;
      case 'tool:start':
        seen.toolCalls++;
        break;
      case 'permission:denied':
        seen.denials++;
        break;
      case 'agent:message':
        seen.messages.push(event.text);
        break;
      case 'error:harness':
        seen.failed = true;
    }
    emit(event);
  };
  return { seen, onEvent };
}

/** The session facts an answer may hold, whether or not it is a result. */
const Reported = z.object({ sessionId: z.string(), usage: Usage, transcript: z.string() }).partial();

/** What a harness answered, sorted out. */
interface Answer {
  /** What it returned, when that is a result. */
  result?: HarnessResult;
  /** It returned a blocked result, sound but for its reason: the agent's to correct, and no failure of the harness. */
  reasonless: boolean;
  /** Why there is no result: what the harness threw, or what is wrong with what it returned. */
  broken?: string;
  /** The session id, usage and transcript it gave. An answer that gives one the port refuses gives none. */
  reported: z.infer<typeof Reported>;
}

const isBlocked = (answer: unknown): boolean =>
  typeof answer === 'object' && answer !== null && (answer as { outcome?: unknown }).outcome === 'blocked';

/** Runs one session. A harness never rejects, by its contract, and one that does or throws has failed. */
async function ask(harness: Harness, request: HarnessRequest): Promise<Answer> {
  let answer: unknown;
  try {
    answer = await harness.run(request);
  } catch (error) {
    return { reasonless: false, broken: `the harness failed: ${messageOf(error)}`, reported: {} };
  }
  const parsed = HarnessResult.safeParse(answer);
  if (parsed.success) return { result: parsed.data, reasonless: false, reported: parsed.data };
  const reported = Reported.safeParse(answer).data ?? {};
  if (isBlocked(answer) && parsed.error.issues.every((issue) => issue.path[0] === 'reason')) {
    return { reasonless: true, reported };
  }
  return { reasonless: false, broken: `the harness returned no result:\n${z.prettifyError(parsed.error)}`, reported };
}

async function run(step: AgentStep, context: StepContext): Promise<StepRun> {
  const emit: CallEmit = (event) => context.emit?.(event);
  const { agent } = context;
  const key = `${context.stage}#${context.call}`;
  // Its call checks both before anything is written, so either is a bug in sail.
  if (agent === undefined) throw new Error(`${key}: an agent step ran with no harness`);
  const submission = submissionSchema(step);
  if ('problem' in submission) throw new Error(`${key}: ${submission.problem}`);

  const place = { try: context.try, validationTry: agent.validationTry };
  const on = { adapter: agent.harness.name, model: agent.model };
  const sessionLog = join(context.paths.dir, 'session.log');
  const ended = (errors: ContractError[], record: Record<string, unknown>, files: StepRun['files'] = {}): StepRun => ({
    outcome: 'error',
    output: null,
    files,
    errors,
    record,
  });

  const prompt = prepareAgentPrompt({
    sailDir: dirname(context.config),
    file: resolve(context.stageDir, step.prompt),
    bindings: agent.bindings,
    inputs: context.inputs,
    ...(agent.conventions === undefined ? {} : { conventions: agent.conventions }),
    ...(agent.feedback === undefined ? {} : { feedback: agent.feedback }),
  });
  if (!prompt.ok) {
    // No session started, so there is nothing to say of one: an empty transcript, and nothing spent.
    writeFileSync(sessionLog, '');
    return ended([{ reason: 'not_started', message: prompt.message }], {
      ...place,
      validationFailed: false,
      harness: { ...on, turns: 0, toolCalls: 0, denials: 0 },
      usage: { costUsd: 0 },
    });
  }
  const promptPath = join(context.paths.dir, 'prompt.md');
  writeFileSync(promptPath, prompt.text);
  const rendered = {
    path: runRelative(context.runDir, promptPath),
    untrusted: prompt.untrusted,
    fragments: prompt.fragments,
    conventions: prompt.conventions,
  };
  emit({ type: 'prompt:rendered', try: context.try, ...rendered });

  const { seen, onEvent } = listen(emit);
  const { result, reasonless, broken, reported } = await ask(agent.harness, {
    key,
    try: context.try,
    prompt: prompt.text,
    cwd: context.workspace,
    // The preamble alone: what sail's own process inherited, credentials included, is not the session's to read.
    env: Object.fromEntries(preamble(context).map(({ name, value }) => [name, value])),
    model: agent.model,
    permissions: step.permissions,
    budget: step.budget,
    outputSchema: submission.schema,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    onEvent,
  });

  // What the harness returned is the authority on its session, and what its events said stands in where it gave none:
  // a session that reported what it had spent, and then failed to return, still spent it.
  const usage = reported.usage ?? seen.spent ?? { costUsd: 0 };
  const sessionId = reported.sessionId ?? seen.sessionId;
  const counters = {
    turns: seen.end?.turns ?? seen.turns,
    toolCalls: seen.end?.toolCalls ?? seen.toolCalls,
    denials: seen.end?.denials ?? seen.denials,
  };
  const record = {
    ...place,
    prompt: rendered,
    harness: { ...on, ...(sessionId === undefined ? {} : { sessionId }), ...counters },
    usage,
  };
  const transcript = reported.transcript ?? seen.messages.map((text) => `assistant: ${text}`).join('\n');
  writeFileSync(sessionLog, transcript === '' ? '' : `${transcript}\n`);

  const failure = broken ?? (result?.outcome === 'error' ? result.message : undefined);
  if (failure !== undefined && !seen.failed) emit({ type: 'error:harness', message: failure });
  emit({
    type: 'harness:session_end',
    ...(sessionId === undefined ? {} : { sessionId }),
    outcome: result?.outcome ?? (reasonless ? 'blocked' : 'error'),
    ...(seen.end?.reason === undefined ? {} : { reason: seen.end.reason }),
    ...counters,
    usage,
  });

  if (failure !== undefined) {
    const reason = result?.outcome === 'error' ? (result.reason ?? 'harness') : 'harness';
    return ended([{ reason, message: failure }], { ...record, validationFailed: false });
  }
  if (reasonless) {
    const message = 'a blocked agent must give its reason: one with nothing in it was submitted';
    return ended([{ reason: 'invalid_output', message }], { ...record, validationFailed: true });
  }
  if (result?.outcome === 'blocked') {
    return {
      outcome: 'blocked',
      output: null,
      files: {},
      errors: [],
      record: { ...record, validationFailed: false, reason: result.reason },
    };
  }

  // A done session owes its output and every file it declared, and each one it broke is a problem of its own.
  const errors: ContractError[] = [];
  const output = checkOutput(step, result?.outcome === 'done' ? result.output : undefined);
  if (output.ok) emit({ type: 'output:validated' });
  else {
    emit({ type: 'output:invalid', message: output.message });
    errors.push({ reason: 'invalid_output', message: output.message });
  }
  const produced = recordFiles(step.produces, context.paths.dir, context.runDir);
  for (const [name, { path, bytes, sha256 }] of Object.entries(produced.files)) {
    emit({ type: 'file:produced', name, path, bytes, sha256 });
  }
  errors.push(...produced.errors);
  if (errors.length > 0 || !output.ok) return ended(errors, { ...record, validationFailed: true }, produced.files);
  return {
    outcome: 'done',
    output: output.data,
    files: produced.files,
    errors: [],
    record: { ...record, validationFailed: false },
  };
}

export const agentKind: StepKind<AgentStep> = { kind: 'agent', problems, run };
