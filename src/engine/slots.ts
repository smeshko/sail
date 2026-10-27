// Machine-wide exclusive slots: one file per slot name in `~/.sail/slots/`, so a heavy script step runs only while no
// other step on the machine holds its name. A slot is stale only once its holder's pid is dead, never on a timer.
//
// Two accepted risks, as with branch leases: a reused pid makes a dead holder read as alive, so a waiter waits until that
// process ends; and a holder killed with SIGKILL frees its slot at once while its script's process group may still be
// running, so two scripts can overlap for a while.
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { isAlive } from '../adapters/leases';

export const SlotHolder = z.object({
  runId: z.string().min(1),
  key: z.string().min(1),
  runDir: z.string().min(1),
  pid: z.number().int().positive(),
});
export type SlotHolder = z.infer<typeof SlotHolder>;

export const Slot = SlotHolder.extend({ name: z.string().min(1), takenAt: z.string().min(1) });
export type Slot = z.infer<typeof Slot>;

export type SlotResult = { taken: true; slot: Slot; took?: string } | { taken: false; holder: Slot };

/** A slot file that can't be read or isn't a slot; the message names the file. */
export class SlotError extends Error {}

/** A slot that kept changing hands while it was being taken: contention, so taking it again later may succeed. */
export class SlotContended extends SlotError {}

/** Where slots live unless a caller names a directory. Computed per call, so importing this reads nothing. */
export function defaultSlotsDir(): string {
  return join(homedir(), '.sail', 'slots');
}

export function slotFile(dir: string, name: string): string {
  return join(dir, `${name}.json`);
}

const unavailable = (path: string, error: unknown): SlotError => new SlotError(`${path}: ${(error as Error).message}`);

function readFile(file: string): Slot | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw unavailable(file, error);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw unavailable(file, error);
  }
  const result = Slot.safeParse(data);
  if (!result.success) {
    const [issue] = result.error.issues;
    throw new SlotError(`${file}: ${issue?.path.join('.')} ${issue?.message}`);
  }
  return result.data;
}

/** The slot `name`, or undefined when there is none. A file that isn't a slot throws a `SlotError` naming it. */
export function readSlot(dir: string, name: string): Slot | undefined {
  return readFile(slotFile(dir, name));
}

/** Whether `slot`'s holder is gone: its pid is dead. */
export function isStaleSlot(slot: Slot): boolean {
  return !isAlive(slot.pid);
}

/** Creates `file` holding `slot` all at once, by linking a written temp file to it. False when `file` exists. */
function create(file: string, slot: Slot): boolean {
  const tmp = `${file}.${slot.runId}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(slot)}\n`);
  } catch (error) {
    throw unavailable(tmp, error);
  }
  try {
    linkSync(tmp, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw unavailable(file, error);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Drops the slot in `file` when it is still `read`: moves it aside under a name only this process uses, then checks that
 * what moved is that slot and not one another taker has just written in its place, which is put back.
 */
function dropIfStill(file: string, read: Slot, runId: string): boolean {
  const aside = `${file}.${runId}.${process.pid}.aside`;
  try {
    renameSync(file, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw unavailable(file, error);
  }
  const moved = readFile(aside);
  const same = moved !== undefined && JSON.stringify(moved) === JSON.stringify(read);
  if (!same) {
    try {
      linkSync(aside, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unavailable(file, error);
    }
  }
  rmSync(aside, { force: true });
  return same;
}

/**
 * Gives slot `name` to `holder`: a new slot, or a stale one taken over, with `took` naming the run it replaced. A slot a
 * live holder has is refused, naming it. A takeover replaces only the slot it read.
 */
export function takeSlot(dir: string, name: string, holder: SlotHolder, now = new Date()): SlotResult {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw unavailable(dir, error);
  }
  const file = slotFile(dir, name);
  const slot: Slot = { name, ...holder, takenAt: now.toISOString() };
  // A second round only follows another taker winning a step of the first.
  for (let round = 0; round < 2; round++) {
    const held = readFile(file);
    if (held === undefined) {
      if (create(file, slot)) return { taken: true, slot };
      continue;
    }
    if (!isStaleSlot(held)) return { taken: false, holder: held };
    if (dropIfStill(file, held, holder.runId) && create(file, slot)) return { taken: true, slot, took: held.runId };
  }
  const current = readFile(file);
  if (current !== undefined) return { taken: false, holder: current };
  throw new SlotContended(`${file}: the slot kept changing hands`);
}

/** Removes slot `name`, only while it still names `holder`'s run, key and pid. True when it was removed. */
export function releaseSlot(dir: string, name: string, holder: SlotHolder): boolean {
  const file = slotFile(dir, name);
  const held = readFile(file);
  if (held === undefined || held.runId !== holder.runId || held.key !== holder.key || held.pid !== holder.pid) {
    return false;
  }
  return dropIfStill(file, held, holder.runId);
}
