// `sail port codehost` on `codeHost: { use: github, repository: o/r }`, in process through run(), from a temporary
// repository with a bare origin, against the scripted GitHub served on 127.0.0.1 through SAIL_GITHUB_API_URL. The token
// is a marker in GITHUB_TOKEN, so a test can show that what the command prints never holds it.
import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_FAILED, EXIT_OK } from '../../src/cli/exit-codes';
import type { ProviderEvent } from '../../src/events/types';
import { copyFixture, edit } from '../helpers/fixture';
import { createGitHubWorld, type GitHubWorld, worldMergeSha } from '../helpers/github-world';
import { withOrigin } from '../helpers/origin';
import { captureEvents, eventIssues } from '../helpers/ports';
import { runCaptured } from '../helpers/run-captured';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const TOKEN = 'ghp_MARKER_cli_4f8b13e6';

interface OnGitHub {
  repo: TempRepo;
  world: GitHubWorld;
  /** `sail port codehost <args>` from the repository, in its environment plus `env`. */
  codehost(args: string[], env?: Record<string, string>): ReturnType<typeof runCaptured>;
  /** The origin's sha for `branch`, or '' when it has none. */
  originHas(branch: string): string;
}

/**
 * A repository on github with a bare origin, whose world takes `worldToken`, and a commit on a detached HEAD. The
 * environment drops the shell's own tokens: the command sees the marker alone.
 */
async function onGitHub<T>(fn: (on: OnGitHub) => Promise<T>, worldToken = TOKEN): Promise<T> {
  return withTempRepo(async (repo) => {
    const origin = withOrigin(repo);
    const sail = copyFixture(repo.dir);
    edit(
      sail,
      'project.yaml',
      'codeHost: { use: fake, seed: ./fake/prs.json }',
      'codeHost: { use: github, repository: o/r }',
    );
    repo.git('checkout', '-q', '--detach');
    writeFileSync(join(repo.dir, 'shout.txt'), 'shout\n');
    repo.git('add', 'shout.txt');
    repo.git('commit', '-q', '-m', 'shout');
    const world = createGitHubWorld({
      owner: 'o',
      repo: 'r',
      defaultBranch: 'main',
      bare: origin.url,
      env: repo.env,
      token: worldToken,
    });
    const served = world.serve();
    try {
      const { SAIL_GITHUB_TOKEN: _sail, GITHUB_TOKEN: _github, ...base } = repo.env;
      const env = { ...base, GITHUB_TOKEN: TOKEN, SAIL_GITHUB_API_URL: served.url };
      return await fn({
        repo,
        world,
        codehost: (args, more = {}) =>
          runCaptured(['port', 'codehost', ...args], repo.dir, { env: { ...env, ...more } }),
        originHas: (branch) =>
          Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
            cwd: origin.url,
            env: repo.env,
          })
            .stdout.toString()
            .trim(),
      });
    } finally {
      served.stop();
    }
  });
}

/** The one line a command printed, parsed. */
const printed = (stdout: string): Record<string, unknown> => {
  expect(stdout.split('\n')).toHaveLength(2);
  return JSON.parse(stdout);
};

const BRANCH = 'sail/FAKE-1-shout';

