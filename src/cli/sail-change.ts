// The running sail's code version, and a timer that reports when its code changes. A login service reads it at start
// and every minute, and stops itself, exiting 6, once it differs over `src/`, `package.json` or `bun.lock`, so launchd
// starts the new code. A version change the filter can't judge counts as a code change.
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

/** The paths whose change is a change of sail's code. */
export const CODE_PATHS = ['src', 'package.json', 'bun.lock'] as const;

/** Whether two code versions differ in sail's code. */
export type CodeChanged = (before: string, after: string) => Promise<boolean> | boolean;

/** The environment for a git spawn in a package root: the caller's, less what points git at another repository. */
function gitEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const spawnEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !LOCATION.includes(key)) spawnEnv[key] = value;
  }
  return spawnEnv;
}

/** Reads sail's code version: undefined when it can't be read now. */
export type ReadVersion = () => Promise<string | undefined> | string | undefined;

/** The code version of the package at `root`, or undefined when the read fails. */
export async function sailVersion(
  root: string = PACKAGE_ROOT,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string | undefined> {
  try {
    if (existsSync(join(root, '.git'))) {
      const git = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
        cwd: root,
        env: gitEnv(env),
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

/**
 * Whether the commits between two versions touch `CODE_PATHS`. What it can't judge counts as a change: a version that
 * is no commit id, a root with no `.git`, a git failure or a timeout.
 */
export async function sailCodeChanged(
  before: string,
  after: string,
  root: string = PACKAGE_ROOT,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<boolean> {
  const sha = /^[0-9a-f]{40}$/;
  if (!sha.test(before) || !sha.test(after) || !existsSync(join(root, '.git'))) return true;
  try {
    const git = Bun.spawn(['git', 'diff', '--quiet', before, after, '--', ...CODE_PATHS], {
      cwd: root,
      env: gitEnv(env),
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: 10_000,
    });
    return (await git.exited) !== 0;
  } catch {
    return true;
  }
}

export interface ChangeWatch {
  read: ReadVersion;
  everyMs: number;
  timers: Timers;
  /** Whether a new version is a change worth reporting: every change when left out. */
  changed?: CodeChanged;
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
  let ignored: string | undefined;
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
      else if (now !== first && now !== ignored) {
        let changed = true;
        if (options.changed) {
          try {
            changed = await options.changed(first, now);
          } catch {
            changed = true;
          }
          if (stopped) return;
        }
        if (changed) {
          stopped = true;
          options.onChange(first, now);
          return;
        }
        ignored = now;
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
