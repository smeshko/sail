// The watcher's command inbox: `.sail-runs/watcher/commands/`, where anything other than the watcher asks it for a
// change by dropping a command file. The watcher stays the only writer of its own state (ADR-0019).
//
// - A command is applied, then deleted. A crash between the two applies it again at the next drain, so every command
//   is safe to apply twice: a poll, a `watch` or `unwatch` of workflows already in or out of the set, an `add` of a
//   ticket already queued, a `requeue` of an item already queued, a `drop` of an item already gone, and a `move` of an
//   item already next to its target. An apply that returns a promise is awaited before its file is deleted, so a
//   `watch` has opened its workflows by then.
// - A watcher empties its inbox as it starts (`clearCommands`): a command a stopped watcher left never changes a watch
//   set nobody asked for.
// - A command is written to a dot-prefixed temp file and renamed into place, so a drain never reads half of one: the
//   drain skips dot-files.
// - A file that isn't a command, or whose apply throws, is deleted and reported, so it can't wedge the inbox. So is
//   anything in the inbox that isn't a plain file, as a directory or a link, and a file that can't be read. A file gone
//   before it is read is passed over: there is nothing left to apply. One that can't be deleted is reported, and the
//   drain goes on. A command applied but not deleted isn't applied again by this process, only deleted when it can be.
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const COMMANDS_DIR = join('watcher', 'commands');

/** Where command files are dropped under `.sail-runs/`. */
export function commandsDir(runsDir: string): string {
  return join(runsDir, COMMANDS_DIR);
}

/** A workflow's name, as a folder under `.sail/workflows/` takes it. */
const Workflows = z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)).min(1);

export const Command = z.discriminatedUnion('op', [
  /** Polls the workflow now, paused or not. */
  z.strictObject({ op: z.literal('poll'), workflow: z.string().min(1) }),
  /** Adds the workflows to the watch set. */
  z.strictObject({ op: z.literal('watch'), workflows: Workflows }),
  /** Takes the workflows out of the watch set. */
  z.strictObject({ op: z.literal('unwatch'), workflows: Workflows }),
  /** Queues a ticket in a watched workflow's queue, forced or not. */
  z.strictObject({
    op: z.literal('add'),
    workflow: z.string().min(1),
    ticketKey: z.string().min(1),
    force: z.literal(true).optional(),
  }),
  /** Puts a parked or failed item back in the queue. */
  z.strictObject({ op: z.literal('requeue'), workflow: z.string().min(1), dedupKey: z.string().min(1) }),
  /** Takes an item out of the queue. */
  z.strictObject({ op: z.literal('drop'), workflow: z.string().min(1), dedupKey: z.string().min(1) }),
  /** Puts a queued item directly before or after another queued one: exactly one of `before` and `after`. */
  z
    .strictObject({
      op: z.literal('move'),
      workflow: z.string().min(1),
      dedupKey: z.string().min(1),
      before: z.string().min(1).optional(),
      after: z.string().min(1).optional(),
    })
    .refine((move) => (move.before === undefined) !== (move.after === undefined), {
      message: 'needs exactly one of before and after',
      path: ['after'],
    }),
]);
export type Command = z.infer<typeof Command>;

/** Commands this process dropped, so two in one millisecond still sort in the order they were dropped. */
let dropped = 0;

/**
 * Command files this process applied and couldn't remove, so a later drain removes them without applying them again. A
 * restart forgets them, and applies them again, as it does a command a crash left.
 */
const kept = new Set<string>();

/**
 * Drops `command` in the inbox, and gives its file: `<UTC time>-<pid>-<count>-<random>.json`, so names sort by when
 * they were dropped.
 */
export function dropCommand(runsDir: string, command: Command): string {
  const dir = commandsDir(runsDir);
  mkdirSync(dir, { recursive: true });
  dropped += 1;
  const time = new Date().toISOString().replace(/[-:.]/g, '').replace('Z', '');
  const random = Math.random().toString(16).slice(2, 10);
  const name = `${time}-${process.pid}-${String(dropped).padStart(9, '0')}-${random}`;
  const tmp = join(dir, `.${name}.tmp`);
  const file = join(dir, `${name}.json`);
  writeFileSync(tmp, `${JSON.stringify(command)}\n`);
  renameSync(tmp, file);
  return file;
}

export interface Drained {
  /** How many commands were applied. */
  applied: number;
  /** The files that weren't applied, or couldn't be removed, with why. Each is removed when it can be. */
  rejected: { file: string; reason: string }[];
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Why the command file `name` is no command, or the command, or undefined when it is already gone. */
function readCommand(dir: string, entry: Dirent): Command | { reason: string } | undefined {
  const { name } = entry;
  if (!entry.isFile()) return { reason: `${name} is not a file` };
  let text: string;
  try {
    text = readFileSync(join(dir, name), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return { reason: `${name} can't be read: ${messageOf(error)}` };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { reason: `${name} is not JSON: ${messageOf(error)}` };
  }
  const parsed = Command.safeParse(data);
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  return { reason: `${name} is not a command: ${[issue?.path.join('.'), issue?.message].filter(Boolean).join(' ')}` };
}

/**
 * Applies each command in the inbox, oldest first, deleting each once it is applied or rejected. An apply that returns
 * a promise is awaited first.
 */
export async function drainCommands(runsDir: string, apply: (command: Command) => unknown): Promise<Drained> {
  const dir = commandsDir(runsDir);
  const drained: Drained = { applied: 0, rejected: [] };
  if (!existsSync(dir)) return drained;
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter(({ name }) => !name.startsWith('.') && name.endsWith('.json'))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const { name } = entry;
    const file = join(dir, name);
    const command = readCommand(dir, entry);
    if (command === undefined) continue;
    let reason: string | undefined;
    if ('reason' in command) {
      reason = command.reason;
    } else if (kept.has(file)) {
      // Applied by an earlier drain that couldn't remove it: only the removal is left to do.
    } else {
      try {
        await apply(command);
        drained.applied += 1;
      } catch (error) {
        reason = `${name} failed: ${messageOf(error)}`;
      }
    }
    try {
      rmSync(file, { recursive: true, force: true });
      kept.delete(file);
    } catch (error) {
      if (reason === undefined) kept.add(file);
      reason = `${reason ?? `${name} was applied`}, and it can't be removed: ${messageOf(error)}`;
    }
    if (reason !== undefined) drained.rejected.push({ file, reason });
  }
  return drained;
}

/** Deletes every file in the inbox, temp files included, unapplied, and gives how many it deleted. */
export function clearCommands(runsDir: string): number {
  const dir = commandsDir(runsDir);
  if (!existsSync(dir)) return 0;
  const names = readdirSync(dir);
  for (const name of names) rmSync(join(dir, name), { recursive: true, force: true });
  return names.length;
}
