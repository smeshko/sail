// Where one call writes, inside a run directory:
//
//   NN-<stage>/call-N/            $STAGE_OUT: the files the call produces
//   NN-<stage>/call-N/in/         $STAGE_IN: its bindings, materialised
//   NN-<stage>/call-N/stdout.log  what it printed, in full
//   NN-<stage>/call-N/stderr.log
//   NN-<stage>/call-N/result.json the engine's record of the call
//   NN-<stage>/call-N/prompt.md   an agent step's prompt, as its session was sent it
//   NN-<stage>/call-N/session.log an agent step's transcript
//   NN-<stage>/call-N/try-M/      a later try of the same call, after an interruption (and, from Epic 05, a retry),
//                                 with its own in/, logs and result.json
//
// $STAGE_OUT is the call directory itself, not an `out/` below it, because the golden run directory records produced
// files beside the logs (`03-tests/call-1/junit.xml`). So the engine's own names are reserved there.
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** The absolute paths of one call's directory and what the engine writes in it. */
export interface CallPaths {
  /** `$STAGE_OUT`. */
  dir: string;
  /** `$STAGE_IN`: `<dir>/in`. */
  stageIn: string;
  stdout: string;
  stderr: string;
  result: string;
}

/** The names in a call directory that are the engine's. No `produces` may declare one. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'in',
  'stdout.log',
  'stderr.log',
  'result.json',
  'prompt.md',
  'session.log',
]);

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

/** The paths of a call's try: try 1 is `call-N/` itself, and try M ≥ 2 is `call-N/try-M/`. */
export function callPaths(runDir: string, index: number, stage: string, call: number, tryNumber = 1): CallPaths {
  if (!Number.isInteger(call) || call < 1) throw new Error(`call must be a whole number ≥ 1: ${call}`);
  if (!Number.isInteger(tryNumber) || tryNumber < 1) throw new Error(`try must be a whole number ≥ 1: ${tryNumber}`);
  const callDir = join(runDir, stageDirName(index, stage), `call-${call}`);
  const dir = tryNumber === 1 ? callDir : join(callDir, `try-${tryNumber}`);
  return {
    dir,
    stageIn: join(dir, 'in'),
    stdout: join(dir, 'stdout.log'),
    stderr: join(dir, 'stderr.log'),
    result: join(dir, 'result.json'),
  };
}

/** The try a call runs as next: 1 when `call-N/` doesn't exist, else one more than its highest try. */
export function nextTry(runDir: string, index: number, stage: string, call: number): number {
  const callDir = callPaths(runDir, index, stage, call).dir;
  if (!existsSync(callDir)) return 1;
  const tries = readdirSync(callDir)
    .filter(isTryName)
    .map((name) => Number(name.slice('try-'.length)));
  return Math.max(1, ...tries) + 1;
}

/** Creates the call directory and `$STAGE_IN`. A call directory is written once, so an existing one throws. */
export function createCallDir(paths: CallPaths): void {
  mkdirSync(dirname(paths.dir), { recursive: true });
  mkdirSync(paths.dir);
  mkdirSync(paths.stageIn);
}

/** A POSIX path relative to the run directory, as `result.json` records a file. */
export function runRelative(runDir: string, path: string): string {
  return relative(runDir, path).split(sep).join('/');
}
