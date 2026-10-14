// The watcher's composition surface: what `sail watch` (13.2) puts together.
export { drainCommands, dropCommand } from './inbox';
export { createPoller, openWatchTarget } from './poll';
export { openQueue } from './queue-store';
