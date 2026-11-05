// macOS's `security` program, run on an environment's PATH: the keychain items sail reads, the Codex login and the
// credential sources among them.

import type { Env } from '../ports/adapter';

export interface SecurityEnd {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs macOS's `security` with `args`. */
export type Security = (args: readonly string[]) => Promise<SecurityEnd>;

/** The `security` on `env`'s PATH. */
export function systemSecurity(env: Env): Security {
  return async (args) => {
    const child = Bun.spawn(['security', ...args], {
      env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  };
}

/** `security`'s exit code for an item the keychain doesn't hold. */
export const NOT_FOUND = 44;
