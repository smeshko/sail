// A file-backed fake's world (D1): read from a committed seed until the first change, which copies the world into a
// separate state file. Every later read and change uses the state file, so a change made in one process is seen in the
// next. The seed is never written, so running the fixture repository in place leaves git clean.
//
// A change holds `<state>.lock` from its read to its write, so changes made in several processes at once each see the
// one before: two claims of one ticket can't both take it. A lock left by a process that died holding it is broken.
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { z } from 'zod';
import type { Port } from '../../engine/config';
import { replaceFile } from '../../engine/durable';
import { PortError } from '../../ports/errors';
import { isAlive } from '../leases';

export interface StoreOptions<W> {
  /** The committed world. Never written. */
  readonly seed: string;
  /** Where the world's changes are kept. Read instead of `seed` once it exists. */
  readonly state: string;
  readonly schema: z.ZodType<W>;
  /** The port a broken file is reported against. */
  readonly port: Port;
  /** How long a change waits for another process's change before failing as `unavailable`. 2000 when left out. */
  readonly lockWaitMs?: number;
}

export interface Store<W> {
  /** The world as it stands. A file that isn't JSON, or breaks the schema, is `invalid`. */
  read(): W;
  /** Applies `fn` to the world, keeps the result in the state file, and returns what `fn` returned. */
  change<T>(fn: (world: W) => T): T;
}

/** The pid that holds `lock`, or undefined when there is no lock or it names no pid. */
function holderOf(lock: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(lock, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Creates `file` holding this process's pid, by linking a written file to it so it never holds a partial pid. */
function create(file: string): boolean {
  const mine = `${file}.${process.pid}`;
  writeFileSync(mine, `${process.pid}\n`);
  try {
    linkSync(mine, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    rmSync(mine, { force: true });
  }
}

/**
 * Takes `lock` for this process. False when another process holds it. A lock whose holder has died is removed, and the
 * caller tries again. Only the process holding `<lock>.break` removes one, after checking the lock still names the dead
 * pid, so a live writer's lock is never moved or removed. A breaker left by a process that died breaking stays, and the
 * changes that find a dead holder fail as `unavailable` until it is removed by hand.
 */
function tryLock(lock: string): boolean {
  if (create(lock)) return true;
  const dead = holderOf(lock);
  if (dead === undefined || isAlive(dead)) return false;
  const breaker = `${lock}.break`;
  if (!create(breaker)) return false;
  try {
    // While this process holds the breaker the lock can't change: its holder is dead, no other process may break it,
    // and a new lock is only made where there is none.
    if (holderOf(lock) === dead) rmSync(lock, { force: true });
  } finally {
    rmSync(breaker, { force: true });
  }
  return false;
}

export function createStore<W>({ seed, state, schema, port, lockWaitMs }: StoreOptions<W>): Store<W> {
  const read = (): W => {
    const file = existsSync(state) ? state : seed;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new PortError(port, 'read', 'invalid', `${file}: ${(error as Error).message}`);
    }
    const result = schema.safeParse(data);
    if (!result.success) {
      const [issue] = result.error.issues;
      throw new PortError(port, 'read', 'invalid', `${file}: ${issue?.path.join('.')} ${issue?.message}`);
    }
    return result.data;
  };
  return {
    read,
    change(fn) {
      mkdirSync(dirname(state), { recursive: true });
      const lock = `${state}.lock`;
      const deadline = Date.now() + (lockWaitMs ?? 2000);
      while (!tryLock(lock)) {
        if (Date.now() >= deadline) {
          throw new PortError(port, 'change', 'unavailable', `${lock} is held by pid ${holderOf(lock)}`);
        }
        Bun.sleepSync(2);
      }
      try {
        const world = read();
        const result = fn(world);
        replaceFile(state, `${JSON.stringify(world, null, 2)}\n`);
        return result;
      } finally {
        rmSync(lock, { force: true });
      }
    },
  };
}
