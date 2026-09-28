// The script kind: any executable, run with the environment preamble in its own process group. Its exit code maps to
// `passed` or `failed` through `exitCodes`, its last stdout line is its JSON output, and it must leave every declared
// file in `$STAGE_OUT`. Every broken promise is collected as an error. It reports the facts only it knows as events:
// how the process ran and ended, whether the output was read and held its schema, and which files it recorded.
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { type ContractError, producesProblems, recordFiles, validateOutput } from '../engine/contract';
import { runProcess } from '../engine/process';
import type { ScriptOutcome, ScriptStep } from '../sdk/steps';
import type { StepContext, StepKind, StepRun } from './index';

/** How long a script may run when it sets no `timeoutSeconds`. */
export const DEFAULT_TIMEOUT_SECONDS = 600;

const LISTS = ['passed', 'failed', 'error'] as const;

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
  const timeout = step.timeoutSeconds;
  if (timeout !== undefined && !(Number.isFinite(timeout) && timeout > 0)) {
    found.push(`timeoutSeconds must be a positive number: ${timeout}`);
  }
  return found;
}

/** The variables every script gets, in order, and which of them are paths. */
function preamble(context: StepContext): { name: string; value: string; path: boolean }[] {
  return [
    { name: 'RUN_ID', value: context.runId, path: false },
    { name: 'STAGE', value: context.stage, path: false },
    { name: 'CALL', value: String(context.call), path: false },
    { name: 'TRY', value: String(context.try), path: false },
    { name: 'STAGE_IN', value: context.paths.stageIn, path: true },
    { name: 'STAGE_OUT', value: context.paths.dir, path: true },
    { name: 'WORKSPACE', value: context.workspace, path: true },
    { name: 'SAIL_CONFIG', value: context.config, path: true },
    ...Object.entries(context.inputs).map(([name, value]) => ({ name, value, path: true })),
  ];
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

async function run(step: ScriptStep, context: StepContext): Promise<StepRun> {
  const emit = context.emit ?? (() => {});
  const command = resolve(context.stageDir, step.run);
  const timeoutSeconds = step.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const variables = preamble(context);
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

  // Recorded relative to the workspace, and only the preamble: the inherited environment may hold secrets.
  const at = (path: string) => relative(context.workspace, path) || '.';
  const env = Object.fromEntries(variables.map(({ name, value, path }) => [name, path ? at(value) : value]));
  const recorded = { command: at(command), env };

  emit({
    type: 'script:exec',
    command: recorded.command,
    cwd: at(context.workspace),
    envKeys: variables.map(({ name }) => name),
  });
  const startedAt = Date.now();
  const end = await runProcess({
    command: [command],
    cwd: context.workspace,
    env: { ...inherited, ...Object.fromEntries(variables.map(({ name, value }) => [name, value])) },
    stdout: context.paths.stdout,
    stderr: context.paths.stderr,
    timeoutMs: timeoutSeconds * 1000,
    ...(context.graceMs === undefined ? {} : { graceMs: context.graceMs }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  const durationMs = Date.now() - startedAt;
  const ended = (error: ContractError, record: Record<string, unknown>): StepRun => ({
    outcome: 'error',
    output: null,
    files: {},
    errors: [error],
    record,
  });

  if (!end.started) return ended({ reason: 'not_started', message: end.message }, recorded);

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
    stdoutBytes: statSync(context.paths.stdout, { throwIfNoEntry: false })?.size ?? 0,
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
  const produced = recordFiles(step.produces, context.paths.dir, context.runDir);
  for (const [name, { path, bytes, sha256 }] of Object.entries(produced.files)) {
    emit({ type: 'file:produced', name, path, bytes, sha256 });
  }
  errors.push(...produced.errors);
  return {
    outcome: errors.length > 0 ? 'error' : mapped,
    output: errors.length > 0 || !output.ok ? null : output.data,
    files: produced.files,
    errors,
    record,
  };
}

export const scriptKind: StepKind<ScriptStep> = { kind: 'script', problems, run };
