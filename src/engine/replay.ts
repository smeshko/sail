// One replay: the workflow function run once from the top against the journal's entries (ADR-0001). Each journaled
// `run.stage()` returns its recorded result, and the replay ends at the first of these:
//   - the first call the journal doesn't hold, which the runtime then runs and journals before the next replay
//   - the workflow returning, or `run.fail()`
//   - an `error` the call didn't ask for, a replay that diverges from the journal, or a call that can't start
//
// Ending never relies on the workflow letting an exception through. The end is recorded first, and the first end
// recorded wins. Then the pending `run.stage()` returns a promise that never settles, so the code after its `await`,
// its `catch` and its `finally` never run, and a workflow's `try/catch` can't swallow the halt. `run.fail()` throws
// only after its end is recorded, so catching it changes nothing.
//
// Replay goes by position: request n must be journal entry n. That is how a request finds its result, and it catches a
// workflow whose calls changed between replays, which a lookup by key would silently accept.
import { join } from 'node:path';
import type { ProducedFile } from '../sdk/bindings';
import type { StageDefinition } from '../sdk/steps';
import type { CallOptions, Run, Workflow } from '../sdk/workflow';
import type { Supplied } from './bindings';
import type { JournalEntry } from './journal';
import type { ReachedStage } from './load-workflow';
import type { StopReason } from './run-dir';

/** The first call the journal doesn't hold, ready to run. */
export interface PendingCall {
  /** `<stage>#<call>`. */
  key: string;
  stage: string;
  call: number;
  /** The stage directory's number: 1 plus the distinct stages requested before it. `00` is the intake's. */
  stageIndex: number;
  definition: StageDefinition;
  stageFile: string;
  supplied: Record<string, Supplied>;
}

export type ReplayEnd =
  | { kind: 'call'; call: PendingCall }
  | { kind: 'completed'; result: unknown }
  | {
      kind: 'failed';
      stopReason: Extract<StopReason, 'workflow_failed' | 'stage_error' | 'determinism_violation'>;
      message: string;
    };

export interface ReplayOptions {
  workflow: Workflow;
  /** The roster: `run.stage()` matches a definition to its stage by identity. */
  stages: readonly ReachedStage[];
  entries: readonly JournalEntry[];
  /** The absolute run directory, which a journaled file's path is relative to. */
  runDir: string;
  /** `run.input`. */
  input: unknown;
}

/**
 * What `run.fail()` throws once its end is recorded. Never exported, so only a replay's own promise sees it. The
 * constructor is written out because Bun's coverage counts an implicit one as a function that never ran.
 */
class Halt extends Error {
  constructor() {
    super('the replay has ended');
  }
}

/** A replay's end, or a bug in sail that makes `replay()` reject. */
type Recorded = ReplayEnd | { kind: 'crashed'; error: unknown };

const never = <T>(): Promise<T> => new Promise<T>(() => {});

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const isObject = (value: unknown): value is object =>
  (typeof value === 'object' && value !== null) || typeof value === 'function';

/**
 * Runs the workflow once against `entries`, and resolves with how the replay ended as soon as the end is recorded. The
 * workflow's own promise may never settle. An exception inside sail's `run` methods rejects instead.
 */
