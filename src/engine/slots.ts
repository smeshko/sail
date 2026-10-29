// Machine-wide exclusive slots: one pid-held file per name in `~/.sail/slots/`. The shared primitive serialises
// removals under drop tokens. A slot is stale only once its holder's pid is dead, never on a timer.
// Accepted risks: a reused pid reads as alive; a SIGKILL frees the slot while its script's process group may live on.
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { dropRecord, type PidFileKind, readRecord, takeRecord } from './pid-file';
import { isAlive } from './process';

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

const slotKind: PidFileKind<Slot> = {
  schema: Slot,
  error: (_, message) => new SlotError(message),
  tag: (slot) => slot.runId,
};

/** Where slots live unless a caller names a directory. Computed per call, so importing this reads nothing. */
export function defaultSlotsDir(): string {
  return join(homedir(), '.sail', 'slots');
}

export function slotFile(dir: string, name: string): string {
  return join(dir, `${name}.json`);
}

/** The slot `name`, or undefined when there is none. A file that isn't a slot throws a `SlotError` naming it. */
export function readSlot(dir: string, name: string): Slot | undefined {
  return readRecord(slotFile(dir, name), slotKind);
}

/** Whether `slot`'s holder is gone: its pid is dead. */
export function isStaleSlot(slot: Slot): boolean {
  return !isAlive(slot.pid);
}

/** Gives a free or stale slot to `holder`, with `took` naming the replaced run. Live holders are refused. */
export function takeSlot(dir: string, name: string, holder: SlotHolder, now = new Date()): SlotResult {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw new SlotError(`${dir}: ${(error as Error).message}`);
  }
  const file = slotFile(dir, name);
  const slot: Slot = { name, ...holder, takenAt: now.toISOString() };
  const result = takeRecord(file, slot, slotKind, (held) => !isStaleSlot(held));
  if (result.taken) return result.took ? { taken: true, slot, took: result.took.runId } : { taken: true, slot };
  if ('holder' in result) return { taken: false, holder: result.holder };
  throw new SlotContended(`${file}: the slot kept changing hands`);
}

/** Removes slot `name`, only while it still names `holder`'s run, key and pid. True when it was removed. */
export function releaseSlot(dir: string, name: string, holder: SlotHolder): boolean {
  const file = slotFile(dir, name);
  const held = readRecord(file, slotKind);
  if (held === undefined || held.runId !== holder.runId || held.key !== holder.key || held.pid !== holder.pid) {
    return false;
  }
  return dropRecord(file, held, slotKind);
}
