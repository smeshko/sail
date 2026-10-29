// Records are created whole by exclusive links. Every removal rechecks the record under its per-name drop token,
// so an overtaken release or takeover never discards a new holder. Dead tokens are broken under deeper tokens,
// bounded to four levels. Accepted risk: a reused pid reads as alive until that process ends.
import { randomUUID } from 'node:crypto';
import { linkSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { isAlive } from './process';

export interface PidFileKind<T> {
  schema: z.ZodType<T>;
  error(kind: 'invalid' | 'unavailable', message: string): Error;
  tag(record: T): string;
}
export interface TakeOptions {
  waitMs?: number;
}
export type TakeResult<T> = { taken: true; took?: T } | { taken: false; holder: T } | { taken: false; contended: true };

export function readRecord<T>(file: string, kind: PidFileKind<T>): T | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw kind.error('unavailable', `${file}: ${(error as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw kind.error('invalid', `${file}: ${(error as Error).message}`);
  }
  const parsed = kind.schema.safeParse(data);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    throw kind.error('invalid', `${file}: ${issue?.path.join('.')} ${issue?.message}`);
  }
  return parsed.data;
}

function create<T>(file: string, record: T, kind: PidFileKind<T>): boolean {
  const tmp = `${file}.${kind.tag(record)}.${process.pid}.tmp`;
  try {
    try {
      writeFileSync(tmp, `${JSON.stringify(record)}\n`);
    } catch (error) {
      throw kind.error('unavailable', `${tmp}: ${(error as Error).message}`);
    }
    try {
      linkSync(tmp, file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw kind.error('unavailable', `${file}: ${(error as Error).message}`);
    }
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Cleanup must neither hide an error in flight nor misreport a successful create.
    }
  }
}

function remove<T>(file: string, kind: PidFileKind<T>): void {
  try {
    rmSync(file);
  } catch (error) {
    throw kind.error('unavailable', `${file}: ${(error as Error).message}`);
  }
}

const DropToken = z.object({ pid: z.number().int().positive(), nonce: z.string().min(1) });

function dropIfStill<T>(file: string, read: T, kind: PidFileKind<T>, options: TakeOptions, depth: number): boolean {
  if (depth >= 4) return false;
  const tokenFile = `${file}.drop`;
  const token = { pid: process.pid, nonce: randomUUID() };
  const tokenKind: PidFileKind<z.infer<typeof DropToken>> = {
    schema: DropToken,
    error: kind.error,
    tag: (held) => held.nonce,
  };
  const deadline = Date.now() + (options.waitMs ?? 2000);
  while (!create(tokenFile, token, tokenKind)) {
    const held = readRecord(tokenFile, tokenKind);
    if (held !== undefined && !isAlive(held.pid)) {
      if (dropIfStill(tokenFile, held, tokenKind, options, depth + 1)) continue;
    }
    if (Date.now() >= deadline) return false;
    Bun.sleepSync(1);
  }
  try {
    const current = readRecord(file, kind);
    if (current === undefined || JSON.stringify(current) !== JSON.stringify(read)) return false;
    remove(file, kind);
    return true;
  } finally {
    const held = readRecord(tokenFile, tokenKind);
    if (held?.nonce === token.nonce) remove(tokenFile, tokenKind);
  }
}

export function dropRecord<T>(file: string, read: T, kind: PidFileKind<T>, options: TakeOptions = {}): boolean {
  return dropIfStill(file, read, kind, options, 0);
}

export function takeRecord<T>(
  file: string,
  record: T,
  kind: PidFileKind<T>,
  blocks: (held: T) => boolean,
  options: TakeOptions = {},
): TakeResult<T> {
  for (let round = 0; round < 2; round++) {
    const held = readRecord(file, kind);
    if (held === undefined) {
      if (create(file, record, kind)) return { taken: true };
      continue;
    }
    if (blocks(held)) return { taken: false, holder: held };
    if (dropRecord(file, held, kind, options) && create(file, record, kind)) return { taken: true, took: held };
  }
  const current = readRecord(file, kind);
  if (current !== undefined && blocks(current)) return { taken: false, holder: current };
  return { taken: false, contended: true };
}
