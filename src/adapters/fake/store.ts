// A file-backed fake's world (D1): read from a committed seed until the first change, which copies the world into a
// separate state file. Every later read and change uses the state file, so a change made in one process is seen in the
// next. The seed is never written, so running the fixture repository in place leaves git clean.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { z } from 'zod';
import type { Port } from '../../engine/config';
import { replaceFile } from '../../engine/durable';
import { PortError } from '../../ports/errors';

export interface StoreOptions<W> {
  /** The committed world. Never written. */
  readonly seed: string;
  /** Where the world's changes are kept. Read instead of `seed` once it exists. */
  readonly state: string;
  readonly schema: z.ZodType<W>;
  /** The port a broken file is reported against. */
  readonly port: Port;
}

export interface Store<W> {
  /** The world as it stands. A file that isn't JSON, or breaks the schema, is `invalid`. */
  read(): W;
  /** Applies `fn` to the world, keeps the result in the state file, and returns what `fn` returned. */
  change<T>(fn: (world: W) => T): T;
}

export function createStore<W>({ seed, state, schema, port }: StoreOptions<W>): Store<W> {
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
      const world = read();
      const result = fn(world);
      mkdirSync(dirname(state), { recursive: true });
      replaceFile(state, `${JSON.stringify(world, null, 2)}\n`);
      return result;
    },
  };
}
