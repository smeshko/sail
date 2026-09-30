// The fake Harness: answers scripted per call key and try, keeping no state, so a resume, a parallel call or a new
// process gets the same answer (D2). It writes an answer's files into `$STAGE_OUT`, honours `maxTurns` and an abort,
// and never rejects.
// STUB (TASK-006): every run ends `done` with nothing in it, and emits nothing. TASK-006 writes the fake.
import { z } from 'zod';
import type { Harness } from '../../ports/harness';
import type { Usage } from '../../ports/types';

/** One scripted answer: what the session submits or ends with, and what it emits on the way. */
export type ScriptedAnswer =
  | {
      outcome: 'done';
      output: unknown;
      /** File name → text, written into `$STAGE_OUT`. */
      files?: Record<string, string>;
      messages?: string[];
      turns?: number;
      usage?: Usage;
      delayMs?: number;
    }
  | { outcome: 'blocked'; reason: string; messages?: string[]; turns?: number; usage?: Usage }
  | { outcome: 'error'; message: string };

/** A call key (`spec#2`) or a stage key (`spec`, `publish/describe`) → its answers by try. The last one repeats. */
export const HarnessScript = z.never() as unknown as z.ZodType<Record<string, ScriptedAnswer[]>>;
export type HarnessScript = z.infer<typeof HarnessScript>;

export interface FakeHarnessOptions {
  /** The script, or the path of a JSON file holding it, read on every run. */
  readonly script: string | HarnessScript;
}

export function createFakeHarness(_options: FakeHarnessOptions): Harness {
  return {
    name: 'fake',
    run: async () => ({
      outcome: 'done',
      output: null,
      sessionId: '',
      usage: { costUsd: 0 },
      transcript: '',
      raw: null,
    }),
    capabilities: () => ({ structuredOutput: false, permissions: false, usage: false, abort: false, budgets: [] }),
  };
}
