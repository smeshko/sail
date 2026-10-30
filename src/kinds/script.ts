// The script kind: any executable, run with the script environment in its own process group.
// Credentials are never given unless declared. Its exit code maps to
// `passed` or `failed` through `exitCodes`, its last stdout line is its JSON output, and it must leave every declared
// file in `$STAGE_OUT`. Every broken promise is collected as an error. It reports the facts only it knows as events:
// how the process ran and ended, whether the output was read and held its schema, and which files it recorded.
//
// `sail` inside a script is the sail that runs it: `PATH` starts with this package's `bin/`, and `SAIL_BUN` names the
// running Bun, which `bin/sail` executes. Both name this machine, so neither is recorded.
//
// `SAIL_EVENTS` names the step's port events file, `port-events.ndjson` in its call directory, where a `sail port` the
// script runs leaves its provider events. Once the process has ended, however it ended, the file is read and each event
// emitted, after `script:exec` and before `script:exit`. A line that is no provider event ends the step in `error`,
// with the reason `port`. The variable is this kind's, not the preamble's: an agent step gets none.
//
// A step that declares `exclusive` takes that machine-wide slot before `script:exec` and gives it back once the script
// has ended and been read. While another holder has it the step waits, emitting `step:queued` for each holder it finds,
// and the wait doesn't count toward `timeoutSeconds`. An abort while it waits ends the step in `error`, `not_started`.
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { delimiter, join, relative, resolve } from 'node:path';
import { stageOut } from '../engine/call-dir';
import { systemClock } from '../engine/clock';
import type { Port } from '../engine/config';
import { type ContractError, producesProblems, recordFiles, validateOutput } from '../engine/contract';
import { scriptEnv } from '../engine/env-allowlist';
import { repositoryVariables } from '../engine/git-env';
import { PORT_EVENTS_FILE, readPortEvents } from '../engine/port-events';
import { preamble } from '../engine/preamble';
import { runProcess } from '../engine/process';
import { checkoutPath } from '../engine/run-dir';
import {
  defaultSlotsDir,
  releaseSlot,
  type Slot,
  SlotContended,
  SlotError,
  type SlotHolder,
  type SlotResult,
  takeSlot,
} from '../engine/slots';
import type { ScriptOutcome, ScriptPort, ScriptStep } from '../sdk/steps';
import type { StepContext, StepKind, StepRun } from './index';

/** This package's `bin/`, which holds the `sail` a script step runs. */
export const BIN_DIR = join(import.meta.dir, '..', '..', 'bin');

/** What a process with no `PATH` is run with: `bin/` goes ahead of it, where it would otherwise be all there is. */
const SYSTEM_PATH = '/usr/bin:/bin';

/** How long a script may run when it sets no `timeoutSeconds`. */
export const DEFAULT_TIMEOUT_SECONDS = 600;

const LISTS = ['passed', 'failed', 'error'] as const;

const SCRIPT_PORTS: Record<ScriptPort, Port> = { 'ticket-source': 'ticketSource', codehost: 'codeHost', jev: 'jev' };

const SLOT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** How often a step queued for its slot looks again, unless the context says otherwise. */
const SLOT_POLL_MS = 1000;

/** The step's `exitCodes`, with `passed` defaulting to `[0]` and `failed` to `[1]` when left out. */
export function exitCodeMap(step: ScriptStep): Record<(typeof LISTS)[number], readonly number[]> {
  return {
    passed: step.exitCodes?.passed ?? [0],
    failed: step.exitCodes?.failed ?? [1],
    error: step.exitCodes?.error ?? [],
  };
}

