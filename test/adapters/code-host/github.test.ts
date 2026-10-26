// The github CodeHost: the port suite offline, on a scripted GitHub whose branches are a real bare origin, then what only
// the adapter does. Opening again answers the open pull request (DECISIONS D2), the default branch is refused (D3), the
// ticket key rides in the body (D9) and the token leaves in nothing (D11). listDesignated pages through the open pull
// requests and keeps only the designated ones of this repository, and getPullRequest reads the details with the
// conversation comments, paged (14.2's D11). checks, labels and merges send only what changes (ADW-127's D14).
//
// Against GitHub itself, the suite runs only when SAIL_LIVE_CODE_HOST=1 (D14), on the sandbox repository that
// SAIL_LIVE_GITHUB_REPOSITORY names, pushing from the clone SAIL_LIVE_GITHUB_CLONE, with SAIL_LIVE_GITHUB_LABEL, the
// designated pull request SAIL_LIVE_GITHUB_DESIGNATED, an open draft labelled SAIL_LIVE_GITHUB_DRAFT, an open one
// without the label SAIL_LIVE_GITHUB_UNLABELLED and a closed labelled one SAIL_LIVE_GITHUB_CLOSED, none of them ever
// merged. A merge case merges only a pull request the suite opened itself, from a branch of its own, and every one
// still open at the end is closed with its branch deleted. The token comes from SAIL_GITHUB_TOKEN or GITHUB_TOKEN.
// Without the switch the live suite is not registered at all.
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGitHubCodeHost, type GitHubCodeHostOptions } from '../../../src/adapters/code-host/github';
import type { ProviderEmit } from '../../../src/events/types';
import type { CodeHost } from '../../../src/ports/code-host';
import { PortError } from '../../../src/ports/errors';
import type { CheckStatus } from '../../../src/ports/types';
import {
  createGitHubWorld,
  type GitHubWorld,
  type GitHubWorldSeed,
  WORLD_API,
  type WorldSeedPull,
  worldMergeSha,
} from '../../helpers/github-world';
import { holdTempRepo } from '../../helpers/held-repo';
import { closePullRequests, liveFetch } from '../../helpers/live-github';
import { withOrigin } from '../../helpers/origin';
import { captureEvents, portFailure, rejection, settle } from '../../helpers/ports';
import type { TempRepo } from '../../helpers/temp-repo';
import { type CodeHostWorld, codeHostSuite, type MakeCodeHost } from '../../ports/code-host.suite';

const TOKEN = 'ghp_MARKER_adapter_0a7e44c2';
const held = holdTempRepo();

let origin: string | undefined;
let commits = 0;

/** The held repository, with a bare origin on its first call, and a branch for the seeded pull requests. */
function repo(): TempRepo & { origin: string } {
  const repository = held();
  if (origin === undefined) {
    origin = withOrigin(repository).url;
    for (const branch of ['sail/designated', 'sail/draft', 'sail/mergeable', 'sail/unmergeable', 'sail/pending']) {
      commit(repository, branch);
      repository.git('push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
    }
  }
  return { ...repository, origin };
}

/** A commit on a detached HEAD in the repository, off main, and its sha. */
function commit(repository: TempRepo, name: string): string {
  repository.git('checkout', '-q', '--detach', 'main');
  const file = `${name.replaceAll('/', '-')}-${++commits}.txt`;
  writeFileSync(join(repository.dir, file), `${file}\n`);
  repository.git('add', file);
  repository.git('commit', '-q', '-m', `commit ${file}`);
  return repository.git('rev-parse', 'HEAD');
}

/**
 * A world on the origin: pull request 7 open, designated and labelled `sail`, 8 a labelled draft, 5 open without the
 * label, 6 closed with it, and issue 9.
 */
function world(more: Partial<GitHubWorldSeed> = {}): GitHubWorld {
  const { origin: bare, env } = repo();
  return createGitHubWorld({
    owner: 'o',
    repo: 'r',
    defaultBranch: 'main',
    bare,
    env,
    token: TOKEN,
    pullRequests: [
      { number: 7, head: 'sail/designated', labels: ['sail'] },
      { number: 8, head: 'sail/draft', draft: true, labels: ['sail'] },
      { number: 5, head: 'sail/unlabelled' },
      { number: 6, head: 'sail/closed', state: 'closed', labels: ['sail'] },
    ],
    issues: [9],
    ...more,
  });
}

/** The adapter on `github`, as the definition makes it but for the API, which is the world's `fetch`. */
function host(on: GitHubWorld, emit?: ProviderEmit, more: Partial<GitHubCodeHostOptions> = {}): CodeHost {
  return createGitHubCodeHost({
    owner: 'o',
    repo: 'r',
    token: TOKEN,
    apiUrl: WORLD_API,
    env: repo().env,
    fetch: on.fetch,
    ...(emit === undefined ? {} : { emit }),
    ...more,
  });
}

/** A new commit on a detached HEAD, a branch no pull request uses, and the commit's sha. */
function pushable(): { cwd: string; branch: string; headSha: string } {
  const repository = repo();
  const branch = `sail/suite-${commits + 1}`;
  return { cwd: repository.dir, branch, headSha: commit(repository, branch) };
}

/**
 * The world the offline suite runs on: `world()`'s, with pull request 7's checks, 10 mergeable, 11 one GitHub won't
 * merge, and 12 one whose first merge GitHub answers without reporting it.
 */
function suiteWorld(): GitHubWorld {
  const on = world({
    pullRequests: [
      {
        number: 7,
        head: 'sail/designated',
        labels: ['sail'],
        checkRuns: [{ name: 'build', status: 'completed', conclusion: 'success' }],
        statuses: [{ context: 'deploy', state: 'pending' }],
      },
      { number: 8, head: 'sail/draft', draft: true, labels: ['sail'] },
      { number: 5, head: 'sail/unlabelled' },
      { number: 6, head: 'sail/closed', state: 'closed', labels: ['sail'] },
      { number: 10, head: 'sail/mergeable' },
      { number: 11, head: 'sail/unmergeable', mergeable: false },
      { number: 12, head: 'sail/pending' },
    ],
  });
  on.inject('PUT /pulls/12/merge', { status: 200, body: { merged: false, message: 'Merge already in progress' } });
  return on;
}

const offline = (on: GitHubWorld): CodeHostWorld => ({
  label: 'sail',
  base: 'main',
  designated: 7,
  draft: 8,
  unlabelled: 5,
  closed: 6,
  missing: 99,
  pendingMerge: 12,
  rejectedMerge: 11,
  refs: [
    ['7', 7],
    ['#7', 7],
    ['https://github.com/o/r/pull/7', 7],
  ],
  pushable: async () => pushable(),
  mergeable: async () => ({ number: 10, headSha: on.pullRequests.find((pr) => pr.number === 10)?.headSha ?? '' }),
});

describe('the port suite, offline', () => {
  codeHostSuite(
    'github',
    async (emit) => {
      const on = suiteWorld();
      return { adapter: host(on, emit), world: offline(on) };
    },
    [],
  );
});

/** The live sandbox, from the environment: every variable is required. */
function live(): {
  repository: string;
  clone: string;
  label: string;
  designated: number;
  draft: number;
  unlabelled: number;
  closed: number;
  token: string;
} {
  const need = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value === '') throw new Error(`the live suite needs ${name}`);
    return value;
  };
  const token = process.env.SAIL_GITHUB_TOKEN || process.env.GITHUB_TOKEN || need('GITHUB_TOKEN');
  return {
    repository: need('SAIL_LIVE_GITHUB_REPOSITORY'),
    clone: need('SAIL_LIVE_GITHUB_CLONE'),
    label: need('SAIL_LIVE_GITHUB_LABEL'),
    designated: Number(need('SAIL_LIVE_GITHUB_DESIGNATED')),
    draft: Number(need('SAIL_LIVE_GITHUB_DRAFT')),
    unlabelled: Number(need('SAIL_LIVE_GITHUB_UNLABELLED')),
    closed: Number(need('SAIL_LIVE_GITHUB_CLOSED')),
    token,
  };
}

