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
//
// Every replay passes the same moves again, so the loop and route events are emitted only past the journal's end, once
// every journaled call has been handed back. A move there is new: the workflow asking for a call the journal doesn't
// hold, returning, or calling `run.fail()`. A route records the last journaled call's outcome and that move. A loop's
// `break` is only known at the next move, since `for…of` also closes the loop when an exception leaves its body, so
// its `loop:exit` is held until then, and dropped if the replay ends another way.
import { join } from 'node:path';
import { z } from 'zod';
import type { Emit, NewEvent } from '../events/types';
import type { ProducedFile } from '../sdk/bindings';
import type { StageDefinition } from '../sdk/steps';
import type { CallOptions, Iteration, Run, Workflow } from '../sdk/workflow';
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
  /** Where the loop and route events of moves past the journal's end go. */
  emit?: Emit;
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

/**
 * A Halt thrown in a promise chain the workflow doesn't await, such as a `run.fail()` in a `.then()` nothing awaits,
 * rejects a promise nothing handles. Bun would print sail's internal error and exit 1, whatever end the replay
 * recorded. So the first replay registers this for the process: it drops a Halt, and throws anything else on, which
 * Bun reports as it would have.
 */
export function dropStrayHalt(reason: unknown): void {
  if (!(reason instanceof Halt)) throw reason;
}

/** A replay's end, or a bug in sail that makes `replay()` reject. */
type Recorded = ReplayEnd | { kind: 'crashed'; error: unknown };

const never = <T>(): Promise<T> => new Promise<T>(() => {});

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const isObject = (value: unknown): value is object =>
  (typeof value === 'object' && value !== null) || typeof value === 'function';

/**
 * Freezes `value` and everything it holds, and returns it. `run.input` is one object every replay reads, so a change
 * one replay made would reach the next, and an output the workflow changed would still claim its `result.json` in
 * `consumed`. Frozen, a change throws, and the run fails. A frozen object is taken as frozen all the way down.
 */
function deepFreeze<T>(value: T): T {
  if (isObject(value) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const each of Object.values(value)) deepFreeze(each);
  }
  return value;
}

/**
 * Runs the workflow once against `entries`, and resolves with how the replay ended as soon as the end is recorded. The
 * workflow's own promise may never settle. An exception inside sail's `run` methods rejects instead.
 */