function problems(step: ScriptStep): string[] {
  const found: string[] = [];
  const ports = new Set<string>();
  for (const port of step.ports ?? []) {
    if (!Object.hasOwn(SCRIPT_PORTS, port))
      found.push(`ports names an unknown port '${port}': ticket-source, codehost or jev`);
    else if (ports.has(port)) found.push(`ports names '${port}' twice`);
    ports.add(port);
  }
  const names = new Set<string>();
  for (const name of step.env ?? []) {
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      found.push(`env names an invalid variable: '${name}'`);
    if (names.has(name)) found.push(`env names '${name}' twice`);
    names.add(name);
  }
  const map = exitCodeMap(step);
  const listedUnder = new Map<number, string>();
  for (const list of LISTS) {
    for (const code of map[list]) {
      const first = listedUnder.get(code);
      if (first === undefined) listedUnder.set(code, list);
      else if (first !== list) found.push(`exit code ${code} is listed under both ${first} and ${list}`);
    }
  }
  found.push(...producesProblems(step.produces));
  for (const [name, value] of Object.entries(step.produces)) {
    if (value !== 'file') found.push(`'${name}' is a document: only an agent step completes one`);
  }
  const timeout = step.timeoutSeconds;
  if (timeout !== undefined && !(Number.isFinite(timeout) && timeout > 0)) {
    found.push(`timeoutSeconds must be a positive number: ${timeout}`);
  }
  if (step.exclusive !== undefined && !SLOT_NAME.test(step.exclusive)) {
    found.push(
      `exclusive must be a slot name of lowercase letters, digits and hyphens, up to 64, starting with a letter or digit: '${step.exclusive}'`,
    );
  }
  return found;
}

const CHUNK = 64 * 1024;
const isBlank = (byte: number) => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;

/**
 * The last line of a file that isn't blank, trimmed, or undefined when there is none. It reads backwards from the end
 * a chunk at a time, so a large log is never read whole.
 */
