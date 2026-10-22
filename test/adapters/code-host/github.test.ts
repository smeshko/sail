// The github CodeHost: the port suite offline, on a scripted GitHub whose branches are a real bare origin, then what only
// the adapter does. Opening again answers the open pull request (DECISIONS D2), the default branch is refused (D3), the
// ticket key rides in the body (D9), the operations Epic 14 has yet to add aren't offered (D5) and the token leaves in
// nothing (D11). listDesignated pages through the open pull requests and keeps only the designated ones of this
// repository, and getPullRequest reads the details with the conversation comments, paged (14.2's D11).
//
// Against GitHub itself, the suite runs only when SAIL_LIVE_CODE_HOST=1 (D14), on the sandbox repository that
// SAIL_LIVE_GITHUB_REPOSITORY names, pushing from the clone SAIL_LIVE_GITHUB_CLONE, with SAIL_LIVE_GITHUB_LABEL, the
// designated pull request SAIL_LIVE_GITHUB_DESIGNATED, an open draft labelled SAIL_LIVE_GITHUB_DRAFT, an open one
// without the label SAIL_LIVE_GITHUB_UNLABELLED and a closed labelled one SAIL_LIVE_GITHUB_CLOSED. The token comes from
// SAIL_GITHUB_TOKEN or GITHUB_TOKEN. Without the switch the live suite is not registered at all.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGitHubCodeHost, type GitHubCodeHostOptions } from '../../../src/adapters/code-host/github';
import type { ProviderEmit } from '../../../src/events/types';
import type { CodeHost } from '../../../src/ports/code-host';
import { PortError } from '../../../src/ports/errors';
import {
  createGitHubWorld,
  type GitHubWorld,
  type GitHubWorldSeed,
  WORLD_API,
  type WorldSeedPull,
} from '../../helpers/github-world';
import { holdTempRepo } from '../../helpers/held-repo';
import { withOrigin } from '../../helpers/origin';
import { captureEvents, portFailure, rejection, settle } from '../../helpers/ports';
import type { TempRepo } from '../../helpers/temp-repo';
import { type CodeHostWorld, codeHostSuite, type Unsupported } from '../../ports/code-host.suite';

const TOKEN = 'ghp_MARKER_adapter_0a7e44c2';
const UNSUPPORTED: Unsupported[] = ['checks', 'merge', 'removeLabel'];
const held = holdTempRepo();

let origin: string | undefined;
let commits = 0;

/** The held repository, with a bare origin on its first call, and a branch for the seeded pull requests. */
function repo(): TempRepo & { origin: string } {
  const repository = held();
  if (origin === undefined) {
    origin = withOrigin(repository).url;
    for (const branch of ['sail/designated', 'sail/draft']) {
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

const offline: CodeHostWorld = {
  label: 'sail',
  base: 'main',
  designated: 7,
  draft: 8,
  unlabelled: 5,
  closed: 6,
  missing: 99,
  refs: [
    ['7', 7],
    ['#7', 7],
    ['https://github.com/o/r/pull/7', 7],
  ],
  pushable: async () => pushable(),
};

describe('the port suite, offline', () => {
  codeHostSuite(
    'github',
    async (emit) => {
      const on = world();
      return { adapter: host(on, emit), world: offline };
    },
    [],
    UNSUPPORTED,
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
  codeHostSuite(
    'github (live)',
    async (emit) => {
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
      return {
        adapter: createGitHubCodeHost({
          owner,
          repo: name,
          token: sandbox.token,
          apiUrl: 'https://api.github.com',
          env,
          emit,
        }),
        world: {
          label: sandbox.label,
          base: 'main',
          designated: sandbox.designated,
          draft: sandbox.draft,
          unlabelled: sandbox.unlabelled,
          closed: sandbox.closed,
          missing: 999_999,
          refs: [[`https://github.com/${sandbox.repository}/pull/${sandbox.designated}`, sandbox.designated]],
          pushable: async () => {
            git('fetch', '-q', 'origin', 'main');
            git('checkout', '-q', '--detach', 'origin/main');
            const branch = `sail-live/${Date.now()}-${++pushes}`;
            writeFileSync(join(sandbox.clone, `${branch.replaceAll('/', '-')}.txt`), `${branch}\n`);
            git('add', '.');
            git('commit', '-q', '-m', `sail live suite: ${branch}`);
            return { cwd: sandbox.clone, branch, headSha: git('rev-parse', 'HEAD') };
          },
        },
      };
    },
    [],
    UNSUPPORTED,
  );
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

test("checks, merge and removeLabel reject as invalid, saying github doesn't support them yet, with no request and no event", async () => {
  const on = world();
  const capture = captureEvents();
  const adapter = host(on, capture.emit);
  const errors = [
    await rejection(adapter.checks(7)),
    await rejection(adapter.merge(7, 'squash')),
    await rejection(adapter.removeLabel(7, 'sail')),
  ];
  expect({
    errors: errors.map((error) => (error instanceof PortError ? [error.code, error.message] : String(error))),
    requests: on.requests.length,
    events: capture.events,
    capabilities: adapter.capabilities(),
  }).toEqual({
    errors: ['checks', 'merge', 'removeLabel'].map((op) => [
      'invalid',
      `codeHost.${op}: github doesn't support ${op} yet`,
    ]),
    requests: 0,
    events: [],
    capabilities: { checks: false, labels: true, drafts: true, mergeMethods: [] },
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
