// Which directories a durable write syncs. An fsync leaves no trace on disk, so this watches `syncDir` open each one:
// nothing else in `src/engine/durable.ts` opens a path for reading.
import { spyOn } from 'bun:test';
import * as fs from 'node:fs';

/** Runs `write`, and returns every directory it synced, in order. */
export function syncedDirs(write: () => void): string[] {
  const open = spyOn(fs, 'openSync');
  try {
    write();
    return open.mock.calls.filter(([, flags]) => flags === 'r').map(([path]) => String(path));
  } finally {
    open.mockRestore();
  }
}