if (process.env.SAIL_LIVE_CODE_HOST === '1') {
  // A push to github.com, then a create and a label, takes longer than Bun's default 5 s: live, the open cases timed
  // out at 5 s with GitHub's answers still on their way.
  setDefaultTimeout(60_000);
  let pushes = 0;
  /** The pull requests the suite opened to merge: closed, with their branches, once it ends. */
  const opened: number[] = [];
  afterAll(async () => {
    const sandbox = live();
    await closePullRequests(sandbox.token, sandbox.repository, opened);
  });
  const makeLive: MakeCodeHost = async (emit) => {
    const sandbox = live();
    const [owner = '', name = ''] = sandbox.repository.split('/');
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const git = (...args: string[]) => {
      const ran = Bun.spawnSync(['git', ...args], { cwd: sandbox.clone, env, stdin: 'ignore' });
      if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString().trim()}`);
      return ran.stdout.toString().trim();
    };
    const options = { owner, repo: name, token: sandbox.token, apiUrl: 'https://api.github.com', env };
    const pushable = async () => {
      git('fetch', '-q', 'origin', 'main');
      git('checkout', '-q', '--detach', 'origin/main');
      const branch = `sail-live/${Date.now()}-${++pushes}`;
      writeFileSync(join(sandbox.clone, `${branch.replaceAll('/', '-')}.txt`), `${branch}\n`);
      git('add', '.');
      git('commit', '-q', '-m', `sail live suite: ${branch}`);
      return { cwd: sandbox.clone, branch, headSha: git('rev-parse', 'HEAD') };
    };
    // The setup's own adapter, with no emit: what it does is no event of the case's.
    const setup = createGitHubCodeHost(options);
    return {
      adapter: createGitHubCodeHost({ ...options, emit }),
      world: {
        label: sandbox.label,
        base: 'main',
        designated: sandbox.designated,
        draft: sandbox.draft,
        unlabelled: sandbox.unlabelled,
        closed: sandbox.closed,
        missing: 999_999,
        refs: [[`https://github.com/${sandbox.repository}/pull/${sandbox.designated}`, sandbox.designated]],
        pushable,
        mergeable: async () => {
          const { cwd, branch } = await pushable();
          await setup.push(cwd, branch);
          const pr = await setup.openPullRequest({
            base: 'main',
            head: branch,
            title: `sail live suite: ${branch}`,
            body: 'Opened by the live port suite to be merged, and closed when the suite ends if it is not.',
          });
          opened.push(pr.number);
          return { number: pr.number, headSha: pr.headSha };
        },
      },
    };
  };
  codeHostSuite('github (live)', makeLive, ['pendingMerge', 'rejectedMerge']);

  test("github (live): a commit status posted on a pull request's head reads back as a passed check of that head", async () => {
    const sandbox = live();
    const capture = captureEvents();
    const { adapter, world: sandboxWorld } = await makeLive(capture.emit);
    const { number, headSha } = await sandboxWorld.mergeable();
    // Posted beside the adapter, as CI would: the adapter only reads checks.
    await liveFetch(sandbox.token, 'POST', `/repos/${sandbox.repository}/statuses/${headSha}`, {
      state: 'success',
      context: 'sail-live',
      description: 'posted by the live port suite',
    });
    const read = await adapter.checks(number);
    expect({
      headSha: read.headSha,
      posted: read.checks.filter((check) => check.name === 'sail-live').map(({ name, status }) => ({ name, status })),
      events: capture.events.map((event) => [event.type, 'headSha' in event ? event.headSha : undefined]),
    }).toEqual({
      headSha,
      posted: [{ name: 'sail-live', status: 'passed' }],
      events: [['codehost:checks', headSha]],
    });
  });
}

const MARKER_LINE = '\n\n<!-- sail:ticket FAKE-1 -->';

test('a first open looks the head up, creates the pull request with draft false and the ticket marker, then labels it, and a later read gives the ticket key back', async () => {
  const on = world();
  const capture = captureEvents();
  const adapter = host(on, capture.emit);
  const { cwd, branch } = pushable();
  await adapter.push(cwd, branch);
  const from = on.requests.length;
  const pr = await adapter.openPullRequest({
    base: 'main',
    head: branch,
    title: 'Add a --shout flag (FAKE-1)',
    body: 'Adds the flag.',
    ticketKey: 'FAKE-1',
    labels: ['sail'],
  });
  const sent = on.requests.slice(from);
  expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual([
    `GET /repos/o/r/pulls?state=open&head=o%3A${encodeURIComponent(branch)}&base=main`,
    'POST /repos/o/r/pulls',
    `POST /repos/o/r/issues/${pr.number}/labels`,
  ]);
  expect([sent[1]?.body, sent[2]?.body]).toEqual([
    {
      title: 'Add a --shout flag (FAKE-1)',
      head: branch,
      base: 'main',
      body: `Adds the flag.${MARKER_LINE}`,
      draft: false,
    },
    { labels: ['sail'] },
  ]);
  expect(capture.events.slice(1)).toEqual([
    {
      type: 'codehost:pr_opened',
      number: pr.number,
      url: `https://github.com/o/r/pull/${pr.number}`,
      draft: false,
      base: 'main',
      head: branch,
      ticketKey: 'FAKE-1',
    },
    { type: 'codehost:labelled', number: pr.number, label: 'sail', change: 'added' },
  ]);
  expect([pr.number, pr.ticketKey, pr.labels, (await adapter.getPullRequest(pr.number)).ticketKey]).toEqual([
    10,
    'FAKE-1',
    ['sail'],
    'FAKE-1',
  ]);
});

