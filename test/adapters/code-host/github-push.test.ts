// pushHead(): a detached HEAD pushed to `refs/heads/<branch>`, never forced (DECISIONS D4), with the token offered only
// to the web host through an inline credential helper and the user's own helpers reset (D1). The credential path runs
// over real smart HTTP, a bare repository behind Basic auth. Each case has a throwaway HOME whose global config sets a
// logging credential helper, unscoped and scoped to the server, so a helper asked for the token, or to store it, shows.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CREDENTIAL_HELPER, pushArgs, pushEnv, pushHead } from '../../../src/adapters/code-host/github-push';
import { redactor } from '../../../src/engine/redact';
import { PortError } from '../../../src/ports/errors';
import { type GitHttp, serveGitHttp } from '../../helpers/git-http';
import { withOrigin } from '../../helpers/origin';
import { rejection } from '../../helpers/ports';
import { type TempRepo, withTempRepo } from '../../helpers/temp-repo';

const TOKEN = 'ghp_MARKER_push_31c9f04d';
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');

/** A commit on a detached HEAD in the repository, writing `file`: what a run's worktree holds. Returns its sha. */
function detachedCommit(repo: TempRepo, file: string): string {
  repo.git('checkout', '-q', '--detach');
  writeFileSync(join(repo.dir, file), `${file}\n`);
  repo.git('add', file);
  repo.git('commit', '-q', '-m', `add ${file}`);
  return repo.git('rev-parse', 'HEAD');
}

/** The sha `ref` points at in the bare repository, or '' when it has no such ref. */
function refIn(repo: TempRepo, bare: string, ref: string): string {
  const shown = Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', ref], { cwd: bare, env: repo.env });
  return shown.stdout.toString().trim();
}

const push = (repo: TempRepo, branch: string, more: Partial<Parameters<typeof pushHead>[0]> = {}) =>
  pushHead({
    cwd: repo.dir,
    remote: 'origin',
    branch,
    token: TOKEN,
    webUrl: 'https://github.com',
    env: repo.env,
    redact: redactor([TOKEN]),
    ...more,
  });

/** The rejection's code and message, or what it was when it was no PortError. */
const failure = (error: unknown) =>
  error instanceof PortError ? { code: error.code, message: error.message } : { other: String(error) };

interface Served {
  repo: TempRepo;
  http: GitHttp;
  /** Where the logging helper writes each call it gets. */
  log: string;
  /** The global config as it was written. */
  config: string;
}

/**
 * A repository with a bare origin served over smart HTTP as the remote `web`, accepting `x-access-token` with
 * `password`, and a global config whose logging helper, unscoped and scoped to the server, records every call.
 */
