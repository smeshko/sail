// Where one call writes, inside a run directory:
//
//   NN-<stage>/call-N/out/        $STAGE_OUT: the files the call produces
//   NN-<stage>/call-N/in/         $STAGE_IN: its bindings, materialised
//   NN-<stage>/call-N/stdout.log  what it printed, in full
//   NN-<stage>/call-N/stderr.log
//   NN-<stage>/call-N/result.json the engine's record of the call
//   NN-<stage>/call-N/prompt.md   an agent step's prompt, as its session was sent it
//   NN-<stage>/call-N/session.log an agent step's transcript
//   NN-<stage>/call-N/port-events.ndjson a script step's port events file
//   NN-<stage>/call-N/try-M/      a later try of the same call, after an interruption or to correct an agent step's
//                                 output, with its own out/, in/, logs and result.json
//   NN-<stage>/call-N/steps/      a multi-step call's steps: `<i>-<step>/` each, with the step's own in/, logs and
//                                 result.json, and its later tries in try-M/ below it
//
// $STAGE_OUT is an `out/` that holds produced files only, so a session that writes anywhere in it can't touch the
// engine's records, which every try, step and `try-M/` keeps outside it. A one-step call's try has an `out/` of its
// own. The steps of a multi-step call share the call's `call-N/out/`.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { createDir, syncDir } from './durable';

/** The absolute paths of one call's directory and what the engine writes in it. */
export interface CallPaths {
  /** Where the engine writes the try's own files: its `$STAGE_IN`, logs, prompt, transcript and `result.json`. */
  dir: string;
  /** `$STAGE_OUT`: `<dir>/out`, or for a step its call's `call-N/out`. */
  out: string;
  /** `$STAGE_IN`: `<dir>/in`. */
  stageIn: string;
  stdout: string;
  stderr: string;
  result: string;
}

/** A name that stays directly inside the directory it is joined to: no separator, and not `.` or `..`. */
export function isPlainName(name: string): boolean {
  return /^[^/\\]+$/.test(name) && name !== '.' && name !== '..';
}

/** `NN-<stage>`: the stage's index, zero-padded to two digits, then its name. */
export function stageDirName(index: number, stage: string): string {
  if (!Number.isInteger(index) || index < 0) throw new Error(`stage index must be a whole number ≥ 0: ${index}`);
  return `${String(index).padStart(2, '0')}-${stage}`;
}

/** `try-M`: the directory of a call's try M ≥ 2, inside `call-N/`. */
export function isTryName(name: string): boolean {
  return /^try-[0-9]+$/.test(name);
}

/** `$STAGE_OUT` of the try `paths` are for. */
export function stageOut(paths: CallPaths): string {
  return paths.out;
}

/** The paths of a call's try: try 1 is `call-N/` itself, and try M ≥ 2 is `call-N/try-M/`. */
export function callPaths(runDir: string, index: number, stage: string, call: number, tryNumber = 1): CallPaths {
  if (!Number.isInteger(call) || call < 1) throw new Error(`call must be a whole number ≥ 1: ${call}`);
  if (!Number.isInteger(tryNumber) || tryNumber < 1) throw new Error(`try must be a whole number ≥ 1: ${tryNumber}`);
  const callDir = join(runDir, stageDirName(index, stage), `call-${call}`);
  const dir = tryNumber === 1 ? callDir : join(callDir, `try-${tryNumber}`);
  return {
    dir,
    out: join(dir, 'out'),
    stageIn: join(dir, 'in'),
    stdout: join(dir, 'stdout.log'),
    stderr: join(dir, 'stderr.log'),
    result: join(dir, 'result.json'),
  };
}

/**
 * The tries a call has a directory for, in order, each once: none when `call-N/` doesn't exist. Only `try-M` for
 * M ≥ 2 is a later try.
 */
export function existingTries(runDir: string, index: number, stage: string, call: number): number[] {
  const callDir = callPaths(runDir, index, stage, call).dir;
  if (!existsSync(callDir)) return [];
  const later = readdirSync(callDir)
    .filter(isTryName)
    .map((name) => Number(name.slice('try-'.length)))
    .filter((tryNumber) => tryNumber >= 2);
  return [1, ...[...new Set(later)].sort((a, b) => a - b)];
}

/** The try a call runs as next: 1 when `call-N/` doesn't exist, else one more than its highest try. */
export function nextTry(runDir: string, index: number, stage: string, call: number): number {
  return (existingTries(runDir, index, stage, call).at(-1) ?? 0) + 1;
}

/**
 * The paths of a try of step `stepIndex`, named `step`, of a multi-step call: its own files in
 * `call-N/steps/<stepIndex>-<step>/`, and try M ≥ 2 in `try-M/` below that. Its `$STAGE_OUT` is `call-N/out/`.
 */