test('push, open-pull-request twice and comment run against GitHub: the branch lands on the origin, one labelled pull request is opened and answered again, and the port events file holds each event, valid', async () => {
  await onGitHub(async ({ repo, world, codehost, originHas }) => {
    writeFileSync(join(repo.dir, 'b.md'), 'Adds the flag.\n');
    writeFileSync(join(repo.dir, 'c.md'), 'Checks passed.\n');
    const events = join(repo.home, 'port-events.ndjson');
    const env = { SAIL_EVENTS: events };
    const open = [
      'open-pull-request',
      '--base',
      'main',
      '--head',
      BRANCH,
      '--title',
      'T (FAKE-1)',
      '--body-file',
      'b.md',
      '--ticket',
      'FAKE-1',
      '--label',
      'sail',
    ];
    const pushed = await codehost(['push', BRANCH], env);
    const opened = await codehost(open, env);
    const again = await codehost(open, env);
    const commented = await codehost(['comment', '1', '--body-file', 'c.md'], env);
    const headSha = repo.git('rev-parse', 'HEAD');
    expect<unknown>({
      codes: [pushed.code, opened.code, again.code, commented.code],
      stderr: [pushed.stderr, opened.stderr, again.stderr, commented.stderr].join(''),
      pushed: { ...printed(pushed.stdout), raw: undefined },
      origin: originHas(BRANCH),
      opened: [printed(opened.stdout).number, printed(opened.stdout).url, printed(opened.stdout).labels],
      again: printed(again.stdout).number,
      creates: world.routes().filter((route) => route === 'POST /repos/o/r/pulls').length,
      held: world.pullRequests.map((pr) => [pr.number, pr.head, pr.labels, pr.body]),
    }).toEqual({
      codes: [EXIT_OK, EXIT_OK, EXIT_OK, EXIT_OK],
      stderr: '',
      pushed: { branch: BRANCH, headSha, raw: undefined },
      origin: headSha,
      opened: [1, 'https://github.com/o/r/pull/1', ['sail']],
      again: 1,
      creates: 1,
      held: [[1, BRANCH, ['sail'], 'Adds the flag.\n\n\n<!-- sail:ticket FAKE-1 -->']],
    });
    const lines: ProviderEvent[] = readFileSync(events, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    const capture = captureEvents();
    for (const event of lines) capture.emit(event);
    expect([lines.map((event) => event.type), eventIssues(capture.stamped('open#1'))]).toEqual([
      ['codehost:pushed', 'codehost:pr_opened', 'codehost:labelled', 'codehost:commented'],
      [],
    ]);
  });
});

test("a token GitHub refuses makes open-pull-request exit 1 with GitHub's own message and the code, and stderr holds no token", async () => {
  await onGitHub(async ({ repo, codehost }) => {
    writeFileSync(join(repo.dir, 'b.md'), 'body\n');
    const refused = await codehost([
      'open-pull-request',
      '--base',
      'main',
      '--head',
      BRANCH,
      '--title',
      'T',
      '--body-file',
      'b.md',
    ]);
    expect([refused.code, refused.stdout, refused.stderr]).toEqual([
      EXIT_FAILED,
      '',
      'sail port: codeHost.openPullRequest: GitHub 401: Bad credentials (unauthorized)\n',
    ]);
  }, 'ghp_another_token');
});

test("an operation github doesn't offer yet exits 1, saying so, and asks GitHub nothing", async () => {
  await onGitHub(async ({ world, codehost, repo }) => {
    const listed = await codehost(['list-designated', 'sail']);
    expect([listed.code, listed.stderr, world.requests.length, existsSync(join(repo.dir, '.sail-runs'))]).toEqual([
      EXIT_FAILED,
      "sail port: codeHost.listDesignated: github doesn't support listDesignated yet (invalid)\n",
      0,
      false,
    ]);
  });
});

/** Pushes the commit as BRANCH and opens pull request 1 from it, in the world: its head sha. */
async function openOne({ repo, codehost }: OnGitHub): Promise<string> {
  writeFileSync(join(repo.dir, 'b.md'), 'Adds the flag.\n');
  await codehost(['push', BRANCH]);
  const opened = await codehost([
    'open-pull-request',
    '--base',
    'main',
    '--head',
    BRANCH,
    '--title',
    'T',
    '--body-file',
    'b.md',
  ]);
  expect(opened.code).toBe(EXIT_OK);
  return repo.git('rev-parse', 'HEAD');
}

/** The events a command appended to `file`, one per line. */
const appended = (file: string): Record<string, unknown>[] =>
  (existsSync(file) ? readFileSync(file, 'utf8') : '')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));

test("merge at the pull request's head prints merged with the sha GitHub answered, and the port events file holds codehost:merged with that sha", async () => {
  await onGitHub(async (on) => {
    const head = await openOne(on);
    const events = join(on.repo.home, 'port-events.ndjson');
    const merged = await on.codehost(['merge', '1', '--method', 'squash', '--expected-head-sha', head], {
      SAIL_EVENTS: events,
    });
    const sha = worldMergeSha(1, head);
    expect<unknown>({
      code: merged.code,
      stderr: merged.stderr,
      printed: merged.code === EXIT_OK ? { ...printed(merged.stdout), raw: undefined } : merged.stdout,
      events: appended(events),
    }).toEqual({
      code: EXIT_OK,
      stderr: '',
      printed: { state: 'merged', sha, raw: undefined },
      events: [{ type: 'codehost:merged', number: 1, method: 'squash', sha }],
    });
  });
});

test("a merge GitHub rejects with a 405 exits 1 with GitHub's message, and the port events file holds one error:port and no codehost:merged", async () => {
  await onGitHub(async (on) => {
    const head = await openOne(on);
    on.world.inject('PUT /pulls/1/merge', { status: 405, body: { message: 'Pull Request is not mergeable' } });
    const events = join(on.repo.home, 'port-events.ndjson');
    const rejected = await on.codehost(['merge', '1', '--method', 'squash', '--expected-head-sha', head], {
      SAIL_EVENTS: events,
    });
    expect({ ...rejected, events: appended(events), open: on.world.pullRequests[0]?.state }).toEqual({
      code: EXIT_FAILED,
      stdout: '',
      stderr: 'sail port: codeHost.merge: GitHub 405: Pull Request is not mergeable (conflict)\n',
      events: [
        {
          type: 'error:port',
          port: 'codeHost',
          op: 'merge',
          code: 'conflict',
          message: 'codeHost.merge: GitHub 405: Pull Request is not mergeable',
        },
      ],
      open: 'open',
    });
  });
});