async function withServed<T>(password: string, fn: (served: Served) => Promise<T>): Promise<T> {
  return withTempRepo(async (repo) => {
    const origin = withOrigin(repo);
    const http = serveGitHttp({ bare: origin.url, user: 'x-access-token', password, env: repo.env });
    try {
      repo.git('remote', 'add', 'web', http.url);
      const log = join(repo.home, 'helper.log');
      const helper = `!f() { echo "$@" >>${log}; }; f`;
      const config = `[credential]\n\thelper = "${helper}"\n[credential "${http.base}"]\n\thelper = "${helper}"\n`;
      writeFileSync(join(repo.home, '.gitconfig'), config);
      return await fn({ repo, http, log, config });
    } finally {
      http.stop();
    }
  });
}

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('a detached commit is pushed to refs/heads/<branch> as a new branch, and pushing it again succeeds as up to date', async () => {
  await withTempRepo(async (repo) => {
    const origin = withOrigin(repo);
    const sha = detachedCommit(repo, 'a.txt');
    const first = await push(repo, 'sail/x');
    const again = await push(repo, 'sail/x');
    expect({
      first: [first.branch, first.headSha, first.raw],
      again: [again.branch, again.headSha],
      bare: refIn(repo, origin.url, 'refs/heads/sail/x'),
    }).toEqual({
      first: [
        'sail/x',
        sha,
        { remote: origin.url, porcelain: `To ${origin.url}\n*\tHEAD:refs/heads/sail/x\t[new branch]\nDone` },
      ],
      again: ['sail/x', sha],
      bare: sha,
    });
  });
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('a push that is no fast-forward rejects as a conflict, naming the rejection, and the branch stays where it was', async () => {
  await withTempRepo(async (repo) => {
    const origin = withOrigin(repo);
    detachedCommit(repo, 'a.txt');
    await push(repo, 'sail/x');
    const pushed = refIn(repo, origin.url, 'refs/heads/sail/x');
    repo.git('checkout', '-q', '--detach', 'main');
    detachedCommit(repo, 'b.txt');
    const error = await rejection(push(repo, 'sail/x'));
    expect(failure(error)).toMatchObject({ code: 'conflict', message: expect.stringContaining('[rejected] (non-fast-forward)') });
    expect(refIn(repo, origin.url, 'refs/heads/sail/x')).toBe(pushed);
  });
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('a branch name git refuses, or a cwd outside git, is invalid, and the remote gets nothing', async () => {
  await withTempRepo(async (repo) => {
    const origin = withOrigin(repo);
    detachedCommit(repo, 'a.txt');
    const refsBefore = Bun.spawnSync(['git', 'for-each-ref'], { cwd: origin.url, env: repo.env }).stdout.toString();
    const errors = [
      await rejection(push(repo, 'bad..name')),
      await rejection(push(repo, '-x')),
      await rejection(push(repo, 'sail/y', { cwd: repo.home })),
    ];
    expect(errors.map((error) => (error instanceof PortError ? [error.op, error.code] : String(error)))).toEqual([
      ['push', 'invalid'],
      ['push', 'invalid'],
      ['push', 'invalid'],
    ]);
    expect(Bun.spawnSync(['git', 'for-each-ref'], { cwd: origin.url, env: repo.env }).stdout.toString()).toBe(refsBefore);
  });
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ("over smart HTTP the server gets the token through sail's helper, and no helper of the user's is asked for it or stores it", async () => {
  await withServed(TOKEN, async ({ repo, http, log, config }) => {
    const sha = detachedCommit(repo, 'a.txt');
    const pushed = await push(repo, 'sail/x', { remote: 'web', webUrl: http.base });
    expect({
      headSha: pushed.headSha,
      authorizations: [...new Set(http.requests.map((request) => request.authorization))].sort(),
      helperLog: existsSync(log) ? readFileSync(log, 'utf8') : '',
      credentials: readdirSync(repo.home).filter((name) => name.includes('credential')),
      config: readFileSync(join(repo.home, '.gitconfig'), 'utf8'),
    }).toEqual({ headSha: sha, authorizations: ['matched', 'none'], helperLog: '', credentials: [], config });
    expect(http.requests.some((request) => request.method === 'POST' && request.authorization === 'matched')).toBe(true);
  });
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('over smart HTTP with the token scoped to github.com, the server is offered no credential at all, and the push is unauthorized', async () => {
  await withServed(TOKEN, async ({ repo, http, log }) => {
    detachedCommit(repo, 'a.txt');
    const error = await rejection(push(repo, 'sail/x', { remote: 'web', webUrl: 'https://github.com' }));
    expect({
      code: failure(error).code,
      authorizations: [...new Set(http.requests.map((request) => request.authorization))],
      helperLog: existsSync(log) ? readFileSync(log, 'utf8') : '',
    }).toEqual({ code: 'unauthorized', authorizations: ['none'], helperLog: '' });
  });
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ("a token the host refuses is unauthorized, and with git's tracing asked for, the failure holds the token in no form", async () => {
  await withServed('another-password', async ({ repo, http }) => {
    detachedCommit(repo, 'a.txt');
    const env = { ...repo.env, GIT_TRACE: '1', GIT_CURL_VERBOSE: '1', GIT_TRACE_REDACT: '0', GIT_TRACE_CURL: '1' };
    const error = await rejection(push(repo, 'sail/x', { remote: 'web', webUrl: http.base, env }));
    const said = JSON.stringify([failure(error), error instanceof PortError ? error.raw : null]);
    expect({
      code: failure(error).code,
      wrong: http.requests.some((request) => request.authorization === 'wrong'),
      leaks: [TOKEN, BASIC, 'Authorization', '[redacted]'].filter((form) => said.includes(form)),
    }).toEqual({ code: 'unauthorized', wrong: true, leaks: [] });
  });
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ("the push's arguments reset the user's helpers, scope sail's to the web host, and push HEAD unforced and without hooks: none holds the token", () => {
  expect(pushArgs('origin', 'sail/x', 'https://github.com')).toEqual([
    '-c',
    'credential.helper=',
    '-c',
    `credential.https://github.com.helper=${CREDENTIAL_HELPER}`,
    'push',
    '--porcelain',
    '--no-verify',
    'origin',
    'HEAD:refs/heads/sail/x',
  ]);
  expect(CREDENTIAL_HELPER).toBe(
    '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$SAIL_GIT_TOKEN"; }; f',
  );
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ("the push's environment drops git's trace variables and the repository's, keeps redaction on, turns prompts off, and carries the token for the helper alone", () => {
  const caller = {
    KEEP: 'kept',
    GIT_TRACE: '1',
    GIT_TRACE_CURL: '1',
    GIT_TRACE_CURL_NO_DATA: '1',
    GIT_TRACE_PACKET: '1',
    GIT_TRACE_PERFORMANCE: '1',
    GIT_TRACE_SETUP: '1',
    GIT_TRACE2: '1',
    GIT_TRACE2_EVENT: '/tmp/trace2.json',
    GIT_CURL_VERBOSE: '1',
    GIT_TRACE_REDACT: '0',
    GIT_DIR: '/elsewhere/.git',
    GIT_ASKPASS: '/usr/bin/askpass',
  };
  expect(pushEnv(caller, TOKEN)).toEqual({
    KEEP: 'kept',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS_REQUIRE: 'never',
    GCM_INTERACTIVE: 'never',
    GIT_TRACE_REDACT: '1',
    SAIL_GIT_TOKEN: TOKEN,
  });
});

/** The command lines of every process on the machine. */
const processes = () => Bun.spawnSync(['ps', '-axo', 'command'], { stdin: 'ignore' }).stdout.toString();

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('a remote that never answers is unavailable once the timeout passes, naming it, and leaves no git process behind', async () => {
  await withTempRepo(async (repo) => {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Promise<Response>(() => {}) });
    try {
      const url = `http://127.0.0.1:${server.port}/silent.git`;
      repo.git('remote', 'add', 'silent', url);
      detachedCommit(repo, 'a.txt');
      const started = performance.now();
      const error = await rejection(push(repo, 'sail/x', { remote: 'silent', timeoutMs: 1_000 }));
      expect(failure(error)).toMatchObject({ code: 'unavailable', message: expect.stringContaining('timed out after 1000 ms') });
      expect(performance.now() - started).toBeLessThan(10_000);
      expect(processes().split('\n').filter((line) => line.includes(url))).toEqual([]);
    } finally {
      server.stop(true);
    }
  });
}, 20_000);