export function stepPaths(
  runDir: string,
  index: number,
  stage: string,
  call: number,
  stepIndex: number,
  step: string,
  tryNumber = 1,
): CallPaths {
  if (!Number.isInteger(stepIndex) || stepIndex < 1) throw new Error(`step must be a whole number ≥ 1: ${stepIndex}`);
  if (!Number.isInteger(tryNumber) || tryNumber < 1) throw new Error(`try must be a whole number ≥ 1: ${tryNumber}`);
  const callDir = callPaths(runDir, index, stage, call).dir;
  const out = join(callDir, 'out');
  const stepDir = join(callDir, 'steps', `${stepIndex}-${step}`);
  const dir = tryNumber === 1 ? stepDir : join(stepDir, `try-${tryNumber}`);
  return {
    dir,
    out,
    stageIn: join(dir, 'in'),
    stdout: join(dir, 'stdout.log'),
    stderr: join(dir, 'stderr.log'),
    result: join(dir, 'result.json'),
  };
}

/** The tries a step of a multi-step call has a directory for, in order, each once: none when its directory is missing. */
export function existingStepTries(
  runDir: string,
  index: number,
  stage: string,
  call: number,
  stepIndex: number,
  step: string,
): number[] {
  const stepDir = stepPaths(runDir, index, stage, call, stepIndex, step).dir;
  if (!existsSync(stepDir)) return [];
  const later = readdirSync(stepDir)
    .filter(isTryName)
    .map((name) => Number(name.slice('try-'.length)))
    .filter((tryNumber) => tryNumber >= 2);
  return [1, ...[...new Set(later)].sort((a, b) => a - b)];
}

/** The try a step runs as next: 1 when its directory doesn't exist, else one more than its highest try. */
export function nextStepTry(
  runDir: string,
  index: number,
  stage: string,
  call: number,
  stepIndex: number,
  step: string,
): number {
  return (existingStepTries(runDir, index, stage, call, stepIndex, step).at(-1) ?? 0) + 1;
}

/**
 * Creates the call directory, `$STAGE_OUT` and `$STAGE_IN`. A call directory is written once, so an existing one throws.
 * A `durable` one has its entries synced before this returns: the tries an agent call has on disk are where a resume
 * reads how far the call got. `stageIn: false` leaves `$STAGE_IN` out, for a call with no bindings to materialise: a
 * built-in intake's.
 *
 * A step's directory sits below its call's directory, which the step before it may have made, and shares its call's
 * `$STAGE_OUT`: `call-N/`, `steps/` and `out/` are made when missing, and the step's own directory once.
 */
export function createCallDir(paths: CallPaths, options: { durable?: boolean; stageIn?: boolean } = {}): void {
  const stageIn = options.stageIn ?? true;
  const own = dirname(paths.out) === paths.dir;
  if (!own) {
    const callDir = dirname(paths.out);
    if (!options.durable) {
      mkdirSync(dirname(paths.dir), { recursive: true });
      mkdirSync(paths.dir);
      if (stageIn) mkdirSync(paths.stageIn);
      mkdirSync(paths.out, { recursive: true });
      return;
    }
    // Each one synced into its parent, from the stage's directory down: the call's first step may be the one to make it.
    mkdirSync(dirname(dirname(callDir)), { recursive: true });
    for (const dir of missing(dirname(paths.dir), dirname(callDir))) createDir(dir);
    createDir(paths.dir);
    if (stageIn) createDir(paths.stageIn);
    if (!existsSync(paths.out)) createDir(paths.out);
    return;
  }
  const parent = dirname(paths.dir);
  mkdirSync(parent, { recursive: true });
  if (!options.durable) {
    mkdirSync(paths.dir);
    if (stageIn) mkdirSync(paths.stageIn);
    mkdirSync(paths.out);
    return;
  }
  // The stage's directory may be new too, and its entry is its own parent's.
  syncDir(dirname(parent));
  createDir(paths.dir);
  if (stageIn) createDir(paths.stageIn);
  createDir(paths.out);
}

/** The directories from `top` down to `dir` that don't exist yet, outermost first, `top` included. */
function missing(dir: string, top: string): string[] {
  const absent: string[] = [];
  for (let at = dir; !existsSync(at); at = dirname(at)) {
    absent.unshift(at);
    if (at === top) break;
  }
  return absent;
}

/**
 * Writes one of the engine's own files into a call directory once its step has run. The step may have left anything
 * under the name, a link out of the directory included, if it wrote outside `$STAGE_OUT`. So what is there is removed
 * and the file is made new: the write never goes through it, to wherever it points.
 */
export function writeOwnFile(path: string, text: string): void {
  rmSync(path, { force: true });
  writeFileSync(path, text, { flag: 'wx' });
}

/** A POSIX path relative to the run directory, as `result.json` records a file. */
export function runRelative(runDir: string, path: string): string {
  return relative(runDir, path).split(sep).join('/');
}
