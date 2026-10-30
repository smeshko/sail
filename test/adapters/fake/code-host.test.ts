// The fake CodeHost: the port suite over a copy of the fixture seed and a real git checkout to push from, then what only
// the fake does: scripted checks and merges, and state that outlives the instance (D1, D4, D14).
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeCodeHost } from '../../../src/adapters/fake/code-host';
import { PullRequestDetails } from '../../../src/ports/types';
import { holdTempRepo } from '../../helpers/held-repo';
import { captureEvents, parseIssues, portFailure, rejection } from '../../helpers/ports';
import { withTempRepo } from '../../helpers/temp-repo';
import { codeHostSuite } from '../../ports/code-host.suite';

const SEED = join(import.meta.dir, '..', '..', 'fixtures', 'repo', '.sail', 'fake', 'prs.json');
const repo = holdTempRepo();

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-fake-prs-'));
  dirs.push(dir);
  return dir;
}

/** A copy of the fixture seed, changed by `edit` when one is given, and a state file in a folder not yet made. */
function files(edit?: (seed: { pullRequests: Record<string, unknown>[] }) => void): { seed: string; state: string } {
  const dir = tempDir();
  const seed = join(dir, 'prs.json');
  const world = JSON.parse(readFileSync(SEED, 'utf8'));
  edit?.(world);
  writeFileSync(seed, JSON.stringify(world, null, 2));
  return { seed, state: join(dir, 'state', 'prs.json') };
}

let pushes = 0;

/** The fixture seed's pull request 1, open and not a draft, at the head the seed gives it. */
const PR_1_HEAD = 'b4efb0c5de84d87c1455d4504b8b75b095a8e10b';

/** A pull request the fixture seed lacks, open and ready unless `fields` say otherwise. */
const seeded = (number: number, fields: Record<string, unknown>) => ({
  number,
  title: `Pull request ${number}`,
  body: '',
  base: 'main',
  head: `sail/FAKE-${number}`,
  headSha: `${number}`.repeat(40).slice(0, 40),
  draft: false,
  state: 'open',
  labels: ['sail'],
  ...fields,
});

/** Pull request 4 of the seed, with its merges scripted as rejected. */
const rejecting = (seed: { pullRequests: Record<string, unknown>[] }) => {
  if (seed.pullRequests[3] !== undefined) seed.pullRequests[3].merges = ['rejected'];
};

/** The fixture seed with 4's merges rejected, an unlabelled pull request, 5, and a closed one that keeps its label, 6. */
const suiteSeed = (seed: { pullRequests: Record<string, unknown>[] }) => {
  rejecting(seed);
  seed.pullRequests.push(
    seeded(5, { labels: [] }),
    seeded(6, { state: 'closed' }),
    seeded(7, {
      checks: [{ name: 'verify', statuses: ['failed', 'passed'], log: '(fail) sail show prints a zero total' }],
    }),
  );
};

codeHostSuite('fake', async (emit) => ({
  adapter: createFakeCodeHost({ ...files(suiteSeed), env: repo().env, emit }),
  world: {
    label: 'sail',
    base: 'main',
    designated: 1,
    draft: 2,
    unlabelled: 5,
    closed: 6,
    missing: 99,
    pendingMerge: 3,
    rejectedMerge: 4,
    failedCheck: { number: 7, name: 'verify', log: '(fail) sail show prints a zero total' },
    mergeable: async () => ({ number: 1, headSha: PR_1_HEAD }),
    refs: [
      ['12', 12],
      ['#12', 12],
      ['fake://codehost/fixture/pull/12', 12],
    ],
    pushable: async () => {
      const { dir, git } = repo();
      const branch = `sail/push-${++pushes}`;
      git('checkout', '-q', '-b', branch);
      writeFileSync(join(dir, `${branch.replace('/', '-')}.txt`), `${branch}\n`);
      git('add', '.');
      git('commit', '-q', '-m', `commit on ${branch}`);
      return { cwd: dir, branch, headSha: git('rev-parse', 'HEAD') };
    },
  },
}));

test('listDesignated lists a pull request seeded with the label in upper case', async () => {
  const host = createFakeCodeHost(files((seed) => seed.pullRequests.push(seeded(7, { labels: ['SAIL'] }))));
  expect((await host.listDesignated('sail')).map((pr) => pr.number)).toContain(7);
});

