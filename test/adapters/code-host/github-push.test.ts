// pushHead(): a detached HEAD pushed to `refs/heads/<branch>`, never forced (DECISIONS D4), with the token offered only
// to the web host through an inline credential helper and the user's own helpers reset (D1). The credential path runs
// over real smart HTTP, a bare repository behind Basic auth. Each case has a throwaway HOME whose global config sets a
// logging credential helper, unscoped and scoped to the server, so a helper asked for the token, or to store it, shows.
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CREDENTIAL_HELPER, pushArgs, pushEnv, pushHead } from '../../../src/adapters/code-host/github-push';
import { redactor } from '../../../src/engine/redact';
import { PortError } from '../../../src/ports/errors';
import { type GitHttp, serveGitHttp } from '../../helpers/git-http';
import { withOrigin } from '../../helpers/origin';
import { rejection, settle } from '../../helpers/ports';
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

test('a detached commit is pushed to refs/heads/<branch> as a new branch, and pushing it again succeeds as up to date', async () => {
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

test('a push that is no fast-forward rejects as a conflict, naming the rejection, and the branch stays where it was', async () => {
  await withTempRepo(async (repo) => {
    const origin = withOrigin(repo);
    detachedCommit(repo, 'a.txt');
    await push(repo, 'sail/x');
    const pushed = refIn(repo, origin.url, 'refs/heads/sail/x');
    repo.git('checkout', '-q', '--detach', 'main');
    detachedCommit(repo, 'b.txt');
    const error = await rejection(push(repo, 'sail/x'));
    expect(failure(error)).toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('[rejected] (non-fast-forward)'),
    });
    expect(refIn(repo, origin.url, 'refs/heads/sail/x')).toBe(pushed);
  });
});

test('a branch name git refuses, or a cwd outside git, is invalid, and the remote gets nothing', async () => {
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
    expect(Bun.spawnSync(['git', 'for-each-ref'], { cwd: origin.url, env: repo.env }).stdout.toString()).toBe(
      refsBefore,
    );
  });
});

test("over smart HTTP the server gets the token through sail's helper, and no helper of the user's is asked for it or stores it", async () => {
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
    expect(http.requests.some((request) => request.method === 'POST' && request.authorization === 'matched')).toBe(
      true,
    );
  });
});

