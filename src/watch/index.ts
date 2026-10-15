// The watcher's composition surface: what `sail watch` puts together.
export { createDispatcher } from './dispatch';
export { clearCommands, drainCommands, dropCommand } from './inbox';
export { formatLines } from './lines';
export { createPoller, openWatchTarget, readWatch } from './poll';
export { openQueue } from './queue-store';
export { spawnRun } from './spawn';
export { holderRefusal, startWatcher } from './watcher';
