// The watcher's command inbox: `.sail-runs/watcher/commands/`, where anything other than the watcher asks it for a
// change by dropping a command file. Stubbed for queue-store-and-polling: TASK-004 writes it.
import { join } from 'node:path';
import { z } from 'zod';

export const COMMANDS_DIR = join('watcher', 'commands');

/** Where command files are dropped under `.sail-runs/`. */
export function commandsDir(runsDir: string): string {
  return join(runsDir, COMMANDS_DIR);
}

export const Command = z.discriminatedUnion('op', [
  /** Polls the workflow now, paused or not. */
  z.strictObject({ op: z.literal('poll'), workflow: z.string().min(1) }),
]);
export type Command = z.infer<typeof Command>;

/** Drops `command` in the inbox, and gives its file. */
export function dropCommand(runsDir: string, _command: Command): string {
  return join(commandsDir(runsDir), 'stub.json');
}

export interface Drained {
  /** How many commands were applied. */
  applied: number;
  /** The files that weren't, each deleted, with why. */
  rejected: { file: string; reason: string }[];
}

/** Applies each command in the inbox, oldest first, deleting each once it is applied or rejected. */
export function drainCommands(_runsDir: string, _apply: (command: Command) => void): Drained {
  return { applied: 0, rejected: [] };
}
