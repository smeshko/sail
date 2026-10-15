// `sail watch <workflow>...` and `sail unwatch <workflow>...`: the watch set of this repository's watcher (ADR-0019).
//
// | | No live watcher here | A live watcher here |
// |---|---|---|
// | `sail watch` | starts the watcher in the foreground, watching the workflows named | hands it a `watch` command, waits for it, and prints the set |
// | `sail unwatch` | refused: nothing to unwatch | hands it an `unwatch` command, waits for it, and prints the set, or that the watcher stops |
//
// A live watcher is one the registry records for this repository's `name` with a pid that is alive. One recorded for
// the same `name` in another clone refuses both commands. Every refusal is exit code 3: no `.sail/project.yaml`, no
// names, a name that isn't a watched workflow, two workflows on one label (the live set's included), or a live watcher
// in the way, named with its clone and pid.
//
// The watcher runs until its set empties, or until Ctrl-C or SIGTERM, and exits 0 either way. Its runs carry on.
//
// A second command waits up to 15 s for the watcher to take its command. One it hasn't taken by then stays in the
// inbox, which a watcher stopped meanwhile empties at its next start, and the command exits 0 saying so. The set it
// prints is read back from the queue event streams: each workflow whose last `watch:*` event is `watch:added` with the
// live watcher's pid.
import type { Timers } from '../../watch/poll';
import type { IsAlive } from '../../watch/registry';
import type { SpawnedRun, SpawnRunOptions } from '../../watch/spawn';
import { EXIT_OK } from '../exit-codes';
import type { Command } from '../index';

/** What the commands run on: the system's unless a test hands its own. */
export interface WatchDeps {
  timers?: Timers;
  now?: () => Date;
  spawn?: (options: SpawnRunOptions) => SpawnedRun;
  isAlive?: IsAlive;
  tickMs?: number;
  /** How long a second command waits for the watcher to take its command. */
  applyTimeoutMs?: number;
  /** How often it looks. */
  pollMs?: number;
  /** The pid a watcher this command starts records itself under. */
  pid?: number;
}

/** `sail watch`, on `deps`. */
export function watchCommand(_deps: WatchDeps = {}): Command {
  return () => EXIT_OK;
}

/** `sail unwatch`, on `deps`. */
export function unwatchCommand(_deps: WatchDeps = {}): Command {
  return () => EXIT_OK;
}

export const watch = watchCommand();
export const unwatch = unwatchCommand();
