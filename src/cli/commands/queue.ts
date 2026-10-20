// `sail queue ls|add|requeue|drop|poll <workflow>`. Stub: every op is refused.
import { EXIT_REFUSED } from '../exit-codes';
import type { Command } from '../index';
import type { WatchDeps } from './watch';

/** `sail queue`, on `deps`. */
export function queueCommand(_deps: WatchDeps = {}): Command {
  return () => EXIT_REFUSED;
}

export const queue = queueCommand();
