// Pushes a checkout's HEAD to a branch of its remote (DECISIONS D4): `git push --porcelain --no-verify <remote>
// HEAD:refs/heads/<branch>`, never forced, as a process group under a timeout. The token reaches git only through an
// inline credential helper scoped to the web host, and the user's own helpers are reset for the push (D1): no other
// host is offered the token, and no helper can store it. The helper's text names `$SAIL_GIT_TOKEN`, never the token,
// which travels only in the git child's environment, with git's trace variables taken out of it.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '../../engine/process';
import type { Redactor } from '../../engine/redact';
import { PortError, type PortErrorCode } from '../../ports/errors';
import type { Pushed } from '../../ports/types';
import { gitSync, nonInteractive, stripUserinfo } from '../workspace/git';

/** How long a push may take: as long as a fetch, since it reaches the network too. */
export const PUSH_TIMEOUT_MS = 120_000;

/** The credential helper: it answers `get` with the token from its environment, and ignores `store` and `erase`. */
export const CREDENTIAL_HELPER =
  '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$SAIL_GIT_TOKEN"; }; f';

/** The variables that make git print what it sends, the credential included. */
const TRACE = /^(GIT_TRACE.*|GIT_CURL_VERBOSE)$/;

export interface PushOptions {
  readonly cwd: string;
  readonly remote: string;
  readonly branch: string;
  readonly token: string;
  /** The web host the token is offered to, such as `https://github.com`. */
  readonly webUrl: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly redact: Redactor;
}

/** git's arguments for the push. None holds the token. */
export function pushArgs(remote: string, branch: string, webUrl: string): string[] {
  return [
    '-c',
    'credential.helper=',
    '-c',
    `credential.${webUrl}.helper=${CREDENTIAL_HELPER}`,
    'push',
    '--porcelain',
    '--no-verify',
    remote,
    `HEAD:refs/heads/${branch}`,
  ];
}

/** The push's environment: no prompts, no traces, the token for the helper alone. */
export function pushEnv(env: Readonly<Record<string, string>>, token: string): Record<string, string> {
  const quiet = Object.entries(nonInteractive(env)).filter(([name]) => !TRACE.test(name));
  return { ...Object.fromEntries(quiet), GIT_TRACE_REDACT: '1', SAIL_GIT_TOKEN: token };
}

/** The code a failed push is, from what git said. */
function codeOf(said: string): PortErrorCode {
  if (/\[rejected\]/.test(said) && /non-fast-forward|fetch first|stale info/.test(said)) return 'conflict';
  if (/Authentication failed|could not read Username|\b401\b/.test(said)) return 'unauthorized';
  if (/\b403\b/.test(said)) return 'forbidden';
  return 'unavailable';
}

const fail = (code: PortErrorCode, message: string, raw?: unknown) =>
  new PortError('codeHost', 'push', code, message, raw);

export async function pushHead(options: PushOptions): Promise<Pushed> {
  const { cwd, remote, branch, redact } = options;
  const local = nonInteractive(options.env);
  if (branch.startsWith('-') || gitSync(cwd, ['check-ref-format', `refs/heads/${branch}`], local).code !== 0) {
    throw redact.error(fail('invalid', `${branch} is not a branch name`));
  }
  const head = gitSync(cwd, ['rev-parse', 'HEAD'], local);
  if (head.code !== 0) throw redact.error(fail('invalid', `${cwd} is not a git checkout: ${head.stderr}`));
  const headSha = head.stdout.trim();
  const url = gitSync(cwd, ['remote', 'get-url', remote], local);
  const remoteUrl = stripUserinfo(url.code === 0 ? url.stdout.trim() : remote);

  const timeoutMs = options.timeoutMs ?? PUSH_TIMEOUT_MS;
  const logs = mkdtempSync(join(tmpdir(), 'sail-push-'));
  try {
    const stdout = join(logs, 'stdout');
    const stderr = join(logs, 'stderr');
    const end = await runProcess({
      command: ['git', ...pushArgs(remote, branch, options.webUrl)],
      cwd,
      env: pushEnv(options.env, options.token),
      stdout,
      stderr,
      timeoutMs,
      graceMs: 1_000,
    });
    const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').trim() : '');
    const porcelain = read(stdout);
    if (end.started && end.code === 0) {
      return redact.value({ branch, headSha, raw: { remote: remoteUrl, porcelain } });
    }
    const status = porcelain.split('\n').filter((line) => /^[!=*+-]\t/.test(line) || line.startsWith('!'));
    const said = read(stderr).split('\n').slice(-5);
    const how = !end.started ? end.message : end.timedOut ? `git push timed out after ${timeoutMs} ms` : '';
    const message = [how, ...status, ...said].filter((line) => line !== '').join('\n');
    const code = end.started && end.timedOut ? 'unavailable' : codeOf(message);
    throw redact.error(
      fail(code, message || `git push exited ${end.started ? (end.code ?? end.signal) : ''}`, {
        remote: remoteUrl,
        porcelain,
      }),
    );
  } finally {
    rmSync(logs, { recursive: true, force: true });
  }
}
