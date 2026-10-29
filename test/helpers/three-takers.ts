import { spyOn } from 'bun:test';
import * as fs from 'node:fs';

/** B reads stale, A wins, then C runs inside B's drop (never inside A's).
 * Prefer the destructive rename/unlink window if an implementation has one;
 * otherwise run C at the protected recheck, where A must still be visible.
 */
export function threeTakers<T>(file: string, takeA: () => T, takeB: () => T, takeC: () => T) {
  const read = fs.readFileSync;
  const rename = fs.renameSync;
  const rm = fs.rmSync;
  let phase: 'initial' | 'a' | 'b' | 'c' | 'done' = 'initial';
  let a: T | undefined;
  let c: T | undefined;
  let protectedRecheck = false;
  const runC = () => {
    phase = 'c';
    c = takeC();
    phase = 'done';
  };
  const readHook = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    const text = read(...args);
    if (args[0] === file) {
      if (phase === 'initial') {
        phase = 'a';
        a = takeA();
        phase = 'b';
      } else if (phase === 'b' && fs.existsSync(`${file}.drop`)) {
        protectedRecheck = true;
        runC();
      }
    }
    return text;
  }) as typeof fs.readFileSync);
  const renameHook = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    rename(from, to);
    if (from === file && phase === 'b') runC();
  });
  const rmHook = spyOn(fs, 'rmSync').mockImplementation((path, options) => {
    rm(path, options);
    if (path === file && phase === 'b') runC();
  });
  try {
    const b = takeB();
    return { a, b, c, protectedRecheck };
  } finally {
    readHook.mockRestore();
    renameHook.mockRestore();
    rmHook.mockRestore();
  }
}