test('opening again answers the open pull request, asks for only the label it lacks, emits only that, and creates nothing', async () => {
  const on = world();
  const capture = captureEvents();
  const adapter = host(on, capture.emit);
  const { cwd, branch } = pushable();
  await adapter.push(cwd, branch);
  const first = await adapter.openPullRequest({ base: 'main', head: branch, title: 'T', body: '', labels: ['sail'] });
  const [from, emitted] = [on.requests.length, capture.events.length];
  const again = await adapter.openPullRequest({
    base: 'main',
    head: branch,
    title: 'T2',
    body: '',
    labels: ['sail', 'review'],
  });
  expect({
    number: again.number,
    labels: again.labels,
    routes: on
      .routes()
      .slice(from)
      .map((route) => route.split('?')[0]),
    asked: on.requests.slice(from).flatMap((request) => (request.body === undefined ? [] : [request.body])),
    events: capture.events.slice(emitted),
  }).toEqual({
    number: first.number,
    labels: ['sail', 'review'],
    routes: [
      'GET /repos/o/r/pulls',
      `POST /repos/o/r/issues/${first.number}/labels`,
      `GET /repos/o/r/pulls/${first.number}`,
    ],
    asked: [{ labels: ['review'] }],
    events: [{ type: 'codehost:labelled', number: first.number, label: 'review', change: 'added' }],
  });
});

test('a create that loses a race to another, 422 "already exists", looks again and answers that pull request, announcing nothing', async () => {
  const on = world();
  const capture = captureEvents();
  const adapter = host(on, capture.emit);
  // Pull request 7 is open from sail/designated: the first lookup is told there is none, as if it opened since.
  on.inject('GET /pulls', { status: 200, body: [] });
  const pr = await adapter.openPullRequest({
    base: 'main',
    head: 'sail/designated',
    title: 'T',
    body: '',
    labels: ['sail'],
  });
  expect({
    number: pr.number,
    routes: on.routes().map((route) => route.split('?')[0]),
    events: capture.events,
  }).toEqual({
    number: 7,
    routes: ['GET /repos/o/r/pulls', 'POST /repos/o/r/pulls', 'GET /repos/o/r/pulls', 'GET /repos/o/r/pulls/7'],
    events: [],
  });
});

test("the draft option opens a draft unless the request says otherwise, and the answer's draft is GitHub's", async () => {
  const on = world();
  const adapter = host(on, undefined, { draft: true });
  const [a, b] = [pushable(), pushable()];
  for (const { cwd, branch } of [a, b]) await adapter.push(cwd, branch);
  const drafted = await adapter.openPullRequest({ base: 'main', head: a.branch, title: 'A', body: '' });
  const ready = await adapter.openPullRequest({ base: 'main', head: b.branch, title: 'B', body: '', draft: false });
  const sent = on.requests.filter((request) => request.method === 'POST' && request.path === '/repos/o/r/pulls');
  expect({
    sent: sent.map((request) => (request.body as { draft: boolean }).draft),
    answered: [drafted.draft, ready.draft],
    held: on.pullRequests.slice(-2).map((pr) => pr.draft),
  }).toEqual({ sent: [true, false], answered: [true, false], held: [true, false] });
});

test('a label GitHub drops is left out of the answer, and no codehost:labelled is emitted for it', async () => {
  const on = world({ missingLabels: 'drop', repositoryLabels: ['sail'] });
  const capture = captureEvents();
  const adapter = host(on, capture.emit);
  const { cwd, branch } = pushable();
  await adapter.push(cwd, branch);
  const pr = await adapter.openPullRequest({
    base: 'main',
    head: branch,
    title: 'T',
    body: '',
    labels: ['sail', 'unknown'],
  });
  const labelled = await adapter.addLabel(7, 'unknown');
  expect({
    labels: pr.labels,
    labelled: labelled.labels,
    events: capture.events.filter((event) => event.type === 'codehost:labelled'),
  }).toEqual({
    labels: ['sail'],
    labelled: ['sail'],
    events: [{ type: 'codehost:labelled', number: pr.number, label: 'sail', change: 'added' }],
  });
});

test('a push to the default branch is refused as invalid after only the repository read, and the origin is untouched', async () => {
  const on = world();
  const capture = captureEvents();
  const adapter = host(on, capture.emit);
  const repository = repo();
  commit(repository, 'main-attempt');
  const before = Bun.spawnSync(['git', 'for-each-ref'], {
    cwd: repository.origin,
    env: repository.env,
  }).stdout.toString();
  const error = await rejection(adapter.push(repository.dir, 'main'));
  expect({
    failure: portFailure(error),
    routes: on.routes(),
    refs: Bun.spawnSync(['git', 'for-each-ref'], { cwd: repository.origin, env: repository.env }).stdout.toString(),
    events: capture.events,
  }).toEqual({
    failure: { port: 'codeHost', op: 'push', code: 'invalid' },
    routes: ['GET /repos/o/r'],
    refs: before,
    events: [],
  });
});

test("a push whose remote names another repository on the web host is refused as invalid, ssh or https, and one naming this repository isn't (review R1-7)", async () => {
  const on = world();
  const repository = repo();
  const { branch } = pushable();
  const pushTo = async (name: string, url: string) => {
    repository.git('remote', 'add', name, url);
    const adapter = host(on, undefined, { webUrl: 'https://github.invalid', remote: name, pushTimeoutMs: 10_000 });
    const error = await rejection(adapter.push(repository.dir, branch));
    return error instanceof PortError ? [error.code, error.message.includes('not o/r')] : String(error);
  };
  expect([
    await pushTo('r17-https', 'https://github.invalid/other/r.git'),
    await pushTo('r17-ssh', 'git@github.invalid:o/other.git'),
    // The right repository, as GitHub reads it, whatever the case: refused only because the host never answers.
    await pushTo('r17-same', 'https://github.invalid/O/R.git'),
  ]).toEqual([
    ['invalid', true],
    ['invalid', true],
    ['unavailable', false],
  ]);
}, 30_000);