test('addLabel and removeLabel match a label held in another case as the same label (review R1)', async () => {
  const host = createFakeCodeHost(files());
  expect((await host.addLabel(1, 'Sail')).labels).toEqual(['sail']);
  expect((await host.removeLabel(1, 'SAIL')).labels).toEqual([]);
});

test('checks scripted pending then failed read pending, then failed from then on', async () => {
  const host = createFakeCodeHost(files());
  const reads: unknown[] = [];
  for (let i = 0; i < 3; i++) reads.push((await host.checks(4)).checks);
  expect(reads).toEqual([
    [{ name: 'ci', status: 'pending' }],
    [{ name: 'ci', status: 'failed' }],
    [{ name: 'ci', status: 'failed' }],
  ]);
});

test('a pull request scripted with heads reports each on its checks read, the last repeating, and without them its headSha', async () => {
  const host = createFakeCodeHost(
    files((seed) => {
      Object.assign(seed.pullRequests[3] as object, { heads: ['a'.repeat(40), 'b'.repeat(40)] });
    }),
  );
  const reads: string[] = [];
  for (let i = 0; i < 3; i++) reads.push((await host.checks(4)).headSha);
  expect(reads).toEqual(['a'.repeat(40), 'b'.repeat(40), 'b'.repeat(40)]);
  const plain = createFakeCodeHost(files());
  expect((await plain.checks(4)).headSha).toBe((await plain.getPullRequest(4)).headSha);
});

test('checks scripted failed then passed read passed after the failed one is rerun, whether or not it was read first', async () => {
  const script = (seed: { pullRequests: Record<string, unknown>[] }) =>
    seed.pullRequests.push(seeded(7, { checks: [{ name: 'verify', statuses: ['failed', 'passed'] }] }));
  const unread = createFakeCodeHost(files(script));
  const read = createFakeCodeHost(files(script));
  const afterRerun = async (host: ReturnType<typeof createFakeCodeHost>, readFirst: boolean) => {
    const before = readFirst ? (await host.checks(7)).checks[0]?.status : undefined;
    const { rerun } = await host.rerunChecks(7);
    return { before, rerun, after: (await host.checks(7)).checks[0]?.status };
  };
  expect([await afterRerun(unread, false), await afterRerun(read, true)]).toEqual([
    { before: undefined, rerun: ['verify'], after: 'passed' },
    { before: 'failed', rerun: ['verify'], after: 'passed' },
  ]);
});

test('checkLog cuts a log over 20 000 characters to its last 20 000, and a check seeded without a log is not_found', async () => {
  const log = `${'a'.repeat(15_000)}${'b'.repeat(10_000)}`;
  const host = createFakeCodeHost(
    files((seed) =>
      seed.pullRequests.push(
        seeded(7, {
          checks: [
            { name: 'verify', statuses: ['failed'], log },
            { name: 'lint', statuses: ['passed'] },
          ],
        }),
      ),
    ),
  );
  const cut = await host.checkLog(7, 'verify');
  const failure = portFailure(await rejection(host.checkLog(7, 'lint')));
  expect({ length: cut.log.length, tail: cut.log === log.slice(-20_000), failure }).toEqual({
    length: 20_000,
    tail: true,
    failure: { port: 'codeHost', op: 'checkLog', code: 'not_found' },
  });
});

test('rerunChecks names only the checks whose current status is failed, and a passed one is left alone and not announced', async () => {
  const capture = captureEvents();
  const host = createFakeCodeHost({
    ...files((seed) =>
      seed.pullRequests.push(
        seeded(7, {
          checks: [
            { name: 'lint', statuses: ['passed'] },
            { name: 'unit', statuses: ['failed'] },
            { name: 'e2e', statuses: ['pending', 'failed'] },
          ],
        }),
      ),
    ),
    emit: capture.emit,
  });
  await host.checks(7);
  const { rerun } = await host.rerunChecks(7);
  expect({ rerun, events: capture.events.filter((event) => event.type === 'codehost:checks_rerun') }).toEqual({
    rerun: ['unit'],
    events: [{ type: 'codehost:checks_rerun', number: 7, headSha: '7'.repeat(40), checks: ['unit'] }],
  });
});

