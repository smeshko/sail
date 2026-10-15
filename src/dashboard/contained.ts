// The dashboard's containment checks: whether a path lies inside a directory once both are resolved through every
// symlink. Run files and queue files are both read only through these, so nothing outside a registered clone's
// `.sail-runs/` is ever opened.
import { realpathSync, statSync } from 'node:fs';
import { sep } from 'node:path';

/** Whether `path` lies inside `dir`, both resolved through every symlink. A path that doesn't exist doesn't. */
export function inside(dir: string, path: string): boolean {
  try {
    const root = realpathSync(dir);
    const real = realpathSync(path);
    return real.startsWith(`${root}${sep}`);
  } catch {
    return false;
  }
}

/**
 * The real path of `path` when it is a regular file inside `dir`, both resolved through every symlink, or undefined. A
 * FIFO, a device or a directory a step left isn't one, so reading it can't block or fail.
 */
export function containedFile(dir: string, path: string): string | undefined {
  try {
    const real = realpathSync(path);
    return real.startsWith(`${realpathSync(dir)}${sep}`) && statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}