test('a title, body or comment that holds the token is refused as invalid, and none is sent to GitHub (review R1-10)', async () => {
  const on = world();
  const capture = captureEvents();
  const adapter = host(on, capture.emit);
  const { cwd, branch } = pushable();
  await adapter.push(cwd, branch);
  const sent = on.routes().length;
  const request = { base: 'main', head: branch, title: 'Add a flag', body: 'The body.' };
  const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
  const errors = [
    await rejection(adapter.openPullRequest({ ...request, title: `Add ${TOKEN}` })),
    await rejection(adapter.openPullRequest({ ...request, body: `Authorization: Basic ${basic}` })),
    await rejection(adapter.comment(7, `token=${encodeURIComponent(TOKEN)}`)),
  ];
  expect({
    failures: errors.map((error) => (error instanceof PortError ? [error.op, error.code, error.message] : error)),
    requests: on.routes().slice(sent),
    events: capture.events.filter((event) => event.type !== 'codehost:pushed'),
  }).toEqual({
    failures: [
      ['openPullRequest', 'invalid', "codeHost.openPullRequest: the pull request's title or body holds the token"],
      ['openPullRequest', 'invalid', "codeHost.openPullRequest: the pull request's title or body holds the token"],
      ['comment', 'invalid', 'codeHost.comment: the comment holds the token'],
    ],
    requests: [],
    events: [],
  });
});

test('capabilities offer checks, labels, drafts and every merge method, with no request and no event', async () => {
  const on = world();
  const capture = captureEvents();
  const adapter = host(on, capture.emit);
  expect({
    capabilities: adapter.capabilities(),
    requests: on.requests.length,
    events: capture.events,
  }).toEqual({
    capabilities: { checks: true, labels: true, drafts: true, mergeMethods: ['merge', 'squash', 'rebase'] },
    requests: 0,
    events: [],
  });
});

/** The requests the world received from `from` on, each as its method, path and body when it had one. */
const sentSince = (on: GitHubWorld, from: number) =>
  on.requests.slice(from).map(({ method, path, body }) => (body === undefined ? [method, path] : [method, path, body]));

test('adding then removing a label sends exactly the label: a POST of { labels: [name] } and a DELETE with no body, each after a read', async () => {
  const on = world();
  const capture = captureEvents();
  const adapter = host(on, capture.emit);
  const added = await adapter.addLabel(7, 'needs-review');
  const removed = await adapter.removeLabel(7, 'needs-review');
  expect({
    sent: sentSince(on, 0),
    labels: [added.labels, removed.labels],
    events: capture.events,
  }).toEqual({
    sent: [
      ['GET', '/repos/o/r/pulls/7'],
      ['POST', '/repos/o/r/issues/7/labels', { labels: ['needs-review'] }],
      ['GET', '/repos/o/r/pulls/7'],
      ['DELETE', '/repos/o/r/issues/7/labels/needs-review'],
    ],
    labels: [['sail', 'needs-review'], ['sail']],
    events: [
      { type: 'codehost:labelled', number: 7, label: 'needs-review', change: 'added' },
      { type: 'codehost:labelled', number: 7, label: 'needs-review', change: 'removed' },
    ],
  });
});

test('removing a label the pull request lacks answers its labels after only the read, and emits nothing', async () => {
  const on = world();
  const capture = captureEvents();
  const removed = await host(on, capture.emit).removeLabel(7, 'needs-review');
  expect({ labels: removed.labels, sent: on.routes(), events: capture.events }).toEqual({
    labels: ['sail'],
    sent: ['GET /repos/o/r/pulls/7'],
    events: [],
  });
});

test('a label holding a slash and a space is removed as one encoded path segment', async () => {
  const on = world({
    pullRequests: [{ number: 7, head: 'sail/designated', labels: ['sail', 'needs review/now'] }],
  });
  const capture = captureEvents();
  const removed = await host(on, capture.emit).removeLabel(7, 'needs review/now');
  expect({
    labels: removed.labels,
    sent: on.routes(),
    held: on.pullRequests[0]?.labels,
    events: capture.events,
  }).toEqual({
    labels: ['sail'],
    sent: ['GET /repos/o/r/pulls/7', 'DELETE /repos/o/r/issues/7/labels/needs%20review%2Fnow'],
    held: ['sail'],
    events: [{ type: 'codehost:labelled', number: 7, label: 'needs review/now', change: 'removed' }],
  });
});

test('a label named . or .. is refused as invalid before anything is sent, though the pull request holds it', async () => {
  const on = world({ pullRequests: [{ number: 7, head: 'sail/designated', labels: ['sail', '.', '..'] }] });
  const capture = captureEvents();
  const adapter = host(on, capture.emit);
  const failures = [
    portFailure(await rejection(adapter.removeLabel(7, '.'))),
    portFailure(await rejection(adapter.removeLabel(7, '..'))),
  ];
  expect({ failures, sent: on.routes(), held: on.pullRequests[0]?.labels, events: capture.events }).toEqual({
    failures: [
      { port: 'codeHost', op: 'removeLabel', code: 'invalid' },
      { port: 'codeHost', op: 'removeLabel', code: 'invalid' },
    ],
    sent: [],
    held: ['sail', '.', '..'],
    events: [],
  });
});

test('a label named ... is still deleted by its own path', async () => {
  const on = world({ pullRequests: [{ number: 7, head: 'sail/designated', labels: ['sail', '...'] }] });
  const capture = captureEvents();
  const removed = await host(on, capture.emit).removeLabel(7, '...');
  expect({ labels: removed.labels, sent: on.routes(), held: on.pullRequests[0]?.labels }).toEqual({
    labels: ['sail'],
    sent: ['GET /repos/o/r/pulls/7', 'DELETE /repos/o/r/issues/7/labels/...'],
    held: ['sail'],
  });
});

test('a 404 on the DELETE, the label gone in a race, answers a fresh read of the labels and emits nothing', async () => {
  const on = world();
  const capture = captureEvents();
  on.inject('DELETE /issues/7/labels/sail', { status: 404, body: { message: 'Label does not exist' } });
  const removed = await host(on, capture.emit).removeLabel(7, 'sail');
  expect({ labels: removed.labels, sent: on.routes(), events: capture.events }).toEqual({
    labels: ['sail'],
    sent: ['GET /repos/o/r/pulls/7', 'DELETE /repos/o/r/issues/7/labels/sail', 'GET /repos/o/r/pulls/7'],
    events: [],
  });
});

