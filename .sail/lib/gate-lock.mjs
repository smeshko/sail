// The machine's gate lock, shared by the validate stage and scripts/test.ts. One broad test run goes at a time on the
// machine: its test files already take a worker per core, and two runs' gates side by side slow each other.
// The lock is a directory, which only one process can make, holding the holder's pid and workspace. A holder that died
// without removing it, killed at the stage's timeout, leaves it to the next taker to remove. Validate carries its pid in
// SAIL_GATE_LOCK_HOLDER to the gate it spawns, so the launcher knows the lock it finds is its own parent's.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const HOLDER_ENV = 'SAIL_GATE_LOCK_HOLDER';

/** The lock's directory, from the temp directory as it is now, so a test isolates it with TMPDIR. */
export const lockPath = () => join(tmpdir(), 'sail-validate.lock');

/** The holder of the lock: its pid and workspace, or undefined while it is still writing them. */
export function holder() {
  try {
    const [pid, ...dir] = readFileSync(join(lockPath(), 'holder'), 'utf8').trim().split(' ');
    return { pid: Number(pid), dir: dir.join(' ') };
  } catch {
    return undefined;
  }
}

/** Whether a process with this pid exists: signal 0 checks without sending anything. */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Whether the lock exists and its holder is this live pid. */
export function heldBy(pid) {
  const held = holder();
  return held !== undefined && Number.isInteger(pid) && held.pid === pid && isAlive(pid);
}

/** Whether the lock was left behind: its holder is gone, or never wrote itself down. */
function isStale() {
  const held = holder();
  if (held) return !isAlive(held.pid);
  try {
    return Date.now() - statSync(lockPath()).mtimeMs > 10_000;
  } catch {
    return false;
  }
}

/**
 * Removes a lock left behind. It is renamed aside first, which only one waiter can do, then checked: a waiter that saw
 * the same stale lock as another may have renamed the fresh lock that one took meanwhile, and puts it back.
 */
function takeOver() {
  const path = lockPath();
  const seen = holder()?.pid;
  const aside = `${path}.${process.pid}`;
  try {
    renameSync(path, aside);
  } catch {
    return;
  }
  let moved;
  try {
    moved = Number(readFileSync(join(aside, 'holder'), 'utf8').split(' ')[0]);
  } catch {}
  if (moved !== undefined && moved !== seen && isAlive(moved)) {
    try {
      renameSync(aside, path);
      return;
    } catch {}
  }
  rmSync(aside, { recursive: true, force: true });
}

/**
 * Takes the lock and frees it when this process exits. While another process holds it, prints `waiting(dir)` once to
 * stderr, prefixed `label: `. With `seconds` it gives up and returns false once they have passed; without, or with a
 * value that is no number of seconds, it waits as long as the holder does, pausing at least 50 ms between tries.
 */
export async function lock({ label, waiting, seconds }) {
  const until = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Number.POSITIVE_INFINITY;
  for (let told = false; ; ) {
    const path = lockPath();
    try {
      mkdirSync(path);
      writeFileSync(join(path, 'holder'), `${process.pid} ${process.cwd()}\n`);
      process.on('exit', () => rmSync(path, { recursive: true, force: true }));
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (isStale()) {
      takeOver();
      continue;
    }
    if (Date.now() >= until) return false;
    if (!told) {
      process.stderr.write(`${label}: ${waiting(holder()?.dir ?? 'another workspace')}\n`);
      told = true;
    }
    await Bun.sleep(Math.min(1000, Math.max(50, until - Date.now())));
  }
}
