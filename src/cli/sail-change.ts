// The running sail's code version, and a timer that reports when it changes. A login service reads it at start and
// every minute, and stops itself, exiting 6, once it differs, so launchd starts the new code.
//
// The version is the checkout's `HEAD`: `git rev-parse HEAD` in the package root when it holds a `.git`. A packed
// install has none, so its version is a hash of `package.json`'s text and the SDK's declarations.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sdkFingerprint } from '../engine/sdk-version';
import { PACKAGE_ROOT } from '../engine/typecheck';
import type { Timers } from '../watch/poll';

const LOCATION = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'];

/** Reads sail's code version: undefined when it can't be read now. */
export type ReadVersion = () => Promise<string | undefined> | string | undefined;

/** The code version of the package at `root`, or undefined when the read fails. */
export async function sailVersion(
  root: string = PACKAGE_ROOT,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string | undefined> {
  try {
    if (existsSync(join(root, '.git'))) {
      const spawnEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(env)) {
        if (value !== undefined && !LOCATION.includes(key)) spawnEnv[key] = value;
      }
      const git = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
        cwd: root,
        env: spawnEnv,
        stdout: 'pipe',
        stderr: 'ignore',
        timeout: 10_000,
      });
      const [out, code] = await Promise.all([new Response(git.stdout).text(), git.exited]);
      const sha = out.trim();
      return code === 0 && sha !== '' ? sha : undefined;
    }
    return createHash('sha256')
      .update(readFileSync(join(root, 'package.json'), 'utf8'))
      .update('\0')
      .update(sdkFingerprint(join(root, 'types')))
      .digest('hex');
  } catch {
    return undefined;
  }
}

export interface ChangeWatch {
  read: ReadVersion;
  everyMs: number;
  timers: Timers;
  /** Called once, with the version it started on and the one it found. */
  onChange(before: string, after: string): void;
}

/**
 * Reads the version at once and again every `everyMs`; calls `onChange` once when it differs from the first. A read
 * that fails keeps the last version. Returns the function that stops it.
 */
export function watchSailChange(options: ChangeWatch): () => void {
  let stopped = false;
  let handle: unknown;
  let first: string | undefined;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    let now: string | undefined;
    try {
      now = await options.read();
    } catch {
      now = undefined;
    }
    if (stopped) return;
    if (now !== undefined) {
      if (first === undefined) first = now;
      else if (now !== first) {
        stopped = true;
        options.onChange(first, now);
        return;
      }
    }
    handle = options.timers.set(tick, options.everyMs);
  };
  void tick();
  return () => {
    stopped = true;
    if (handle !== undefined) options.timers.clear(handle);
  };
}