test('adding a label the pull request holds in other case sends only the read, answers its labels, and emits nothing', async () => {
  const on = world();
  const capture = captureEvents();
  const added = await host(on, capture.emit).addLabel(7, 'SAIL');
  expect({ sent: sentSince(on, 0), labels: added.labels, events: capture.events }).toEqual({
    sent: [['GET', '/repos/o/r/pulls/7']],
    labels: ['sail'],
    events: [],
  });
});

test('removing a label the pull request holds in other case deletes the held name and emits codehost:labelled naming it', async () => {
  const on = world();
  const capture = captureEvents();
  const removed = await host(on, capture.emit).removeLabel(7, 'SAIL');
  expect({
    sent: sentSince(on, 0),
    labels: removed.labels,
    held: on.pullRequests.find((pr) => pr.number === 7)?.labels,
    events: capture.events,
  }).toEqual({
    sent: [
      ['GET', '/repos/o/r/pulls/7'],
      ['DELETE', '/repos/o/r/issues/7/labels/sail'],
    ],
    labels: [],
    held: [],
    events: [{ type: 'codehost:labelled', number: 7, label: 'sail', change: 'removed' }],
  });
});

test('opening again with a label the pull request holds in other case asks for no label and emits nothing', async () => {
  const on = world();
  const capture = captureEvents();
  const pr = await host(on, capture.emit).openPullRequest({
    base: 'main',
    head: 'sail/designated',
    title: 'T',
    body: '',
    labels: ['Sail'],
  });
  expect({
    number: pr.number,
    labels: pr.labels,
    routes: on.routes().map((route) => route.split('?')[0]),
    events: capture.events,
  }).toEqual({
    number: 7,
    labels: ['sail'],
    routes: ['GET /repos/o/r/pulls', 'GET /repos/o/r/pulls/7'],
    events: [],
  });
});

test("a label the repository has in other case is answered and announced under the repository's name", async () => {
  const on = world({ repositoryLabels: ['sail', 'Needs-Review'] });
  const capture = captureEvents();
  const added = await host(on, capture.emit).addLabel(7, 'needs-review');
  expect({ sent: sentSince(on, 0), labels: added.labels, events: capture.events }).toEqual({
    sent: [
      ['GET', '/repos/o/r/pulls/7'],
      ['POST', '/repos/o/r/issues/7/labels', { labels: ['needs-review'] }],
    ],
    labels: ['sail', 'Needs-Review'],
    events: [{ type: 'codehost:labelled', number: 7, label: 'Needs-Review', change: 'added' }],
  });
});

test('labels asked twice in different case are sent once', async () => {
  const on = world();
  const capture = captureEvents();
  const pr = await host(on, capture.emit).openPullRequest({
    base: 'main',
    head: 'sail/designated',
    title: 'T',
    body: '',
    labels: ['needs-review', 'NEEDS-REVIEW'],
  });
  expect({
    labels: pr.labels,
    asked: on.requests.flatMap((request) => (request.body === undefined ? [] : [request.body])),
    events: capture.events,
  }).toEqual({
    labels: ['sail', 'needs-review'],
    asked: [{ labels: ['needs-review'] }],
    events: [{ type: 'codehost:labelled', number: 7, label: 'needs-review', change: 'added' }],
  });
});

/** Pull request 7's head sha in `on`. */
const headOf7 = (on: GitHubWorld): string => on.pullRequests.find((pr) => pr.number === 7)?.headSha ?? '';

test('every check run status and conclusion GitHub documents, and every commit status state, reads as its check status, and what GitHub does not document reads as failed', async () => {
  const runs: [string, string | null, CheckStatus][] = [
    ['queued', null, 'pending'],
    ['in_progress', null, 'pending'],
    ['waiting', null, 'pending'],
    ['requested', null, 'pending'],
    ['pending', null, 'pending'],
    ['completed', 'success', 'passed'],
    ['completed', 'neutral', 'skipped'],
    ['completed', 'skipped', 'skipped'],
    ['completed', 'failure', 'failed'],
    ['completed', 'cancelled', 'failed'],
    ['completed', 'timed_out', 'failed'],
    ['completed', 'action_required', 'failed'],
    ['completed', 'stale', 'failed'],
    ['completed', null, 'failed'],
    ['completed', 'mystery', 'failed'],
  ];
  const statuses: [string, CheckStatus][] = [
    ['pending', 'pending'],
    ['success', 'passed'],
    ['failure', 'failed'],
    ['error', 'failed'],
    ['mystery', 'failed'],
  ];
  const on = world({
    pullRequests: [
      {
        number: 7,
        head: 'sail/designated',
        labels: ['sail'],
        checkRuns: [
          ...runs.map(([status, conclusion], i) => ({ name: `run-${i}`, status, conclusion })),
          {
            name: 'linked',
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://h',
            details_url: 'https://d',
          },
          { name: 'detailed', status: 'completed', conclusion: 'success', html_url: null, details_url: 'https://d' },
        ],
        statuses: [
          ...statuses.map(([state], i) => ({ context: `status-${i}`, state })),
          { context: 'targeted', state: 'success', target_url: 'https://t' },
        ],
      },
    ],
  });
  const read = await settle(host(on).checks(7));
  expect('rejected' in read ? read : read.checks).toEqual([
    ...runs.map(([, , status], i) => ({ name: `run-${i}`, status })),
    { name: 'linked', status: 'passed', url: 'https://h' },
    { name: 'detailed', status: 'passed', url: 'https://d' },
    ...statuses.map(([, status], i) => ({ name: `status-${i}`, status })),
    { name: 'targeted', status: 'passed', url: 'https://t' },
  ]);
});

test('a read of checks asks for pull request 7, then the check runs and the status of its head sha, and emits one codehost:checks', async () => {
  const on = suiteWorld();
  const capture = captureEvents();
  const read = await settle(host(on, capture.emit).checks(7));
  const sha = headOf7(on);
  expect({ read: 'rejected' in read ? read : read.checks, sent: on.routes(), events: capture.events }).toEqual({
    read: [
      { name: 'build', status: 'passed' },
      { name: 'deploy', status: 'pending' },
    ],
    sent: [
      'GET /repos/o/r/pulls/7',
      `GET /repos/o/r/commits/${sha}/check-runs?per_page=100&page=1`,
      `GET /repos/o/r/commits/${sha}/status?per_page=100&page=1`,
    ],
    events: [
      {
        type: 'codehost:checks',
        number: 7,
        headSha: sha,
        checks: [
          { name: 'build', status: 'passed' },
          { name: 'deploy', status: 'pending' },
        ],
      },
    ],
  });
});