test('a merge scripted pending or refused says so, leaves the pull request open, and emits nothing', async () => {
  const capture = captureEvents();
  const host = createFakeCodeHost({
    ...files((seed) => {
      if (seed.pullRequests[0] !== undefined) seed.pullRequests[0].merges = ['refused'];
    }),
    emit: capture.emit,
  });
  const { raw: _refusedRaw, ...refused } = await host.merge(1, { method: 'merge', expectedHeadSha: PR_1_HEAD });
  const head3 = (await host.getPullRequest(3)).headSha;
  const { raw: _pendingRaw, ...pending } = await host.merge(3, { method: 'rebase', expectedHeadSha: head3 });
  expect([refused, pending]).toEqual([
    { state: 'refused', reason: 'fake: merge scripted refused' },
    { state: 'pending', reason: 'fake: merge scripted pending' },
  ]);
  expect([(await host.getPullRequest(1)).state, (await host.getPullRequest(3)).state]).toEqual(['open', 'open']);
  expect(capture.events).toEqual([]);
});

test('a stale or malformed expected head leaves the state file with nothing merged and the merge script unread, and a rejected merge reads it once and merges nothing', async () => {
  const world = files(rejecting);
  const capture = captureEvents();
  const host = createFakeCodeHost({ ...world, emit: capture.emit });
  const stale = await host.merge(1, { method: 'squash', expectedHeadSha: '0'.repeat(40) });
  const malformed = await rejection(host.merge(1, { method: 'squash', expectedHeadSha: 'b4efb0c' }));
  const head4 = (await host.getPullRequest(4)).headSha;
  const rejected = await rejection(host.merge(4, { method: 'squash', expectedHeadSha: head4 }));
  const state = JSON.parse(readFileSync(world.state, 'utf8'));
  const { raw: _raw, ...refused } = stale;
  expect({
    refused,
    malformed: malformed instanceof Error ? [portFailure(malformed), malformed.message] : malformed,
    rejected: rejected instanceof Error ? [portFailure(rejected), rejected.message] : rejected,
    after: state.pullRequests.map((pr: { state: string; reads: { merges: number } }) => [pr.state, pr.reads.merges]),
    events: capture.events,
  }).toEqual({
    refused: {
      state: 'refused',
      reason: `fake: head moved: expected ${'0'.repeat(40)}, pull request #1 is at ${PR_1_HEAD}`,
    },
    malformed: [
      { port: 'codeHost', op: 'merge', code: 'invalid' },
      'codeHost.merge: expectedHeadSha "b4efb0c" is not a 40-character hex sha',
    ],
    rejected: [{ port: 'codeHost', op: 'merge', code: 'conflict' }, 'codeHost.merge: fake: merge rejected (scripted)'],
    after: [
      ['open', 0],
      ['open', 0],
      ['open', 0],
      ['open', 1],
    ],
    events: [],
  });
});

test("a push to an open pull request's branch moves its head, and its scripted checks start again", async () => {
  const host = createFakeCodeHost({ ...files(), env: repo().env });
  const reads = [(await host.checks(4)).checks, (await host.checks(4)).checks];
  const { headSha } = await host.push(repo().dir, 'sail/FAKE-4');
  const after = await host.checks(4);
  expect({
    reads: reads.map((checks) => checks[0]?.status),
    pushed: headSha === repo().git('rev-parse', 'HEAD'),
    pr: (await host.getPullRequest(4)).headSha,
    checks: [after.headSha, after.checks[0]?.status],
  }).toEqual({ reads: ['pending', 'failed'], pushed: true, pr: headSha, checks: [headSha, 'pending'] });
});

test("a push records the workspace's own HEAD, even under a git hook's GIT_DIR naming another repository", async () => {
  await withTempRepo(async (other) => {
    writeFileSync(join(other.dir, 'other'), 'a different commit');
    other.git('add', 'other');
    other.git('commit', '-m', 'another repository');
    const ownHead = repo().git('rev-parse', 'HEAD');
    const otherHead = other.git('rev-parse', 'HEAD');
    const host = createFakeCodeHost({ ...files(), env: { ...repo().env, GIT_DIR: join(other.dir, '.git') } });
    const pushed = await host.push(repo().dir, 'sail/FAKE-9');
    expect(pushed.headSha).toBe(ownHead);
    expect(pushed.headSha).not.toBe(otherHead);
  });
});

/** Commits one file in `dir` and returns the new HEAD. */
function commitFile(r: { git(...args: string[]): string; dir: string }, name: string): string {
  writeFileSync(join(r.dir, name), name);
  r.git('add', name);
  r.git('commit', '-m', name);
  return r.git('rev-parse', 'HEAD');
}

test('a push writes refs/heads/<branch> in the repository', async () => {
  await withTempRepo(async (r) => {
    const host = createFakeCodeHost({ ...files(), env: r.env });
    const head = commitFile(r, 'one');
    await host.push(r.dir, 'sail/FAKE-20');
    expect(r.git('rev-parse', 'refs/heads/sail/FAKE-20')).toBe(head);
  });
});

