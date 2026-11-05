// Credential sources: where sail reads a credential variable an adapter requires when the environment leaves it unset.
// The table is fixed; `SAIL_CREDENTIAL_LOOKUP=off` turns every lookup off.

import type { Env } from '../ports/adapter';
import { NOT_FOUND, type Security, systemSecurity } from './keychain';

export type CredentialSource = { readonly keychain: string } | { readonly command: readonly string[] };

export const CREDENTIAL_SOURCES: Readonly<Record<string, CredentialSource>> = {
  LINEAR_API_KEY: { keychain: 'linear-api-key' },
  CLAUDE_CODE_OAUTH_TOKEN: { keychain: 'claude-oauth-token' },
  TYPESAFE_API_KEY: { keychain: 'typesafe-api-key' },
  GITHUB_TOKEN: { command: ['gh', 'auth', 'token'] },
};

/** What a lookup found: the value, that the source holds none (with what was tried, empty when nothing was), or why it failed. */
export type CredentialAnswer = { value: string } | { unset: string } | { error: string };

export type CredentialLookup = (name: string) => Promise<CredentialAnswer>;

export interface CommandEnd {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LookupDeps {
  readonly security?: Security;
  readonly run?: (argv: readonly string[], env: Env, signal: AbortSignal) => Promise<CommandEnd>;
  readonly timeoutMs?: number;
}

const LOOKUP_TIMEOUT_MS = 10_000;

const concrete = (env: Env): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));

const missingProgram = (name: string): Error =>
  Object.assign(new Error(`${name}: no such program on the PATH`), { code: 'ENOENT' });

async function runCommand(argv: readonly string[], env: Env, signal: AbortSignal): Promise<CommandEnd> {
  const [program, ...rest] = argv;
  const found = Bun.which(program as string, { PATH: env.PATH ?? '' });
  if (found === null) throw missingProgram(program as string);
  const child = Bun.spawn([found, ...rest], {
    env: concrete(env),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    signal,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

const isMissingProgram = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

const TIMED_OUT = Symbol('timed out');

/** The lookup over the fixed sources, reading `env`'s PATH. Each name is asked once. */
export function systemCredentials(env: Env, deps: LookupDeps = {}): CredentialLookup {
  const off = (env.SAIL_CREDENTIAL_LOOKUP ?? process.env.SAIL_CREDENTIAL_LOOKUP) === 'off';
  const timeoutMs = deps.timeoutMs ?? LOOKUP_TIMEOUT_MS;
  const seconds = `${timeoutMs / 1000} s`;
  const security =
    deps.security ??
    ((args: readonly string[]) => {
      if (Bun.which('security', { PATH: env.PATH ?? '' }) === null) return Promise.reject(missingProgram('security'));
      return systemSecurity(env)(args);
    });
  const run = deps.run ?? runCommand;
  const answers = new Map<string, Promise<CredentialAnswer>>();

  async function ask(name: string, source: CredentialSource): Promise<CredentialAnswer> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clock = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        resolve(TIMED_OUT);
        controller.abort();
      }, timeoutMs);
    });
    const describe = 'keychain' in source ? `the keychain item ${source.keychain}` : source.command.join(' ');
    const none = 'keychain' in source ? `the keychain holds no ${source.keychain} item` : `${describe} gave none`;
    try {
      const attempt =
        'keychain' in source
          ? security(['find-generic-password', '-s', source.keychain, '-w'])
          : run(source.command, env, controller.signal);
      const end = await Promise.race([attempt, clock]);
      if (end === TIMED_OUT) {
        return {
          error:
            'keychain' in source
              ? `the keychain did not answer within ${seconds} for its ${source.keychain} item`
              : `${describe} did not answer within ${seconds}`,
        };
      }
      if ('keychain' in source) {
        if (end.exitCode === NOT_FOUND) return { unset: none };
        if (end.exitCode !== 0) {
          return { error: `the keychain refused its ${source.keychain} item: ${end.stderr.trim()}` };
        }
      } else if (end.exitCode !== 0) {
        return { unset: none };
      }
      const value = end.stdout.replace(/\r?\n$/, '');
      return value === '' ? { unset: none } : { value };
    } catch (error) {
      if (isMissingProgram(error)) return { unset: none };
      return { error: `${name} could not be read from ${describe}: ${(error as Error).message}` };
    } finally {
      clearTimeout(timer);
    }
  }

  return (name) => {
    const source = CREDENTIAL_SOURCES[name];
    if (off || source === undefined) return Promise.resolve({ unset: '' });
    let answer = answers.get(name);
    if (answer === undefined) {
      answer = ask(name, source);
      answers.set(name, answer);
    }
    return answer;
  };
}

export interface Filled {
  /** The values the sources gave, by variable name. */
  readonly filled: Record<string, string>;
  /** What was tried for each unfilled name or group, keyed by its members joined with `,`. */
  readonly tried: Record<string, string>;
  /** A source that failed, by the variable it was read for. */
  readonly errors: string[];
}

/**
 * Fills the names of `names` that `env` leaves unset or empty from `lookup`. A group of alternatives is skipped when any
 * member is set; otherwise its members are tried in order and the first found fills its own name.
 */
export async function fillCredentials(
  names: readonly (string | readonly string[])[],
  env: Env,
  lookup: CredentialLookup,
): Promise<Filled> {
  const filled: Record<string, string> = {};
  const tried: Record<string, string> = {};
  const errors: string[] = [];
  for (const entry of names) {
    const members = typeof entry === 'string' ? [entry] : entry;
    if (members.some((member) => env[member] !== undefined && env[member] !== '')) continue;
    if (members.some((member) => filled[member] !== undefined)) continue;
    const unset: string[] = [];
    let found = false;
    for (const member of members) {
      const answer = await lookup(member);
      if ('value' in answer) {
        filled[member] = answer.value;
        found = true;
        break;
      }
      if ('error' in answer) errors.push(`${member}: ${answer.error}`);
      else if (answer.unset !== '') unset.push(answer.unset);
    }
    if (!found && unset.length > 0) tried[members.join(',')] = [...new Set(unset)].join(' and ');
  }
  return { filled, tried, errors };
}