/** A world whose pull request 7 has `count` passing check runs. */
const manyRuns = (count: number) =>
  world({
    pullRequests: [
      {
        number: 7,
        head: 'sail/designated',
        checkRuns: Array.from({ length: count }, (_, i) => ({
          name: `ci-${i}`,
          status: 'completed',
          conclusion: 'success',
        })),
      },
    ],
  });

test('150 check runs are read across two pages of 100, all of them, in order', async () => {
  const on = manyRuns(150);
  const read = await settle(host(on).checks(7));
  expect({
    names: 'rejected' in read ? read : read.checks.map((check) => check.name),
    pages: on
      .routes()
      .filter((route) => route.includes('/check-runs'))
      .map((route) => route.split('?')[1]),
  }).toEqual({
    names: Array.from({ length: 150 }, (_, i) => `ci-${i}`),
    pages: ['per_page=100&page=1', 'per_page=100&page=2'],
  });
});

test('more than 1000 check runs reject as unavailable, naming the head sha, and emit nothing', async () => {
  const on = manyRuns(1001);
  const capture = captureEvents();
  const error = await rejection(host(on, capture.emit).checks(7));
  expect({
    error: error instanceof PortError ? [error.code, error.message] : String(error),
    events: capture.events,
  }).toEqual({
    error: ['unavailable', `codeHost.checks: more than 1000 checks on ${headOf7(on)}`],
    events: [],
  });
});

test.each<[string, string, unknown, (sha: string) => string]>([
  [
    'a check-runs page with no list',
    'check-runs',
    { total_count: 1 },
    (sha) => `GitHub's check-runs answer for ${sha} holds no list and total_count`,
  ],
  [
    'a check-runs page with no total_count',
    'check-runs',
    { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] },
    (sha) => `GitHub's check-runs answer for ${sha} holds no list and total_count`,
  ],
  [
    'a check-runs page that ends before total_count',
    'check-runs',
    { total_count: 1, check_runs: [] },
    (sha) => `GitHub listed 0 of 1 check-runs on ${sha}`,
  ],
  [
    'a status page whose list is no array',
    'status',
    { total_count: 1, statuses: 'failure' },
    (sha) => `GitHub's status answer for ${sha} holds no list and total_count`,
  ],
  [
    'a status page that ends before total_count',
    'status',
    { total_count: 2, statuses: [] },
    (sha) => `GitHub listed 0 of 2 status on ${sha}`,
  ],
])(
  '%s rejects the read as unavailable, and emits nothing: an unread check never passes',
  async (_, endpoint, body, message) => {
    const on = world();
    const sha = headOf7(on);
    on.inject(`GET /commits/${sha}/${endpoint}`, { status: 200, body });
    const capture = captureEvents();
    const error = await rejection(host(on, capture.emit).checks(7));
    expect({
      error: error instanceof PortError ? [error.code, error.message] : String(error),
      events: capture.events,
    }).toEqual({ error: ['unavailable', `codeHost.checks: ${message(sha)}`], events: [] });
  },
);

test.each<[string, 'check-runs' | 'status', unknown, unknown]>([
  [
    'check runs',
    'check-runs',
    {
      total_count: 150,
      check_runs: Array.from({ length: 100 }, (_, i) => ({
        name: `ci-${i}`,
        status: 'completed',
        conclusion: 'success',
      })),
    },
    { total_count: 0, check_runs: [] },
  ],
  [
    'commit statuses',
    'status',
    { total_count: 150, statuses: Array.from({ length: 100 }, (_, i) => ({ context: `ci-${i}`, state: 'success' })) },
    { total_count: 100, statuses: [] },
  ],
])(
  '%s whose total_count changes between pages reject as unavailable, and emit nothing',
  async (_, endpoint, first, second) => {
    const on = world();
    const sha = headOf7(on);
    on.inject(`GET /commits/${sha}/${endpoint}`, { status: 200, body: first });
    on.inject(`GET /commits/${sha}/${endpoint}`, { status: 200, body: second });
    const capture = captureEvents();
    const error = await rejection(host(on, capture.emit).checks(7));
    const changed = (second as { total_count: number }).total_count;
    expect({
      error: error instanceof PortError ? [error.code, error.message] : String(error),
      events: capture.events,
    }).toEqual({
      error: [
        'unavailable',
        `codeHost.checks: GitHub's ${endpoint} count for ${sha} changed from 150 to ${changed} while it was read`,
      ],
      events: [],
    });
  },
);

test('checks of a pull request GitHub does not have reject as not_found, with no request for any commit', async () => {
  const on = world();
  const error = await rejection(host(on).checks(99));
  expect([portFailure(error), on.routes()]).toEqual([
    { port: 'codeHost', op: 'checks', code: 'not_found' },
    ['GET /repos/o/r/pulls/99'],
  ]);
});

/** A pull request's head sha in `on`. */
const headIn = (on: GitHubWorld, number: number): string =>
  on.pullRequests.find((pr) => pr.number === number)?.headSha ?? '';

test('a merge reads the pull request, then sends exactly { merge_method, sha } and nothing else, and records the merge GitHub reports with its sha', async () => {
  const on = suiteWorld();
  const capture = captureEvents();
  const head = headIn(on, 10);
  const result = await settle(host(on, capture.emit).merge(10, { method: 'squash', expectedHeadSha: head }));
  const sha = worldMergeSha(10, head);
  expect({
    result: 'rejected' in result ? result : { ...result, raw: undefined },
    sent: sentSince(on, 0),
    events: capture.events,
  }).toEqual({
    result: { state: 'merged', sha, raw: undefined },
    sent: [
      ['GET', '/repos/o/r/pulls/10'],
      ['PUT', '/repos/o/r/pulls/10/merge', { merge_method: 'squash', sha: head }],
    ],
    events: [{ type: 'codehost:merged', number: 10, method: 'squash', sha }],
  });
});