test('over smart HTTP with the token scoped to github.com, the server is offered no credential at all, and the push is unauthorized', async () => {
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

test("a token the host refuses is unauthorized, and with git's tracing asked for, the failure holds the token in no form", async () => {
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

test("no hook of the repository's runs during a push that sent the token, reference-transaction included (review R1-1)", async () => {
  await withServed(TOKEN, async ({ repo, http }) => {
    detachedCommit(repo, 'a.txt');
    const ran = join(repo.home, 'hooks.log');
    const hook = `#!/bin/sh\necho "$(basename "$0") $SAIL_GIT_TOKEN" >>${ran}\n`;
    const hooks = join(repo.home, 'hooks');
    mkdirSync(hooks);
    for (const name of ['reference-transaction', 'pre-push', 'post-update', 'push-to-checkout']) {
      writeFileSync(join(hooks, name), hook);
      chmodSync(join(hooks, name), 0o755);
    }
    repo.git('config', 'core.hooksPath', hooks);
    // A remote-tracking ref for the branch is what makes git update a ref locally, and run reference-transaction.
    repo.git('config', 'remote.web.fetch', '+refs/heads/*:refs/remotes/web/*');
    await push(repo, 'sail/x', { remote: 'web', webUrl: http.base });
    expect({
      sent: http.requests.some((request) => request.method === 'POST' && request.authorization === 'matched'),
      hooks: existsSync(ran) ? readFileSync(ran, 'utf8') : '',
    }).toEqual({ sent: true, hooks: '' });
  });
});

test("a global trace2 config that names the helper's variable records nothing of a push that sent the token (review R1-4)", async () => {
  await withServed(TOKEN, async ({ repo, http, config }) => {
    detachedCommit(repo, 'a.txt');
    const traces = ['event', 'normal', 'perf'].map((name) => join(repo.home, `trace2-${name}.log`));
    const [event, normal, perf] = traces;
    writeFileSync(
      join(repo.home, '.gitconfig'),
      `${config}[trace2]\n\teventTarget = ${event}\n\tnormalTarget = ${normal}\n\tperfTarget = ${perf}\n\tenvVars = SAIL_GIT_TOKEN\n`,
    );
    await push(repo, 'sail/x', { remote: 'web', webUrl: http.base });
    expect({
      sent: http.requests.some((request) => request.method === 'POST' && request.authorization === 'matched'),
      traced: traces.filter((file) => existsSync(file) && readFileSync(file, 'utf8').includes(TOKEN)),
    }).toEqual({ sent: true, traced: [] });
  });
});

test("the repository's own config can't steer a push: no proxy it names is asked, no program it names runs, and both pushes land (review R1-2)", async () => {
  await withServed(TOKEN, async ({ repo, http }) => {
    const origin = Bun.spawnSync(['git', 'remote', 'get-url', 'origin'], { cwd: repo.dir, env: repo.env });
    const bare = origin.stdout.toString().trim();
    const sha = detachedCommit(repo, 'a.txt');
    const ran = join(repo.home, 'ran.log');
    const proxied: string[] = [];
    const proxy = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) => {
        proxied.push(`${request.method} ${request.url} ${request.headers.get('authorization') ?? ''}`);
        return new Response('no', { status: 502 });
      },
    });
    try {
      repo.git('config', 'http.proxy', `http://127.0.0.1:${proxy.port}`);
      repo.git('config', 'http.sslVerify', 'false');
      repo.git('config', 'core.sshCommand', `sh -c 'echo sshCommand $SAIL_GIT_TOKEN >>${ran}; exit 1'`);
      repo.git('config', 'remote.origin.receivepack', `sh -c 'echo receivepack $SAIL_GIT_TOKEN >>${ran}; exit 1' --`);
      const web = await settle(push(repo, 'sail/x', { remote: 'web', webUrl: http.base }));
      const local = await settle(push(repo, 'sail/x', { remote: 'origin', webUrl: http.base }));
      expect({
        web: 'rejected' in web ? web.rejected : web.headSha,
        local: 'rejected' in local ? local.rejected : local.headSha,
        landed: refIn(repo, bare, 'refs/heads/sail/x'),
        sent: http.requests.some((request) => request.method === 'POST' && request.authorization === 'matched'),
        proxied,
        ran: existsSync(ran) ? readFileSync(ran, 'utf8') : '',
      }).toEqual({ web: sha, local: sha, landed: sha, sent: true, proxied: [], ran: '' });
    } finally {
      proxy.stop(true);
    }
  });
});

test("an ssh remote is offered no token: the push's environment holds none, and no user helper is asked (review R1-2)", async () => {
  await withServed(TOKEN, async ({ repo, log }) => {
    detachedCommit(repo, 'a.txt');
    const seen = join(repo.home, 'ssh.log');
    // The user's own ssh program, from the environment: it records what it inherits and fails, as an unreachable host.
    const ssh = join(repo.home, 'ssh.sh');
    writeFileSync(ssh, `#!/bin/sh\necho "ssh SAIL_GIT_TOKEN=$SAIL_GIT_TOKEN" >>${seen}\nexit 255\n`);
    chmodSync(ssh, 0o755);
    repo.git('remote', 'add', 'ssh', 'ssh://git@example.invalid/o/r.git');
    const error = await rejection(push(repo, 'sail/x', { remote: 'ssh', env: { ...repo.env, GIT_SSH: ssh } }));
    expect({
      code: failure(error).code,
      // git may start the ssh program more than once, to learn which ssh it is: every start counts.
      seen: [...new Set((existsSync(seen) ? readFileSync(seen, 'utf8') : '').split('\n').filter(Boolean))],
      helperLog: existsSync(log) ? readFileSync(log, 'utf8') : '',
    }).toEqual({ code: 'unavailable', seen: ['ssh SAIL_GIT_TOKEN='], helperLog: '' });
  });
});

test("the user's push.followTags pushes no tag: the branch alone reaches the remote (review R1-6)", async () => {
  await withTempRepo(async (repo) => {
    const origin = withOrigin(repo);
    writeFileSync(join(repo.home, '.gitconfig'), '[push]\n\tfollowTags = true\n');
    detachedCommit(repo, 'a.txt');
    repo.git('tag', '-a', 'v9.9.9', '-m', 'a release');
    const pushed = await push(repo, 'sail/x');
    expect({
      porcelain: (pushed.raw as { porcelain: string }).porcelain,
      tag: refIn(repo, origin.url, 'refs/tags/v9.9.9'),
    }).toEqual({ porcelain: `To ${origin.url}\n*\tHEAD:refs/heads/sail/x\t[new branch]\nDone`, tag: '' });
  });
});

test('a remote that pushes to two URLs is refused as invalid, and neither gets the branch (review R1-2)', async () => {
  await withTempRepo(async (repo) => {
    const origin = withOrigin(repo);
    const other = withOrigin(repo, 'other');
    repo.git('remote', 'set-url', '--add', '--push', 'origin', origin.url);
    repo.git('remote', 'set-url', '--add', '--push', 'origin', other.url);
    detachedCommit(repo, 'a.txt');
    const error = await rejection(push(repo, 'sail/x'));
    expect({
      failure: failure(error),
      refs: [refIn(repo, origin.url, 'refs/heads/sail/x'), refIn(repo, other.url, 'refs/heads/sail/x')],
    }).toEqual({
      failure: { code: 'invalid', message: 'codeHost.push: origin pushes to 2 URLs: sail pushes to one' },
      refs: ['', ''],
    });
  });
});

test("the push's arguments reset the user's helpers, scope sail's to the web host, and push HEAD unforced and without hooks: none holds the token", () => {
  const pushing = ['push', '--porcelain', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', 'sail'];
  expect([pushArgs('sail/x', 'https://github.com'), pushArgs('sail/x', undefined)]).toEqual([
    [
      '-c',
      'credential.helper=',
      '-c',
      `credential.https://github.com.helper=${CREDENTIAL_HELPER}`,
      '-c',
      'core.hooksPath=/dev/null',
      ...pushing,
      'HEAD:refs/heads/sail/x',
    ],
    ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', ...pushing, 'HEAD:refs/heads/sail/x'],
  ]);
  expect(CREDENTIAL_HELPER).toBe(
    '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$SAIL_GIT_TOKEN"; }; f',
  );
});

test("the push's environment drops git's trace variables and the repository's, keeps redaction on, turns prompts off, and carries the token for the helper alone", () => {
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
    GIT_TRACE2: '0',
    GIT_TRACE2_EVENT: '0',
    GIT_TRACE2_PERF: '0',
    SAIL_GIT_TOKEN: TOKEN,
  });
});

