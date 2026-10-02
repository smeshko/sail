// The fake Harness: answers scripted per call key and try, keeping no state, so a resume, a parallel call or a new
// process gets the same answer (D2). It writes an answer's files into `$STAGE_OUT`, honours `maxTurns` and an abort,
// and never rejects. It never checks `output` against the schema: invalid output is scripted as a `done` answer whose
// output doesn't conform, which the agent kind rejects.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { Harness, HarnessEvent, HarnessRequest } from '../../ports/harness';
import { type HarnessResult, Usage } from '../../ports/types';

const messages = z.array(z.string()).optional();
const turns = z.number().int().min(1).optional();

/** One scripted answer: what the session submits or ends with, and what it emits on the way. */
const ScriptedAnswer = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('done'),
    output: z.unknown(),
    /** File name → text, written into `$STAGE_OUT`. */
    files: z.record(z.string(), z.string()).optional(),
    messages,
    turns,
    usage: Usage.optional(),
    delayMs: z.number().int().min(0).optional(),
  }),
  z.object({ outcome: z.literal('blocked'), reason: z.string().min(1), messages, turns, usage: Usage.optional() }),
  z.object({ outcome: z.literal('error'), message: z.string().min(1) }),
]);
export type ScriptedAnswer = z.infer<typeof ScriptedAnswer>;

/** A call key (`spec#2`) or a stage key (`spec`, `publish/describe`) → its answers by try. The last one repeats. */
export const HarnessScript = z.record(z.string(), z.array(ScriptedAnswer).min(1));
export type HarnessScript = z.infer<typeof HarnessScript>;

export interface FakeHarnessOptions {
  /** The script, or the path of a JSON file holding it, read on every run. */
  readonly script: string | HarnessScript;
}

/** Waits `ms`, or until `signal` aborts, and leaves no timer or listener behind. True when it aborted. */
async function wait(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  try {
    await sleep(ms, undefined, signal === undefined ? {} : { signal });
    return false;
  } catch {
    return true;
  }
}

/** `spec#1` gives `fake-session-spec-1`, as in the golden run, and a later try adds `-try-<n>`. */
const sessionIdOf = (request: HarnessRequest): string =>
  `fake-session-${request.key.replaceAll(/[#/]/g, '-')}${request.try > 1 ? `-try-${request.try}` : ''}`;

/**
 * What a session scripted to spend `usage` over `wanted` turns has spent after `turn` of them: the golden run's shape,
 * spread evenly, with whole token counts.
 */
function spentBy(usage: Usage, turn: number, wanted: number): Usage {
  const spent: Usage = { costUsd: (usage.costUsd * turn) / wanted };
  for (const key of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'] as const) {
    const count = usage[key];
    if (count !== undefined) spent[key] = Math.round((count * turn) / wanted);
  }
  return spent;
}

/** Where each of `files` lands in `out`, or the first name that would land outside it. */
function placeFiles(out: string, files: Record<string, string>): { paths: [string, string][] } | { outside: string } {
  const paths: [string, string][] = [];
  for (const [name, text] of Object.entries(files)) {
    const path = resolve(out, name);
    const inside = relative(out, path);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return { outside: name };
    paths.push([path, text]);
  }
  return { paths };
}

export function createFakeHarness(options: FakeHarnessOptions): Harness {
  /** The script, read afresh when it is a path, or why it can't be read. */
  const load = (): HarnessScript | string => {
    const { script } = options;
    try {
      return HarnessScript.parse(typeof script === 'string' ? JSON.parse(readFileSync(script, 'utf8')) : script);
    } catch (error) {
      return `fake harness: ${typeof script === 'string' ? `${script}: ` : ''}${(error as Error).message}`;
    }
  };

  async function session(request: HarnessRequest, sessionId: string): Promise<HarnessResult> {
    const fail = (message: string, raw: HarnessResult['raw'] = null, usage: Usage = { costUsd: 0 }): HarnessResult => ({
      outcome: 'error',
      message,
      sessionId,
      usage,
      transcript: '',
      raw,
    });
    if (request.signal?.aborted) return fail('aborted');
    const script = load();
    if (typeof script === 'string') return fail(script);
    const answersFor = (key: string) => (Object.hasOwn(script, key) ? script[key] : undefined);
    const answers = answersFor(request.key) ?? answersFor(request.key.replace(/#\d+/, ''));
    const answer = answers?.[Math.min(request.try, answers.length) - 1];
    if (answer === undefined) return fail(`fake harness: nothing scripted for ${request.key}`);

    const emit = (event: HarnessEvent) => request.onEvent?.(event);
    const end = (result: HarnessResult): HarnessResult => {
      emit({ type: 'harness:session_end', outcome: result.outcome });
      return result;
    };
    /** Fails with what the session has spent so far, so a failure after turns still counts their cost. */
    const failed = (message: string, spent?: Usage): HarnessResult => {
      emit({ type: 'error:harness', message });
      return end(fail(message, answer, spent));
    };

    emit({ type: 'harness:session_start', adapter: 'fake', sessionId, model: request.model });
    if (answer.outcome === 'error') return failed(answer.message);

    for (const text of answer.messages ?? []) emit({ type: 'agent:message', text });
    const usage = answer.usage ?? { costUsd: 0 };
    const wanted = answer.turns ?? 1;
    const { maxTurns } = request.budget;
    for (let turn = 1; turn <= Math.min(wanted, maxTurns); turn++) {
      const soFar = spentBy(usage, turn, wanted);
      emit({
        type: 'usage:update',
        turn,
        tokens: {
          input: soFar.inputTokens ?? 0,
          cacheRead: soFar.cacheReadTokens ?? 0,
          cacheWrite: soFar.cacheWriteTokens ?? 0,
          output: soFar.outputTokens ?? 0,
        },
        costUsdSoFar: soFar.costUsd,
      });
    }
    if (wanted > maxTurns) {
      return failed(`budget exceeded: maxTurns ${maxTurns}`, spentBy(usage, maxTurns, wanted));
    }

    if (answer.outcome === 'done' && answer.delayMs !== undefined && (await wait(answer.delayMs, request.signal))) {
      return failed('aborted', usage);
    }
    if (answer.outcome === 'done' && answer.files !== undefined) {
      const out = request.env.STAGE_OUT;
      if (out === undefined) return failed('fake harness: files need STAGE_OUT', usage);
      const placed = placeFiles(out, answer.files);
      if ('outside' in placed) return failed(`fake harness: ${placed.outside} is outside STAGE_OUT`, usage);
      for (const [path, text] of placed.paths) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
      }
    }

    const transcript = (answer.messages ?? []).map((text) => `assistant: ${text}`).join('\n');
    const kept = { sessionId, usage, transcript, raw: answer };
    return end(
      answer.outcome === 'done'
        ? { outcome: 'done', output: answer.output, ...kept }
        : { outcome: 'blocked', reason: answer.reason, ...kept },
    );
  }

  return {
    name: 'fake',
    async run(request) {
      const sessionId = sessionIdOf(request);
      try {
        return await session(request, sessionId);
      } catch (error) {
        // A harness never rejects (ADR-0008): a file that can't be written, or an onEvent that throws, is an error.
        const message = `fake harness: ${(error as Error).message}`;
        return { outcome: 'error', message, sessionId, usage: { costUsd: 0 }, transcript: '', raw: null };
      }
    },
    capabilities: () => ({ structuredOutput: true, permissions: false, usage: true, abort: true, budgets: ['turns'] }),
  };
}
