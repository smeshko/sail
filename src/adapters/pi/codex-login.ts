// The Codex login: a ChatGPT subscription's OAuth tokens, which pi's `openai-codex` provider runs on. `sail login codex`
// writes them to sail's own item in the macOS keychain, apart from the Codex CLI's and pi's logins, and an `openai-codex`
// session reads them back through this credential store. pi refreshes the access token when it has under five minutes
// left, inside the store's `modify`. A refresh token is good for one refresh, so `modify` holds a lock file every sail
// process waits on, and the new pair is in the keychain before the lock is let go.

import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import type { Credential, CredentialStore } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { isAlive } from '../../engine/process';
import type { Env } from '../../ports/adapter';

/** The pi provider a Codex login is the credential of. */
export const CODEX_PROVIDER = 'openai-codex';

/** The keychain item's service: the account is the user's. */
export const KEYCHAIN_SERVICE = 'sail-openai-codex';

const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 100;

export const NO_LOGIN = 'no Codex login in the keychain: run sail login codex';

/** pi's OAuth credential, as the keychain item holds it. */
const OAuthCredential = z.looseObject({
  type: z.literal('oauth'),
  access: z.string().min(1),
  refresh: z.string().min(1),
  expires: z.number(),
});

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
const NOT_FOUND = 44;

export interface LockOptions {
  readonly waitMs?: number;
  readonly pollMs?: number;
}

/**
 * Runs `fn` holding the lock `file`, which names its holder's pid. The file appears whole, linked from a temp file, so a
 * waiter never reads it half written. A lock whose pid is dead is removed and taken; one a live process holds past
 * `waitMs` is refused, naming it.
 */
export async function withLock<T>(file: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}`;
  writeFileSync(temp, `${process.pid}\n`, { mode: 0o600 });
  const deadline = Date.now() + (options.waitMs ?? LOCK_WAIT_MS);
  try {
    for (;;) {
      try {
        linkSync(temp, file);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const holder = holderOf(file);
      if (holder !== undefined && !isAlive(holder)) {
        rmSync(file, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`the Codex login stayed locked by pid ${holder ?? '?'}: ${file}`);
      await Bun.sleep(options.pollMs ?? LOCK_POLL_MS);
    }
  } finally {
    rmSync(temp, { force: true });
  }
  try {
    return await fn();
  } finally {
    rmSync(file, { force: true });
  }
}

/** The pid in lock `file`, or undefined when it is gone or holds none. */
function holderOf(file: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export interface KeychainStoreOptions {
  readonly account: string;
  readonly security: Security;
  readonly lockFile: string;
  readonly lock?: LockOptions;
}

/**
 * pi's credential store over the keychain item `KEYCHAIN_SERVICE` of `account`, holding the `openai-codex` login and
 * nothing else. The item is written with `-w` on `security`'s command line: its interactive mode cuts a line at 4096
 * bytes, shorter than a login. Only the user's own processes can read that, and they can read the item too.
 */
export function keychainStore(options: KeychainStoreOptions): CredentialStore {
  const { account, security } = options;
  const refused = (end: SecurityEnd) => new Error(`the keychain refused the Codex login: ${end.stderr.trim()}`);
  const only = (providerId: string) => {
    if (providerId !== CODEX_PROVIDER) throw new Error(`the keychain holds the Codex login, not ${providerId}'s`);
  };
  async function read(): Promise<Credential | undefined> {
    const end = await security(['find-generic-password', '-a', account, '-s', KEYCHAIN_SERVICE, '-w']);
    if (end.exitCode === NOT_FOUND) return undefined;
    if (end.exitCode !== 0) throw refused(end);
    let parsed: unknown;
    try {
      parsed = JSON.parse(end.stdout.trim());
    } catch {
      parsed = undefined;
    }
    const credential = OAuthCredential.safeParse(parsed);
    if (!credential.success) {
      throw new Error(`the keychain's ${KEYCHAIN_SERVICE} item is not a Codex login: run sail login codex`);
    }
    return credential.data;
  }
  async function write(credential: Credential): Promise<void> {
    const end = await security([
      'add-generic-password',
      '-U',
      '-a',
      account,
      '-s',
      KEYCHAIN_SERVICE,
      '-l',
      'sail: Codex login',
      '-w',
      JSON.stringify(credential),
    ]);
    if (end.exitCode !== 0) throw refused(end);
  }
  return {
    async read(providerId) {
      return providerId === CODEX_PROVIDER ? read() : undefined;
    },
    async list() {
      const held = await read();
      return held === undefined ? [] : [{ providerId: CODEX_PROVIDER, type: held.type }];
    },
    async modify(providerId, fn) {
      only(providerId);
      return withLock(
        options.lockFile,
        async () => {
          const current = await read();
          const next = await fn(current);
          if (next === undefined) return current;
          await write(next);
          return next;
        },
        options.lock,
      );
    },
    async delete(providerId) {
      only(providerId);
      await withLock(
        options.lockFile,
        async () => {
          const end = await security(['delete-generic-password', '-a', account, '-s', KEYCHAIN_SERVICE]);
          if (end.exitCode !== 0 && end.exitCode !== NOT_FOUND) throw refused(end);
        },
        options.lock,
      );
    },
  };
}

/** The keychain item's account: the user's name. */
export const accountOf = (env: Env): string => env.USER || userInfo().username;

/** The user's Codex login in the keychain, through the `security` on `env`'s PATH, locked under `~/.sail/locks`. */
export function keychainCodexStore(env: Env): CredentialStore {
  return keychainStore({
    account: accountOf(env),
    security: systemSecurity(env),
    lockFile: join(homedir(), '.sail', 'locks', `${CODEX_PROVIDER}.lock`),
  });
}