test("the push's environment holds the token only as SAIL_GIT_TOKEN: the caller's variables that hold it are dropped (review R1-3)", () => {
  const caller = { KEEP: 'kept', SAIL_GITHUB_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN, GH_AUTH: `Bearer ${TOKEN}` };
  const env = pushEnv(caller, TOKEN);
  expect({
    holding: Object.entries(env).flatMap(([name, value]) => (value.includes(TOKEN) ? [name] : [])),
    kept: env.KEEP,
  }).toEqual({ holding: ['SAIL_GIT_TOKEN'], kept: 'kept' });
});

/** The command lines of every process on the machine. */
const processes = () => Bun.spawnSync(['ps', '-axo', 'command'], { stdin: 'ignore' }).stdout.toString();

test('a remote that never answers is unavailable once the timeout passes, naming it, and leaves no git process behind', async () => {
  await withTempRepo(async (repo) => {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Promise<Response>(() => {}) });
    try {
      const url = `http://127.0.0.1:${server.port}/silent.git`;
      repo.git('remote', 'add', 'silent', url);
      detachedCommit(repo, 'a.txt');
      const started = performance.now();
      const error = await rejection(push(repo, 'sail/x', { remote: 'silent', timeoutMs: 1_000 }));
      expect(failure(error)).toMatchObject({
        code: 'unavailable',
        message: expect.stringContaining('timed out after 1000 ms'),
      });
      expect(performance.now() - started).toBeLessThan(10_000);
      expect(
        processes()
          .split('\n')
          .filter((line) => line.includes(url)),
      ).toEqual([]);
    } finally {
      server.stop(true);
    }
  });
}, 20_000);
