// Pushes a checkout's HEAD to a branch of its remote (DECISIONS D4): `git push --porcelain --no-verify <remote>
// HEAD:refs/heads/<branch>`, never forced, as a process group under a timeout. The token reaches git only through an
// inline credential helper scoped to the web host, and the user's own helpers are reset for the push (D1): no other
// host is offered the token, and no helper can store it. The helper's text names `$SAIL_GIT_TOKEN`, never the token,
// which travels only in the git child's environment, with git's trace variables taken out of it.
//
// The push runs from a git directory of its own, not the checkout's (review R1-2). The checkout's config is the
// repository's to write, an agent's file edits included, and git obeys it: a proxy, `http.sslVerify`, a program such as
// `core.sshCommand` or `remote.<name>.receivepack`. So the remote's push URL is read from the checkout, and the push
// goes from a temporary bare repository that borrows the checkout's objects, holds HEAD's commit as its own HEAD, and
// has no config but that URL. The token is offered only when that URL is on the web host.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** The remote's name in the push's own git directory. */
const REMOTE = 'sail';

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

/**
 * git's arguments for the push, after `--git-dir`. None holds the token. sail's helper is scoped to `webUrl`, and left
 * out without one. No hook runs: `--no-verify` skips only pre-push. No tag or submodule goes with the branch.
 */
export function pushArgs(branch: string, webUrl: string | undefined): string[] {
  return [
    '-c',
    'credential.helper=',
    ...(webUrl === undefined ? [] : ['-c', `credential.${webUrl}.helper=${CREDENTIAL_HELPER}`]),
    '-c',
    'core.hooksPath=/dev/null',
    'push',
    '--porcelain',
    '--no-verify',
    '--no-follow-tags',
    '--recurse-submodules=no',
    REMOTE,
    `HEAD:refs/heads/${branch}`,
  ];
}

/** `env` without a variable that holds `token`, such as the operator's own `GITHUB_TOKEN`: git's children inherit it. */
function withoutToken(env: Readonly<Record<string, string>>, token: string): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => token === '' || !value.includes(token)));
}

/**
 * Trace2 off, whatever the user's global config sets: its `trace2.envVars` can name the helper's variable, and its
 * targets write to files. These variables win over that config.
 */
const TRACE2_OFF = { GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0', GIT_TRACE2_PERF: '0' };

/**
 * The push's environment: no prompts, no traces, and the token for the helper alone, as `SAIL_GIT_TOKEN`. Without a
 * token to offer, the token is in no variable at all.
 */
export function pushEnv(env: Readonly<Record<string, string>>, token: string | undefined): Record<string, string> {
  const quiet = Object.entries(nonInteractive(withoutToken(env, token ?? ''))).filter(([name]) => !TRACE.test(name));
  return {
    ...Object.fromEntries(quiet),
    GIT_TRACE_REDACT: '1',
    ...TRACE2_OFF,
    ...(token === undefined ? {} : { SAIL_GIT_TOKEN: token }),
  };
}

/** Whether `url` is on the web host: the same scheme, host and port. A URL that doesn't parse, such as a path, isn't. */
function onHost(url: string, webUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(webUrl).origin;
  } catch {
    return false;
  }
}

/** A value for git's config file, quoted. */
const quoted = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

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
  const local = nonInteractive(withoutToken(options.env, options.token));
  if (branch.startsWith('-') || gitSync(cwd, ['check-ref-format', `refs/heads/${branch}`], local).code !== 0) {
    throw redact.error(fail('invalid', `${branch} is not a branch name`));
  }
  const head = gitSync(cwd, ['rev-parse', 'HEAD'], local);
  if (head.code !== 0) throw redact.error(fail('invalid', `${cwd} is not a git checkout: ${head.stderr}`));
  const headSha = head.stdout.trim();
  const urls = gitSync(cwd, ['remote', 'get-url', '--push', '--all', remote], local);
  if (urls.code !== 0) throw redact.error(fail('invalid', `${remote} is no remote of ${cwd}: ${urls.stderr}`));
  const pushUrls = urls.stdout.split('\n').filter((line) => line.trim() !== '');
  const [url] = pushUrls;
  if (url === undefined || pushUrls.length !== 1) {
    throw redact.error(fail('invalid', `${remote} pushes to ${pushUrls.length} URLs: sail pushes to one`));
  }
  const remoteUrl = stripUserinfo(url);
  const at = (path: string) => gitSync(cwd, ['rev-parse', '--path-format=absolute', '--git-path', path], local);
  const format = gitSync(cwd, ['rev-parse', '--show-object-format'], local).stdout.trim() || 'sha1';
  const offered = onHost(url, options.webUrl);

  const timeoutMs = options.timeoutMs ?? PUSH_TIMEOUT_MS;
  const logs = mkdtempSync(join(tmpdir(), 'sail-push-'));
  try {
    const gitDir = join(logs, 'push.git');
    const made = gitSync(
      logs,
      ['init', '--quiet', '--bare', '--template=', `--object-format=${format}`, gitDir],
      local,
    );
    if (made.code !== 0) throw fail('unavailable', `could not make the push's git directory: ${made.stderr}`);
    writeFileSync(join(gitDir, 'objects', 'info', 'alternates'), `${at('objects').stdout.trim()}\n`);
    const shallow = at('shallow').stdout.trim();
    if (shallow !== '' && existsSync(shallow)) copyFileSync(shallow, join(gitDir, 'shallow'));
    writeFileSync(join(gitDir, 'HEAD'), `${headSha}\n`);
    const config = join(gitDir, 'config');
    writeFileSync(config, `${readFileSync(config, 'utf8')}[remote "${REMOTE}"]\n\turl = ${quoted(url)}\n`);

    const stdout = join(logs, 'stdout');
    const stderr = join(logs, 'stderr');
    const end = await runProcess({
      command: ['git', `--git-dir=${gitDir}`, ...pushArgs(branch, offered ? options.webUrl : undefined)],
      cwd: logs,
      env: pushEnv(options.env, offered ? options.token : undefined),
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
    throw fail(code, message || `git push exited ${end.started ? (end.code ?? end.signal) : ''}`, {
      remote: remoteUrl,
      porcelain,
    });
  } catch (error) {
    throw redact.error(error);
  } finally {
    rmSync(logs, { recursive: true, force: true });
  }
}