test('a merge whose expected head is stale is refused after only the read: no merge request is sent', async () => {
  const on = suiteWorld();
  const capture = captureEvents();
  const stale = '0'.repeat(40);
  const result = await settle(host(on, capture.emit).merge(10, { method: 'merge', expectedHeadSha: stale }));
  expect({
    result: 'rejected' in result ? result : { ...result, raw: undefined },
    sent: on.routes(),
    state: on.pullRequests.find((pr) => pr.number === 10)?.mergedAt,
    events: capture.events,
  }).toEqual({
    result: {
      state: 'refused',
      reason: `head moved: expected ${stale}, pull request #10 is at ${headIn(on, 10)}`,
      raw: undefined,
    },
    sent: ['GET /repos/o/r/pulls/10'],
    state: null,
    events: [],
  });
});

test.each<[string, number, { status: number; body: unknown } | undefined, string]>([
  [
    'a 409, the head pushed after the read,',
    10,
    { status: 409, body: { message: 'Head branch was modified. Review and try the merge again.' } },
    'codeHost.merge: GitHub 409: Head branch was modified. Review and try the merge again.',
  ],
  [
    'a 405, a pull request GitHub will not merge,',
    11,
    undefined,
    'codeHost.merge: GitHub 405: Pull Request is not mergeable',
  ],
])(
  "%s rejects the merge as conflict with GitHub's message, and emits nothing",
  async (_, number, injected, message) => {
    const on = suiteWorld();
    if (injected !== undefined) on.inject(`PUT /pulls/${number}/merge`, injected);
    const capture = captureEvents();
    const error = await rejection(
      host(on, capture.emit).merge(number, { method: 'squash', expectedHeadSha: headIn(on, number) }),
    );
    expect({
      error: error instanceof PortError ? [error.code, error.message] : String(error),
      merged: on.pullRequests.find((pr) => pr.number === number)?.mergedAt,
      events: capture.events,
    }).toEqual({ error: ['conflict', message], merged: null, events: [] });
  },
);

test.each<[string, unknown, string]>([
  [
    'merged true with no sha',
    { merged: true, message: 'Pull Request successfully merged' },
    'GitHub reports #10 merged without its merge commit',
  ],
  [
    'merged true with a sha that is no sha',
    { merged: true, sha: 'abc' },
    'GitHub reports #10 merged without its merge commit',
  ],
  ['merged false', { merged: false, message: 'Merge already in progress' }, 'Merge already in progress'],
  ['no merged at all', {}, 'GitHub answered without reporting the merge'],
])('a 200 of %s is pending, with no event', async (_, body, reason) => {
  const on = suiteWorld();
  on.inject('PUT /pulls/10/merge', { status: 200, body });
  const capture = captureEvents();
  const result = await settle(host(on, capture.emit).merge(10, { method: 'squash', expectedHeadSha: headIn(on, 10) }));
  expect({ result: 'rejected' in result ? result : { ...result, raw: undefined }, events: capture.events }).toEqual({
    result: { state: 'pending', reason, raw: undefined },
    events: [],
  });
});

test('merging a pull request GitHub reports merged answers its merge commit after only the read, and emits nothing again', async () => {
  const on = suiteWorld();
  const capture = captureEvents();
  const adapter = host(on, capture.emit);
  const head = headIn(on, 10);
  await settle(adapter.merge(10, { method: 'rebase', expectedHeadSha: head }));
  const [from, emitted] = [on.requests.length, capture.events.length];
  // Even with another head named: the pull request is merged, and saying otherwise would be dishonest.
  const again = await settle(adapter.merge(10, { method: 'rebase', expectedHeadSha: '0'.repeat(40) }));
  expect({
    again: 'rejected' in again ? again : { ...again, raw: undefined },
    sent: on.routes().slice(from),
    events: capture.events.slice(emitted),
  }).toEqual({
    again: { state: 'merged', sha: worldMergeSha(10, head), raw: undefined },
    sent: ['GET /repos/o/r/pulls/10'],
    events: [],
  });
});

