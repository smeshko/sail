// The fsync discipline for the files a run directory keeps: the journal, STATUS and run.json. A write is durable once
// its bytes are synced and so is the directory entry that names them, so every helper here syncs both before it
// returns.
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** Syncs `dir` itself, so the entries created, renamed or removed in it survive a crash. */
export function syncDir(dir: string): void {
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Creates the directory `path`, then syncs the directory holding it, whose entry names it. An existing `path` throws
 * `EEXIST`, unless `mayExist` says others create it too, as every run does `.sail-runs/`. Its parent is synced all the
 * same then, since a crash may have come between its creation and that sync.
 */
export function createDir(path: string, mayExist = false): void {
  try {
    mkdirSync(path);
  } catch (error) {
    if (!mayExist || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  syncDir(dirname(path));
}

/** Writes `text` whole to the open `fd`, then syncs it. */
function writeAndSync(fd: number, text: string): void {
  const bytes = Buffer.from(text);
  for (let written = 0; written < bytes.length; ) written += writeSync(fd, bytes, written);
  fsyncSync(fd);
}

/**
 * Creates `path` holding `text`, then sets `mode` when one is given. An existing file throws `EEXIST`: this is how a
 * file written once stays that way.
 */
export function createFileOnce(path: string, text: string, mode?: number): void {
  const fd = openSync(path, 'wx');
  try {
    writeAndSync(fd, text);
  } finally {
    closeSync(fd);
  }
  if (mode !== undefined) chmodSync(path, mode);
  syncDir(dirname(path));
}

/**
 * Appends `line` and its newline to `path` in one write, then syncs it. A crash can then tear only this line, and never
 * interleave it with another.
 */
export function appendLine(path: string, line: string): void {
  if (line.includes('\n')) throw new Error(`a line appended to ${path} holds a newline`);
  const fd = openSync(path, 'a');
  try {
    writeAndSync(fd, `${line}\n`);
  } finally {
    closeSync(fd);
  }
}

/** Replaces `path` with `text` atomically: a reader sees the old file or the new one, never a mix. */
export function replaceFile(path: string, text: string, _tmp = `${path}.tmp`): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeAndSync(fd, text);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  syncDir(dirname(path));
}
