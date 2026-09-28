// Where one call writes, inside a run directory:
//
//   NN-<stage>/call-N/            $STAGE_OUT: the files the call produces
//   NN-<stage>/call-N/in/         $STAGE_IN: its bindings, materialised
//   NN-<stage>/call-N/stdout.log  what it printed, in full
//   NN-<stage>/call-N/stderr.log
//   NN-<stage>/call-N/result.json the engine's record of the call
//
// $STAGE_OUT is the call directory itself, not an `out/` below it, because the golden run directory records produced
// files beside the logs (`03-tests/call-1/junit.xml`). So the engine's own names are reserved there.
import { mkdirSync } from 'node:fs';
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
export const RESERVED_NAMES: ReadonlySet<string> = new Set(['in', 'stdout.log', 'stderr.log', 'result.json']);

/** A name that stays directly inside the directory it is joined to: no separator, and not `.` or `..`. */
export function isPlainName(name: string): boolean {
  return /^[^/\\]+$/.test(name) && name !== '.' && name !== '..';
}

/** `NN-<stage>`: the stage's index, zero-padded to two digits, then its name. */
export function stageDirName(index: number, stage: string): string {
  if (!Number.isInteger(index) || index < 0) throw new Error(`stage index must be a whole number ≥ 0: ${index}`);
  return `${String(index).padStart(2, '0')}-${stage}`;
}

// biome-ignore lint/correctness/noUnusedFunctionParameters: a stub until TASK-002 reads the try
export function callPaths(runDir: string, index: number, stage: string, call: number, tryNumber = 1): CallPaths {
  if (!Number.isInteger(call) || call < 1) throw new Error(`call must be a whole number ≥ 1: ${call}`);
  const dir = join(runDir, stageDirName(index, stage), `call-${call}`);
  return {
    dir,
    stageIn: join(dir, 'in'),
    stdout: join(dir, 'stdout.log'),
    stderr: join(dir, 'stderr.log'),
    result: join(dir, 'result.json'),
  };
}

/** The try a call runs as next: 1 when `call-N/` doesn't exist, else one more than its highest try. */
// biome-ignore lint/correctness/noUnusedFunctionParameters: a stub until TASK-002 numbers tries
export function nextTry(runDir: string, index: number, stage: string, call: number): number {
  return 0;
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
