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
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
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

/**
 * The remote's name in the push's own git directory: new for each push, so no `remote.<name>.*` of the user's global
 * config can name it ahead and reroute the push (review R2-1).
 */
const remoteName = () => `sail-${randomBytes(4).toString('hex')}`;

/**
 * The variables that hold a GitHub token by name, `requires()`'s: each leaves git's environment whatever its value, so
 * a broader `GITHUB_TOKEN` beside a narrow `SAIL_GITHUB_TOKEN` reaches no git either (review R3-3).
 */
const TOKEN_NAMES: ReadonlySet<string> = new Set(['SAIL_GITHUB_TOKEN', 'GITHUB_TOKEN']);

/** The caller's own `-c` config, as variables: git reads it after every file, so it would steer the push. */
const CALLER_CONFIG = /^GIT_CONFIG_(PARAMETERS|COUNT|KEY_\d+|VALUE_\d+)$/;

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
  /**
   * The repository the push must reach, `owner/name`: a push URL on the web host's hostname, https or ssh, that names
   * another is refused, since the default branch was read from this one (review R1-7).
   */
  readonly repository?: string;
}

/**
 * git's arguments for the push, after `--git-dir`. None holds the token. sail's helper is scoped to `webUrl`, and left
 * out without one. No hook runs: `--no-verify` skips only pre-push. No tag or submodule goes with the branch.
 */
export function pushArgs(branch: string, webUrl: string | undefined, remote: string): string[] {
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
    remote,
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
 * The environment for any git the adapter runs: no prompts, no traces, none of the caller's `-c` config, and no
 * variable that holds `token`. Every git call before the push takes it too, since the caller's trace variables could
 * name the operator's own (review R2-3).
 */
export function gitEnv(env: Readonly<Record<string, string>>, token: string): Record<string, string> {
  const quiet = Object.entries(nonInteractive(withoutToken(env, token))).filter(
    ([name]) => !TRACE.test(name) && !CALLER_CONFIG.test(name) && !TOKEN_NAMES.has(name),
  );
  return { ...Object.fromEntries(quiet), GIT_TRACE_REDACT: '1', ...TRACE2_OFF };
}

/**
 * The push's environment: no prompts, no traces, and the token for the helper alone, as `SAIL_GIT_TOKEN`. Without a
 * token to offer, the token is in no variable at all.
 */
export function pushEnv(env: Readonly<Record<string, string>>, token: string | undefined): Record<string, string> {
  return { ...gitEnv(env, token ?? ''), ...(token === undefined ? {} : { SAIL_GIT_TOKEN: token }) };
}

/**
 * Whether `url` is on the web host: it starts with the web URL and a slash, as written. A URL parser is looser than
 * git: it reads `https:github.com/o/r` as https, where git reads it as scp-like ssh to a host named `https` (review
 * R3-2). The one prefix both read alike decides.
 */
function onHost(url: string, webUrl: string): boolean {
  return url.startsWith(`${webUrl.replace(/\/+$/, '')}/`);
}

/**
 * The repository a URL names on the web host's hostname, `owner/name` without `.git`, from an https, ssh or scp-like
 * URL. Undefined for another host or a path.
 */
function repositoryAt(url: string, webUrl: string): string | undefined {
  let at: { host: string; path: string };
  const scp = url.includes('://') ? null : /^(?:[^@/]+@)?([^:/]+):(.*)$/.exec(url);
  if (scp !== null) {
    at = { host: scp[1] ?? '', path: scp[2] ?? '' };
  } else {
    try {
      const parsed = new URL(url);
      at = { host: parsed.hostname, path: parsed.pathname };
    } catch {
      return undefined;
    }
  }
  if (at.host.toLowerCase() !== new URL(webUrl).hostname.toLowerCase()) return undefined;
  return at.path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
}

/**
 * `url` as the push's own git directory must read it: a relative path is the checkout's, from its top level, as git
 * reads it there (review R2-4). URLs, scp-like ones included, and absolute paths are as they are.
 */
function fromCheckout(url: string, topLevel: string): string {
  // A path under `~` is git's to expand (review R3-4).
  const path = !url.includes('://') && !/^(?:[^@/]+@)?[^:/]+:/.test(url) && !isAbsolute(url) && !url.startsWith('~');
  return path && topLevel !== '' ? resolve(topLevel, url) : url;
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
  const local = gitEnv(options.env, options.token);
  if (branch.startsWith('-') || gitSync(cwd, ['check-ref-format', `refs/heads/${branch}`], local).code !== 0) {
    throw redact.error(fail('invalid', `${branch} is not a branch name`));
  }
  const head = gitSync(cwd, ['rev-parse', 'HEAD'], local);
  if (head.code !== 0) throw redact.error(fail('invalid', `${cwd} is not a git checkout: ${head.stderr}`));
  const headSha = head.stdout.trim();
  /** The one URL `name` pushes to, as git reads it with `args` before the subcommand. */
  const pushUrl = (where: string, args: readonly string[], name: string): string => {
    const urls = gitSync(where, [...args, 'remote', 'get-url', '--push', '--all', name], local);
    if (urls.code !== 0) throw fail('invalid', `${remote} is no remote of ${cwd}: ${urls.stderr}`);
    const pushUrls = urls.stdout.split('\n').filter((line) => line.trim() !== '');
    const [url] = pushUrls;
    if (url === undefined || pushUrls.length !== 1) {
      throw fail('invalid', `${remote} pushes to ${pushUrls.length} URLs: sail pushes to one`);
    }
    return url;
  };
  let url: string;
  try {
    url = pushUrl(cwd, [], remote);
  } catch (error) {
    throw redact.error(error);
  }
  const at = (path: string) => gitSync(cwd, ['rev-parse', '--path-format=absolute', '--git-path', path], local);
  const format = gitSync(cwd, ['rev-parse', '--show-object-format'], local).stdout.trim() || 'sha1';

  const timeoutMs = options.timeoutMs ?? PUSH_TIMEOUT_MS;
  const logs = mkdtempSync(join(tmpdir(), 'sail-push-'));
  try {
    const gitDir = join(logs, 'push.git');
    const name = remoteName();
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
    const topLevel = gitSync(cwd, ['rev-parse', '--show-toplevel'], local).stdout.trim();
    const target = quoted(fromCheckout(url, topLevel));
    writeFileSync(config, `${readFileSync(config, 'utf8')}[remote "${name}"]\n\turl = ${target}\n`);
    // What the push will reach, as git reads it here: the global config rewrites the URL once more (review R3-1). The
    // token and the repository check follow this URL, not the checkout's.
    const effective = pushUrl(logs, [`--git-dir=${gitDir}`], name);
    const remoteUrl = stripUserinfo(effective);
    const named = options.repository === undefined ? undefined : repositoryAt(effective, options.webUrl);
    if (named !== undefined && named.toLowerCase() !== options.repository?.toLowerCase()) {
      throw fail('invalid', `${remote} pushes to ${remoteUrl}, not ${options.repository}`);
    }
    const offered = onHost(effective, options.webUrl);

    const stdout = join(logs, 'stdout');
    const stderr = join(logs, 'stderr');
    const end = await runProcess({
      command: ['git', `--git-dir=${gitDir}`, ...pushArgs(branch, offered ? options.webUrl : undefined, name)],
      cwd: logs,
      // The token leaves every variable first, offered or not: the operator's own GITHUB_TOKEN would stay otherwise.
      env: pushEnv(withoutToken(options.env, options.token), offered ? options.token : undefined),
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