export function lastLine(path: string): string | undefined {
  const fd = openSync(path, 'r');
  try {
    let tail = Buffer.alloc(0);
    for (let start = fstatSync(fd).size; start > 0; ) {
      const from = Math.max(0, start - CHUNK);
      const chunk = Buffer.alloc(start - from);
      readSync(fd, chunk, 0, chunk.length, from);
      tail = Buffer.concat([chunk, tail]);
      start = from;
      let end = tail.length;
      while (end > 0 && isBlank(tail[end - 1] as number)) end--;
      if (end === 0) {
        tail = Buffer.alloc(0); // only blank lines so far
        continue;
      }
      const newline = tail.lastIndexOf(0x0a, end - 1);
      if (newline >= 0 || start === 0)
        return tail
          .subarray(newline + 1, end)
          .toString('utf8')
          .trim();
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** Parses the last stdout line as the output and validates it. */
function readOutput(
  step: ScriptStep,
  stdout: string,
): { ok: true; data: unknown } | { ok: false; error: ContractError } {
  let line: string | undefined;
  try {
    line = lastLine(stdout);
  } catch (error) {
    // The log is in $STAGE_OUT, so a script that clears it before writing its files removes the log too.
    const code = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
    const message =
      code === 'ENOENT'
        ? "stdout.log was removed from $STAGE_OUT, so the output can't be read"
        : `stdout.log can't be read (${code}), so the output can't be either`;
    return { ok: false, error: { reason: 'invalid_output', message } };
  }
  if (line === undefined) {
    return {
      ok: false,
      error: { reason: 'invalid_output', message: 'stdout is empty; the last line must be the JSON output' },
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    const message = `the last stdout line is not JSON: ${(error as Error).message}`;
    return { ok: false, error: { reason: 'invalid_output', message } };
  }
  const checked = validateOutput(step.output, value);
  if (checked.ok) return checked;
  return {
    ok: false,
    error: { reason: 'invalid_output', message: `the output doesn't match its schema:\n${checked.message}` },
  };
}

/** The bytes the script printed, or 0 when its log is gone or can't be read: `readOutput()` reports why. */
function printedBytes(stdout: string): number {
  try {
    return statSync(stdout).size;
  } catch {
    return 0;
  }
}

/** Sleeps `ms`, or until `signal` aborts. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((done) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      done();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Takes the exclusive slot `name`, waiting while another holder has it. Each new holder it finds is reported once, as
 * `step:queued`. A slot that kept changing hands is tried again at the next poll. Undefined once the slot is held;
 * otherwise the error that ended the wait: an interruption, or a slot file that isn't one.
 */
async function acquire(
  name: string,
  holder: SlotHolder,
  context: StepContext,
  emit: NonNullable<StepContext['emit']>,
): Promise<ContractError | undefined> {
  const dir = context.slots?.dir ?? defaultSlotsDir();
  const pollMs = context.slots?.pollMs ?? SLOT_POLL_MS;
  const interrupted = (): ContractError => ({
    reason: 'not_started',
    message: `interrupted while queued for exclusive slot '${name}'`,
  });
  let reported: Slot | undefined;
  for (;;) {
    if (context.signal?.aborted) return interrupted();
    let result: SlotResult;
    try {
      result = takeSlot(dir, name, holder, (context.clock ?? systemClock)());
    } catch (error) {
      if (error instanceof SlotContended) {
        await pause(pollMs, context.signal);
        continue;
      }
      if (error instanceof SlotError) return { reason: 'not_started', message: error.message };
      throw error;
    }
    if (result.taken) return undefined;
    const held = result.holder;
    if (reported === undefined || reported.runId !== held.runId || reported.key !== held.key) {
      emit({
        type: 'step:queued',
        exclusive: name,
        holder: { runId: held.runId, key: held.key, pid: held.pid, takenAt: held.takenAt },
      });
      reported = held;
    }
    await pause(pollMs, context.signal);
  }
}

/**
 * Gives slot `name` back. A slot file that can't be released doesn't replace the script's result: the next taker
 * reports it, naming the file.
 */
function release(dir: string, name: string, holder: SlotHolder): void {
  try {
    releaseSlot(dir, name, holder);
  } catch (error) {
    if (!(error instanceof SlotError)) throw error;
  }
}

async function runScript(step: ScriptStep, context: StepContext): Promise<StepRun> {
  const emit = context.emit ?? (() => {});
  const command = resolve(context.stageDir, step.run);
  const timeoutSeconds = step.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const portEvents = join(context.paths.dir, PORT_EVENTS_FILE);
  const variables = [...preamble(context), { name: 'SAIL_EVENTS', value: portEvents, path: true }];
  // Record only the preamble's values, even when a port cannot be resolved.
  const at = (path: string) => relative(context.root, path) || '.';
  const env = Object.fromEntries(variables.map(({ name, value, path }) => [name, path ? at(value) : value]));
  const recorded = { command: checkoutPath(context.root, context.runDir, command), env };
  // A step in a run's workspace must not have its git point at the clone. A step in the clone keeps what a hook set.
  const source = context.env ?? process.env;
  const declared = [...(step.env ?? [])];
  for (const port of step.ports ?? []) {
    const names = context.portVariables
      ? await context.portVariables(SCRIPT_PORTS[port])
      : { problem: 'no port variable resolver is available' };
    if ('problem' in names)
      return {
        outcome: 'error',
        output: null,
        files: {},
        record: recorded,
        errors: [{ reason: 'not_started', message: `the step declares the port ${port}, but ${names.problem}` }],
      };
    declared.push(...names);
  }
  const picked = scriptEnv(source, declared);
  const inherited = { ...picked.env, ...(context.inClone ? repositoryVariables(source) : {}) };

  emit({
    type: 'script:exec',
    command: recorded.command,
    cwd: at(context.workspace),
    envKeys: [...variables.map(({ name }) => name), ...picked.given],
  });
  const clock = context.clock ?? systemClock;
  const startedAt = clock().getTime();
  const end = await runProcess({
    command: [command],
    cwd: context.workspace,
    env: {
      ...inherited,
      PATH: `${BIN_DIR}${delimiter}${inherited.PATH ?? SYSTEM_PATH}`,
      SAIL_BUN: process.execPath,
      ...Object.fromEntries(variables.map(({ name, value }) => [name, value])),
    },
    stdout: context.paths.stdout,
    stderr: context.paths.stderr,
    timeoutMs: timeoutSeconds * 1000,
    ...(context.graceMs === undefined ? {} : { graceMs: context.graceMs }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  const durationMs = clock().getTime() - startedAt;
  /** What the port events file holds that is no provider event: each ends the step in `error`, whatever else does. */
  const unported: ContractError[] = [];
  const ended = (error: ContractError, record: Record<string, unknown>): StepRun => ({
    outcome: 'error',
    output: null,
    files: {},
    errors: [error, ...unported],
    record,
  });

  if (!end.started) return ended({ reason: 'not_started', message: end.message }, recorded);

  // What the script's port commands reported, now that no child can still be writing. The call's emit adds the key.
  const key = context.key ?? `${context.stage}#${context.call}`;
  const ported = readPortEvents(portEvents, { runId: context.runId, key });
  for (const event of ported.events) emit(event);
  // One at a time: a file of a million bad lines is a million problems, more than a call takes as arguments.
  for (const message of ported.problems) unported.push({ reason: 'port', message });

  const map = exitCodeMap(step);
  const mapped: ScriptOutcome | undefined =
    end.code === null
      ? undefined
      : map.passed.includes(end.code)
        ? 'passed'
        : map.failed.includes(end.code)
          ? 'failed'
          : 'error';
  const exit = {
    code: end.code,
    ...(end.signal === null ? {} : { signal: end.signal }),
    ...(mapped === undefined ? {} : { mapped }),
  };
  const record = { exit, ...recorded };
  emit({
    type: 'script:exit',
    code: end.code,
    ...(end.signal === null ? {} : { signal: end.signal }),
    ...(mapped === undefined ? {} : { outcome: mapped }),
    durationMs,
    stdoutBytes: printedBytes(context.paths.stdout),
  });

  // A script that didn't finish on its own, or whose exit code means error, produced nothing worth checking. Any other
  // end owes its output and files, `failed` as much as `passed`: a failing test run still owes its report.
  if (end.timedOut) {
    const message = `timed out after ${timeoutSeconds}s`;
    emit({ type: 'error:timeout', message, timeoutSeconds });
    return ended({ reason: 'timeout', message }, record);
  }
  // An interrupted call didn't finish its work, even when the script handles SIGTERM and exits with a passing code.
  if (end.aborted) {
    const how = end.signal === null ? `exited with code ${end.code}` : `ended by signal ${end.signal}`;
    return ended({ reason: 'exit_code', message: `interrupted, then ${how}` }, record);
  }
  if (end.signal !== null) return ended({ reason: 'exit_code', message: `ended by signal ${end.signal}` }, record);
  if (mapped !== 'passed' && mapped !== 'failed') {
    return ended({ reason: 'exit_code', message: `exit code ${end.code} is not mapped to passed or failed` }, record);
  }

  const errors: ContractError[] = [];
  const output = readOutput(step, context.paths.stdout);
  if (output.ok) emit({ type: 'output:validated' });
  else {
    emit({ type: 'output:invalid', message: output.error.message });
    errors.push(output.error);
  }
  const produced = recordFiles(step.produces, stageOut(context.paths), context.runDir);
  for (const [name, { path, bytes, sha256 }] of Object.entries(produced.files)) {
    emit({ type: 'file:produced', name, path, bytes, sha256 });
  }
  const all = [...errors, ...produced.errors, ...unported];
  return {
    outcome: all.length > 0 ? 'error' : mapped,
    output: all.length > 0 || !output.ok ? null : output.data,
    files: produced.files,
    errors: all,
    record,
  };
}

async function run(step: ScriptStep, context: StepContext): Promise<StepRun> {
  if (step.exclusive === undefined) return runScript(step, context);
  const holder: SlotHolder = {
    runId: context.runId,
    key: context.key ?? `${context.stage}#${context.call}`,
    runDir: context.runDir,
    pid: process.pid,
  };
  const emit = context.emit ?? (() => {});
  const refused = await acquire(step.exclusive, holder, context, emit);
  if (refused !== undefined) return { outcome: 'error', output: null, files: {}, errors: [refused], record: {} };
  try {
    return await runScript(step, context);
  } finally {
    release(context.slots?.dir ?? defaultSlotsDir(), step.exclusive, holder);
  }
}

export const scriptKind: StepKind<ScriptStep> = { kind: 'script', problems, run };