test("a second push from a commit that doesn't descend from the branch is refused as conflict, leaving the state file as it was", async () => {
  await withTempRepo(async (r) => {
    const world = files();
    const host = createFakeCodeHost({ ...world, env: r.env });
    const first = commitFile(r, 'one');
    await host.push(r.dir, 'sail/FAKE-21');
    const before = readFileSync(world.state, 'utf8');
    r.git('reset', '--hard', 'HEAD~1');
    commitFile(r, 'other');
    const error = await rejection(host.push(r.dir, 'sail/FAKE-21'));
    expect([
      portFailure(error),
      readFileSync(world.state, 'utf8'),
      r.git('rev-parse', 'refs/heads/sail/FAKE-21'),
    ]).toEqual([{ port: 'codeHost', op: 'push', code: 'conflict' }, before, first]);
  });
});

test('a push that descends from the branch moves it', async () => {
  await withTempRepo(async (r) => {
    const host = createFakeCodeHost({ ...files(), env: r.env });
    commitFile(r, 'one');
    await host.push(r.dir, 'sail/FAKE-22');
    const second = commitFile(r, 'two');
    const pushed = await host.push(r.dir, 'sail/FAKE-22');
    expect([pushed.headSha, r.git('rev-parse', 'refs/heads/sail/FAKE-22')]).toEqual([second, second]);
  });
});

test('opening from a head never pushed, or pushing from outside a git checkout, is invalid', async () => {
  const host = createFakeCodeHost({ ...files(), env: repo().env });
  const errors = [
    await rejection(host.openPullRequest({ base: 'main', head: 'never-pushed', title: 'Nothing', body: '' })),
    await rejection(host.push(tempDir(), 'sail/nowhere')),
  ];
  expect(errors.map(portFailure)).toEqual([
    { port: 'codeHost', op: 'openPullRequest', code: 'invalid' },
    { port: 'codeHost', op: 'push', code: 'invalid' },
  ]);
});

test("a push to the fixture seed's default branch, main, rejects as invalid and leaves the state file byte for byte as it was", async () => {
  const world = files();
  const host = createFakeCodeHost({ ...world, env: repo().env });
  await host.push(repo().dir, 'sail/FAKE-9');
  const before = readFileSync(world.state, 'utf8');
  const error = await rejection(host.push(repo().dir, 'main'));
  expect([portFailure(error), readFileSync(world.state, 'utf8')]).toEqual([
    { port: 'codeHost', op: 'push', code: 'invalid' },
    before,
  ]);
});

test('a new instance on the same state file carries on where the last left off, and the seed is unchanged', async () => {
  const world = files();
  const seed = readFileSync(world.seed, 'utf8');
  const first = createFakeCodeHost(world);
  const request = { method: 'squash', expectedHeadSha: (await first.getPullRequest(3)).headSha } as const;
  expect((await first.merge(3, request)).state).toBe('pending');
  await first.addLabel(1, 'needs-review');

  const next = createFakeCodeHost(world);
  expect((await next.merge(3, request)).state).toBe('merged');
  expect((await next.getPullRequest(1)).labels).toEqual(['sail', 'needs-review']);
  expect(readFileSync(world.seed, 'utf8')).toBe(seed);
});

test("the fixture seed holds four pull requests, three of them designated, every capability, and nothing of FAKE-1's: no branch sail/FAKE-1 and no open pull request from it, so its run opens pull request 5", async () => {
  const host = createFakeCodeHost({ seed: SEED, state: join(tempDir(), 'prs.json') });
  const { number, url, base, head, headSha, ticketKey, state } = await host.getPullRequest(1);
  expect({ number, url, base, head, headSha, ticketKey, state }).toEqual({
    number: 1,
    url: 'fake://codehost/fixture/pull/1',
    base: 'main',
    head: 'sail/FAKE-5',
    headSha: 'b4efb0c5de84d87c1455d4504b8b75b095a8e10b',
    ticketKey: 'FAKE-5',
    state: 'open',
  });
  const seeded = await Promise.all([1, 2, 3, 4].map((each) => host.getPullRequest(each)));
  expect(seeded.map((pr) => [pr.head, pr.ticketKey])).toEqual([
    ['sail/FAKE-5', 'FAKE-5'],
    ['sail/FAKE-2', 'FAKE-2'],
    ['sail/FAKE-3', 'FAKE-3'],
    ['sail/FAKE-4', 'FAKE-4'],
  ]);
  expect(await rejection(host.getPullRequest(5))).toMatchObject({ code: 'not_found' });
  // Never pushed, rather than a conflict: the seed holds neither the branch nor a pull request from it.
  const opening = host.openPullRequest({ base: 'main', head: 'sail/FAKE-1', title: 'FAKE-1', body: '' });
  expect(await rejection(opening)).toMatchObject({ code: 'invalid', message: expect.stringContaining('never pushed') });
  expect((await host.listDesignated('sail')).map((pr) => pr.number)).toEqual([1, 3, 4]);
  expect(host.capabilities()).toEqual({
    checks: true,
    labels: true,
    drafts: true,
    mergeMethods: ['merge', 'squash', 'rebase'],
  });
});