export function replay(options: ReplayOptions): Promise<ReplayEnd> {
  const { workflow, stages, entries, runDir, input } = options;
  return new Promise<ReplayEnd>((resolve, reject) => {
    let ended = false;
    /** The next journal entry a request must match. */
    let position = 0;
    const calls = new Map<string, number>();
    const stageIndexes = new Map<string, number>();
    /** Each file handed to the workflow, to its run-relative path. */
    const files = new WeakMap<object, string>();
    /** Each output handed to the workflow, to its JSON pointer. */
    const pointers = new WeakMap<object, string>();

    function record(end: Recorded): void {
      if (ended) return;
      ended = true;
      const next = entries[position];
      if (end.kind === 'crashed') reject(end.error);
      else if (
        next === undefined ||
        end.kind === 'call' ||
        (end.kind === 'failed' && end.stopReason === 'determinism_violation')
      ) {
        resolve(end);
      } else {
        const message = `the workflow ended where the journal has '${next.key}'`;
        resolve({ kind: 'failed', stopReason: 'determinism_violation', message });
      }
    }

    const failRun = (stopReason: 'workflow_failed' | 'stage_error' | 'determinism_violation', message: string) =>
      record({ kind: 'failed', stopReason, message });

    /** Where a value came from, as `consumed` records it. `WeakMap#get` gives undefined for a primitive. */
    const from = (value: unknown) => (value === input ? '--input' : (pointers.get(value as object) ?? 'workflow'));

    /** A journaled call's result, as the workflow reads it. */
    function rebuild(entry: JournalEntry, key: string, callOptions: CallOptions | undefined): Promise<unknown> {
      switch (entry.outcome) {
        case 'blocked':
          return Promise.resolve({ outcome: 'blocked', reason: entry.reason ?? '' });
        case 'error':
          if (callOptions?.onError === 'return') {
            return Promise.resolve({ outcome: 'error', reason: entry.reason ?? '' });
          }
          failRun('stage_error', `${key} ended in error: ${entry.reason ?? ''}`);
          return never();
        default: {
          const produced = new Map<string, ProducedFile>();
          for (const [name, path] of Object.entries(entry.files)) {
            const handle = Object.freeze({ name }) as ProducedFile;
            files.set(handle, path);
            produced.set(name, handle);
          }
          if (isObject(entry.output)) pointers.set(entry.output, `${entry.resultPath}#/output`);
          return Promise.resolve({ outcome: entry.outcome, output: entry.output, files: Object.fromEntries(produced) });
        }
      }
    }

    /** What the workflow supplied, as `runCall()` takes it, or every problem with it. */
    function resolveBindings(
      definition: StageDefinition,
      bindings: unknown,
    ): { supplied: Record<string, Supplied> } | { problems: string[] } {
      if (!isObject(bindings)) return { problems: ['its bindings must be an object'] };
      // A Map, not assignment: `supplied['__proto__'] = …` would set the prototype, and the binding would go unchecked.
      const supplied = new Map<string, Supplied>();
      const problems: string[] = [];
      for (const [key, value] of Object.entries(bindings)) {
        if (value === undefined) continue;
        const declared = Object.hasOwn(definition.consumes, key) ? definition.consumes[key] : undefined;
        if (declared?.kind !== 'file') {
          supplied.set(key, { kind: 'value', value, from: from(value) });
          continue;
        }
        const path = isObject(value) ? files.get(value) : undefined;
        if (path === undefined) problems.push(`'${key}' needs a file a call produced`);
        else supplied.set(key, { kind: 'file', path: join(runDir, path), from: path });
      }
      return problems.length > 0 ? { problems } : { supplied: Object.fromEntries(supplied) };
    }

    function request(definition: StageDefinition, bindings: unknown, callOptions?: CallOptions): Promise<unknown> {
      if (ended) return never();
      if (!isObject(definition) || typeof definition.name !== 'string') {
        failRun('workflow_failed', `run.stage() was given ${String(definition)}, not a stage`);
        return never();
      }
      const stage = definition.name;
      const call = (calls.get(stage) ?? 0) + 1;
      calls.set(stage, call);
      if (!stageIndexes.has(stage)) stageIndexes.set(stage, stageIndexes.size + 1);
      const stageIndex = stageIndexes.get(stage) ?? 0;
      const key = `${stage}#${call}`;

      const journaled = entries[position];
      if (journaled !== undefined) {
        if (journaled.key !== key) {
          failRun('determinism_violation', `the workflow asked for '${key}' where the journal has '${journaled.key}'`);
          return never();
        }
        position++;
        return rebuild(journaled, key, callOptions);
      }

      const reached = stages.find((each) => each.definition === definition);
      if (reached === undefined) {
        failRun('workflow_failed', `${key} can't run: '${stage}' isn't a stage the workflow's roster holds`);
        return never();
      }
      const resolved = resolveBindings(definition, bindings);
      if ('problems' in resolved) {
        failRun('workflow_failed', `${key} can't run: ${resolved.problems.join('; ')}`);
        return never();
      }
      const stageFile = join(reached.dir, 'stage.ts');
      record({ kind: 'call', call: { key, stage, call, stageIndex, definition, stageFile, ...resolved } });
      return never();
    }

    const run = {
      input,
      intake: { files: {} },
      /** An exception here is a bug in sail: it ends the replay as a crash and never reaches the workflow. */
      stage(definition: StageDefinition, bindings: unknown = {}, callOptions?: CallOptions): Promise<unknown> {
        try {
          return request(definition, bindings, callOptions);
        } catch (error) {
          record({ kind: 'crashed', error });
          return never();
        }
      },
      fail(reason: string): never {
        failRun('workflow_failed', String(reason));
        throw new Halt();
      },
    } as unknown as Run;

    // Started from a `then`, so a body that throws before its first `await` rejects like any other.
    Promise.resolve(run)
      .then((ready) => workflow.fn(ready))
      .then(
        (result) => record({ kind: 'completed', result }),
        (error: unknown) => {
          // A Halt's end is already recorded.
          if (!(error instanceof Halt)) failRun('workflow_failed', `workflow threw: ${messageOf(error)}`);
        },
      );
  });
}