test("parseRef takes a number, #number or this repository's pull URL, whole, with a trailing slash or anchor, and nothing else", () => {
  const adapter = host(world());
  const refs = [
    '12',
    '#12',
    'https://github.com/o/r/pull/12',
    'https://github.com/o/r/pull/12/',
    'https://github.com/o/r/pull/12#discussion',
    'https://github.com/o/other/pull/12',
    'https://github.com/o/r/pull/12/files',
    '0',
    '07',
    '12abc',
  ];
  expect(refs.map((ref) => adapter.parseRef(ref))).toEqual([
    12,
    12,
    12,
    12,
    12,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});

test('addLabel and comment on a number that is an issue, not a pull request, reject as not_found and change nothing', async () => {
  const on = world();
  const adapter = host(on);
  const errors = [await rejection(adapter.addLabel(9, 'sail')), await rejection(adapter.comment(9, 'hello'))];
  expect({
    failures: errors.map(portFailure),
    posts: on.requests.filter((request) => request.method === 'POST').length,
  }).toEqual({
    failures: [
      { port: 'codeHost', op: 'addLabel', code: 'not_found' },
      { port: 'codeHost', op: 'comment', code: 'not_found' },
    ],
    posts: 0,
  });
});

test('a ticket key that could close the marker, holding --> or a space, is refused as invalid before any request', async () => {
  const on = world();
  const adapter = host(on);
  const request = { base: 'main', head: 'sail/designated', title: 'T', body: '' };
  const errors = [
    await rejection(adapter.openPullRequest({ ...request, ticketKey: 'FAKE-1 --> <script>' })),
    await rejection(adapter.openPullRequest({ ...request, ticketKey: 'FAKE 1' })),
  ];
  expect([errors.map(portFailure), on.requests]).toEqual([
    [
      { port: 'codeHost', op: 'openPullRequest', code: 'invalid' },
      { port: 'codeHost', op: 'openPullRequest', code: 'invalid' },
    ],
    [],
  ]);
});

test('with every request answered 401 echoing the token, no message, raw or event of any operation holds it', async () => {
  const on = world();
  const capture = captureEvents();
  const adapter = host(on, capture.emit);
  on.inject('*', { status: 401, body: { message: `Bad credentials: ${TOKEN}`, token: TOKEN, [TOKEN]: 1 } }, 100);
  const { cwd, branch } = pushable();
  const errors = [
    await rejection(adapter.push(cwd, branch)),
    await rejection(
      // A title or body that holds the token is refused before any request (review R1-10): this one is GitHub's echo.
      adapter.openPullRequest({ base: 'main', head: branch, title: 'Add a flag', body: 'The body.', labels: ['sail'] }),
    ),
    await rejection(adapter.getPullRequest(7)),
    await rejection(adapter.addLabel(7, 'sail')),
    await rejection(adapter.comment(7, 'hello')),
  ];
  const said = JSON.stringify([
    errors.map((error) => (error instanceof PortError ? [error.code, error.message, error.raw] : String(error))),
    capture.events,
  ]);
  expect({
    codes: errors.map((error) => (error instanceof PortError ? error.code : String(error))),
    marker: said.includes('MARKER'),
    redacted: said.includes('Bad credentials: [redacted]'),
    tokenSent: on.requests.length > 0 && on.requests.every((request) => request.tokenMatched),
  }).toEqual({
    codes: ['unauthorized', 'unauthorized', 'unauthorized', 'unauthorized', 'unauthorized'],
    marker: false,
    redacted: true,
    tokenSent: true,
  });
});

// listDesignated and the details (14.2's D11).

/** `count` open pull requests, numbered from `count` down to 1, as GitHub lists the newest first: `fields` for each. */
const many = (count: number, fields: (number: number) => Partial<WorldSeedPull> = () => ({})): WorldSeedPull[] =>
  Array.from({ length: count }, (_, at) => count - at).map((number) => ({
    number,
    head: `sail/many-${number}`,
    // A head sha of its own, so the world runs no git to look each branch up.
    headSha: number.toString(16).padStart(40, '0'),
    ...fields(number),
  }));

test('listDesignated reads the open pull requests 100 to a page until a short page, and lists the labelled ones that are no draft by number', async () => {
  const on = world({
    pullRequests: many(150, (number) => ({
      labels: number % 50 === 0 || number === 149 ? ['sail'] : [],
      draft: number === 149,
    })),
  });
  const listed = await settle(host(on).listDesignated('sail'));
  expect({ numbers: 'rejected' in listed ? listed : listed.map((pr) => pr.number), routes: on.routes() }).toEqual({
    numbers: [50, 100, 150],
    routes: [
      'GET /repos/o/r/pulls?state=open&per_page=100&page=1',
      'GET /repos/o/r/pulls?state=open&per_page=100&page=2',
    ],
  });
});

test('listDesignated reads at most 10 pages: a 10th page that is full rejects as invalid, and no 11th is asked for', async () => {
  const on = world({ pullRequests: many(1001, (number) => ({ labels: number === 1 ? ['sail'] : [] })) });
  const error = await rejection(host(on).listDesignated('sail'));
  expect({ failure: portFailure(error), pages: on.routes().length, last: on.routes().at(-1) }).toEqual({
    failure: { port: 'codeHost', op: 'listDesignated', code: 'invalid' },
    pages: 10,
    last: 'GET /repos/o/r/pulls?state=open&per_page=100&page=10',
  });
});

test("a fork's pull request, open and labelled, is never listed, a deleted fork's head counts as one, and the details read fork: true for both", async () => {
  const on = world({
    pullRequests: [
      { number: 7, head: 'sail/designated', labels: ['sail'] },
      { number: 13, head: 'patch-1', labels: ['sail'], fork: true, headSha: 'a'.repeat(40) },
      { number: 14, head: 'patch-2', labels: ['sail'], fork: 'deleted', headSha: 'b'.repeat(40) },
    ],
  });
  const adapter = host(on);
  const forks = await Promise.all([7, 13, 14].map(async (number) => (await adapter.getPullRequest(number)).fork));
  const listed = await settle(adapter.listDesignated('sail'));
  expect({ listed: 'rejected' in listed ? listed : listed.map((pr) => pr.number), forks }).toEqual({
    listed: [7],
    forks: [false, true, true],
  });
});

test("getPullRequest reads the pull request, then its conversation comments 100 to a page, oldest first: a null body reads '', with the author's login and GitHub's base sha, and a missing one asks for no comments", async () => {
  const comments = Array.from({ length: 101 }, (_, at) => ({ user: `reviewer-${at + 1}`, body: `Comment ${at + 1}.` }));
  const on = world({
    pullRequests: [{ number: 7, head: 'sail/designated', labels: ['sail'], body: null, user: 'ada', comments }],
  });
  const adapter = host(on);
  const pr = await adapter.getPullRequest(7);
  const read = on.routes();
  const missing = await rejection(adapter.getPullRequest(99));
  const main = Bun.spawnSync(['git', 'rev-parse', 'main'], { cwd: repo().origin, env: repo().env });
  expect({
    read,
    body: pr.body,
    author: pr.author,
    baseSha: pr.baseSha,
    comments: [pr.comments?.length, pr.comments?.[0], pr.comments?.at(-1)?.body],
    missing: [portFailure(missing), on.routes().slice(read.length)],
  }).toEqual({
    read: [
      'GET /repos/o/r/pulls/7',
      'GET /repos/o/r/issues/7/comments?per_page=100&page=1',
      'GET /repos/o/r/issues/7/comments?per_page=100&page=2',
    ],
    body: '',
    author: 'ada',
    baseSha: main.stdout.toString().trim(),
    comments: [
      101,
      { author: 'reviewer-1', body: 'Comment 1.', createdAt: '2026-10-01T00:00:00.000Z' },
      'Comment 101.',
    ],
    missing: [{ port: 'codeHost', op: 'getPullRequest', code: 'not_found' }, ['GET /repos/o/r/pulls/99']],
  });
});

test("with the pulls list and a pull request's comments answered 401 echoing the token, listDesignated and getPullRequest reject unauthorized, and neither error holds it", async () => {
  const on = world();
  const adapter = host(on);
  const echo = { status: 401, body: { message: `Bad credentials: ${TOKEN}`, token: TOKEN } };
  on.inject('GET /pulls', echo);
  on.inject('GET /issues/7/comments', echo);
  const errors = [await rejection(adapter.listDesignated('sail')), await rejection(adapter.getPullRequest(7))];
  const said = JSON.stringify(
    errors.map((error) => (error instanceof PortError ? [error.message, error.raw] : String(error))),
  );
  expect({
    failures: errors.map(portFailure),
    marker: said.includes('MARKER'),
    redacted: said.includes('Bad credentials: [redacted]'),
  }).toEqual({
    failures: [
      { port: 'codeHost', op: 'listDesignated', code: 'unauthorized' },
      { port: 'codeHost', op: 'getPullRequest', code: 'unauthorized' },
    ],
    marker: false,
    redacted: true,
  });
});