export function replay(options: ReplayOptions): Promise<ReplayEnd> {
  const { workflow, stages, entries, runDir } = options;
  const emit = options.emit ?? (() => {});
  const input = deepFreeze(options.input);
  if (!process.listeners('unhandledRejection').includes(dropStrayHalt)) process.on('unhandledRejection', dropStrayHalt);
  return new Promise<ReplayEnd>((resolve, reject) => {
    let ended = false;
    /** The next journal entry a request must match. */
    let position = 0;
    const calls = new Map<string, number>();
    const stageIndexes = new Map<string, number>();
    const loops = new Set<string>();
    /** Each file handed to the workflow, to its run-relative path. */
    const files = new WeakMap<object, string>();
    /** Each output handed to the workflow, to its JSON pointer. */
    const pointers = new WeakMap<object, string>();
    /** The `break` of each loop left since the last move, innermost first, reported at the workflow's next move. */
    const pendingExits: NewEvent[] = [];

    /** Every journaled call has been handed back, so the workflow's moves from here on are new. */
    const live = () => position === entries.length;

    function flush(): void {
      for (const exit of pendingExits.splice(0)) emit(exit);
    }

    /** Reports a move past the journal's end: the loops it left, then the route from the last journaled call. */
    function move(took: string): void {
      flush();
      const last = entries[position - 1];
      if (last !== undefined) emit({ type: 'workflow:route', at: last.key, value: last.outcome, took });
    }

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
          if (isObject(entry.output)) pointers.set(deepFreeze(entry.output), `${entry.resultPath}#/output`);
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
      move(key);
      record({ kind: 'call', call: { key, stage, call, stageIndex, definition, stageFile, ...resolved } });
      return never();
    }

    /** Records a failed run, then stops the workflow where it stands. */
    function halt(message: string): never {
      failRun('workflow_failed', message);
      throw new Halt();
    }

    /** Wraps a synchronous `run` method: an exception other than a Halt is a bug in sail, and crashes the replay. */
    function guarded<A extends unknown[], R>(method: (...args: A) => R): (...args: A) => R {
      return (...args) => {
        try {
          return method(...args);
        } catch (error) {
          if (error instanceof Halt) throw error;
          record({ kind: 'crashed', error });
          throw new Halt();
        }
      };
    }

    /**
     * A bounded loop: only `break` or `return` ends it, and asking for pass `max + 1` fails the run. A pass that
     * neither fails nor breaks runs again with no feedback, so a forgotten `fail()` costs passes, not a check.
     */
    function loop(name: string, loopOptions: { max: number; feedback?: z.ZodType }): Iterable<Iteration<unknown>> {
      if (loops.has(name)) halt(`loop "${name}" is started twice in one replay`);
      loops.add(name);
      const max = loopOptions?.max;
      const schema = loopOptions?.feedback;
      if (!Number.isInteger(max) || max < 1) halt(`loop "${name}" needs a whole max of at least 1`);
      let passes = 0;
      let pending: { value: unknown } | undefined;

      const fail = guarded((feedback?: unknown) => {
        let value = feedback;
        if (schema !== undefined) {
          const parsed = schema.safeParse(feedback);
          if (!parsed.success) {
            halt(`loop "${name}" feedback doesn't match its schema:\n${z.prettifyError(parsed.error)}`);
          }
          value = parsed.data;
        }
        // Parsing makes a new object, so the parsed feedback carries the pointer of the output it came from, frozen
        // like that output.
        const pointer = isObject(feedback) ? pointers.get(feedback) : undefined;
        if (pointer !== undefined && isObject(value)) pointers.set(deepFreeze(value), pointer);
        pending = { value };
      });

      const next = guarded((): IteratorResult<Iteration<unknown>> => {
        if (ended) throw new Halt();
        if (passes === max) {
          if (live()) {
            flush();
            emit({ type: 'loop:exit', loop: name, iterations: passes, max, reason: 'exceeded' });
          }
          halt(`loop "${name}" exceeded ${max}`);
        }
        passes++;
        const previous = pending?.value;
        if (live()) {
          flush();
          const feedback = previous === undefined ? {} : { feedback: { from: from(previous) } };
          emit({ type: 'loop:iteration', loop: name, iteration: passes, max, ...feedback });
        }
        pending = undefined;
        return { done: false, value: { previous, fail } };
      });

      // `for…of` calls this on `break`, on `return` and when an exception leaves the body. Only the workflow's next
      // move shows it left on purpose, so the exit waits for it.
      const close = guarded((): IteratorResult<Iteration<unknown>> => {
        if (!ended && live())
          pendingExits.push({ type: 'loop:exit', loop: name, iterations: passes, max, reason: 'break' });
        return { done: true, value: undefined };
      });

      return { [Symbol.iterator]: () => ({ next, return: close }) };
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
      loop: guarded(loop),
      fail(reason: string): never {
        if (!ended && live()) move('fail');
        halt(String(reason));
      },
    } as unknown as Run;

    // Started from a `then`, so a body that throws before its first `await` rejects like any other.
    Promise.resolve(run)
      .then((ready) => workflow.fn(ready))
      .then(
        (result) => {
          if (!ended && live()) move('end');
          record({ kind: 'completed', result });
        },
        (error: unknown) => {
          // A Halt's end is already recorded.
          if (!(error instanceof Halt)) failRun('workflow_failed', `workflow threw: ${messageOf(error)}`);
        },
      );
  });
}