test("getPullRequest answers the details: the seed's body, author, fork and comments, a comment posted since last, and a baseSha that is branches[base] unless the seed gives one; with neither it is invalid", async () => {
  const host = createFakeCodeHost(
    files((seed) => {
      Object.assign(seed.pullRequests[0] ?? {}, {
        author: 'ada',
        fork: true,
        baseSha: 'a'.repeat(40),
        comments: [{ author: 'bob', body: 'Looks good.' }],
      });
      seed.pullRequests.push(seeded(9, { base: 'release' }));
    }),
  );
  await host.comment(1, 'Checks passed.');
  const details = async (number: number) => {
    const { body, author, baseSha, fork, comments } = await host.getPullRequest(number);
    return { body, author, baseSha, fork, comments: comments?.map(({ author, body }) => `${author}: ${body}`) };
  };
  expect({
    issues: parseIssues(PullRequestDetails, await host.getPullRequest(1)),
    first: await details(1),
    second: await details(2),
    noBase: portFailure(await rejection(host.getPullRequest(9))),
  }).toEqual({
    issues: [],
    first: {
      body: "Links the changelog from the README's first section.",
      author: 'ada',
      baseSha: 'a'.repeat(40),
      fork: true,
      comments: ['bob: Looks good.', 'sail: Checks passed.'],
    },
    second: {
      body: 'Adds `--version`.',
      author: 'sail',
      baseSha: 'f569e7f50659194ebd39f2f141e95091f40791da',
      fork: false,
      comments: [],
    },
    noBase: { port: 'codeHost', op: 'getPullRequest', code: 'invalid' },
  });
});

test("parseRef takes a number, #number or this remote's pull URL, whole, and nothing else", () => {
  const host = createFakeCodeHost(files());
  const refs = ['7', '#7', 'fake://codehost/fixture/pull/7', 'fake://codehost/other/pull/7', '#x', '7a', 'pull/7'];
  expect(refs.map((ref) => host.parseRef(ref))).toEqual([7, 7, 7, undefined, undefined, undefined, undefined]);
});

test('listDesignated leaves out a fork, as a designated pull request has its head in this repository (review R1-3)', async () => {
  const host = createFakeCodeHost(
    files((seed) => {
      seed.pullRequests.push(seeded(5, { fork: true }), seeded(6, { fork: false }));
    }),
  );
  expect((await host.listDesignated('sail')).map((pr) => pr.number)).toEqual([1, 3, 4, 6]);
});

test('a seed with unavailable.push 2 fails the first two pushes as unavailable and lets the third through', async () => {
  await withTempRepo(async (r) => {
    const world = files((seed) => Object.assign(seed, { unavailable: { push: 2 } }));
    const host = createFakeCodeHost({ ...world, env: r.env });
    const head = commitFile(r, 'one');
    const tries: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const outcome = await host.push(r.dir, 'sail/FAKE-30').then(
        (pushed) => pushed.headSha,
        (error) => portFailure(error),
      );
      tries.push(outcome);
      if (i === 1) {
        expect(
          Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', 'refs/heads/sail/FAKE-30'], {
            cwd: r.dir,
            env: r.env,
          }).exitCode,
        ).toBe(1);
        expect(JSON.parse(readFileSync(world.state, 'utf8')).branches['sail/FAKE-30']).toBeUndefined();
      }
    }
    const unavailable = { port: 'codeHost', op: 'push', code: 'unavailable' };
    expect(tries).toEqual([unavailable, unavailable, head]);
    expect(r.git('rev-parse', 'refs/heads/sail/FAKE-30')).toBe(head);
  });
});
