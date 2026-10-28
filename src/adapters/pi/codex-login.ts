// The Codex login: a ChatGPT subscription's OAuth tokens, which pi's `openai-codex` provider takes as its key. `sail login
// codex` writes them to sail's own item in the macOS keychain, apart from the Codex CLI's and pi's logins. A refresh token
// is good for one refresh, so the access token is refreshed only when it has under five minutes left, under a lock file
// every sail process waits on, and the new pair is in the keychain before the lock is let go.
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { isAlive } from '../../engine/process';
import type { Env } from '../../ports/adapter';

/** The pi provider a Codex login is the key of. */
export const CODEX_PROVIDER = 'openai-codex';

/** The keychain item's service: the account is the user's. */
export const KEYCHAIN_SERVICE = 'sail-openai-codex';

/** An access token with less than this left is refreshed before a session starts. */
export const REFRESH_MARGIN_MS = 5 * 60_000;

const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 100;

export const NO_LOGIN = 'no Codex login in the keychain: run sail login codex';

/** What pi's Codex OAuth hands back, as the keychain item holds it. */
const CodexCredential = z.object({
  access: z.string().min(1),
  refresh: z.string().min(1),
  expires: z.number(),
  accountId: z.string().min(1),
});
export type CodexCredential = z.infer<typeof CodexCredential>;

/** pi's OAuth credentials as a Codex login: pi types `accountId` as unknown. */
export const asCodexCredential = (value: unknown): CodexCredential => CodexCredential.parse(value);

export interface CodexStore {
  /** The login, or undefined when there is none. */
  read(): Promise<CodexCredential | undefined>;
  write(credential: CodexCredential): Promise<void>;
}

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

/**
 * The login in the keychain item `KEYCHAIN_SERVICE` of `account`. The item is written with `-w` on `security`'s command
 * line: its interactive mode cuts a line at 4096 bytes, shorter than a login. Only the user's own processes can read
 * that, and they can read the item too.
 */
export function keychainStore(account: string, security: Security): CodexStore {
  const refused = (end: SecurityEnd) => new Error(`the keychain refused the Codex login: ${end.stderr.trim()}`);
  return {
    async read() {
      const end = await security(['find-generic-password', '-a', account, '-s', KEYCHAIN_SERVICE, '-w']);
      if (end.exitCode === NOT_FOUND) return undefined;
      if (end.exitCode !== 0) throw refused(end);
      let parsed: unknown;
      try {
        parsed = JSON.parse(end.stdout.trim());
      } catch {
        parsed = undefined;
      }
      const credential = CodexCredential.safeParse(parsed);
      if (!credential.success)
        throw new Error(`the keychain's ${KEYCHAIN_SERVICE} item is not a Codex login: run sail login codex`);
      return credential.data;
    },
    async write(credential) {
      const value = JSON.stringify(CodexCredential.parse(credential));
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
        value,
      ]);
      if (end.exitCode !== 0) throw refused(end);
    },
  };
}

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

export interface CodexLogin {
  readonly store: CodexStore;
  readonly lockFile: string;
  /** Trades a refresh token for a new login. */
  refresh(refreshToken: string): Promise<CodexCredential>;
  readonly now?: () => number;
  readonly lock?: LockOptions;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The login's access token, refreshed first when it has under `REFRESH_MARGIN_MS` left. The refresh reads the login
 * again under the lock, so a process that waited on another's refresh uses the new token rather than spending the
 * refresh token that one already spent.
 */
export async function codexAccessToken(login: CodexLogin): Promise<string> {
  const now = login.now ?? Date.now;
  const fresh = (credential: CodexCredential) => credential.expires - now() > REFRESH_MARGIN_MS;
  const saved = await login.store.read();
  if (saved === undefined) throw new Error(NO_LOGIN);
  if (fresh(saved)) return saved.access;
  return withLock(
    login.lockFile,
    async () => {
      const current = await login.store.read();
      if (current === undefined) throw new Error(NO_LOGIN);
      if (fresh(current)) return current.access;
      let next: CodexCredential;
      try {
        next = await login.refresh(current.refresh);
      } catch (error) {
        throw new Error(`the Codex login could not be refreshed (${messageOf(error)}): run sail login codex`);
      }
      await login.store.write(next);
      return next.access;
    },
    login.lock,
  );
}

/** The keychain item's account: the user's name. */
export const accountOf = (env: Env): string => env.USER || userInfo().username;

/** Trades a refresh token for a new login through pi's Codex OAuth. */
export async function refreshWithPi(refreshToken: string): Promise<CodexCredential> {
  const { refreshOpenAICodexToken } = await import('@mariozechner/pi-ai/oauth');
  return asCodexCredential(await refreshOpenAICodexToken(refreshToken));
}

/** The keychain's Codex login, refreshed through pi under `~/.sail/locks/openai-codex.lock`. */
export function keychainCodexLogin(env: Env): CodexLogin {
  return {
    store: keychainStore(accountOf(env), systemSecurity(env)),
    lockFile: join(homedir(), '.sail', 'locks', `${CODEX_PROVIDER}.lock`),
    refresh: refreshWithPi,
  };
}
