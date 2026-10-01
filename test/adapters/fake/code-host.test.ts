// The fake CodeHost: the port suite over a copy of the fixture seed and a real git checkout to push from, then what only
// the fake does: scripted checks and merges, and state that outlives the instance (D1, D4, D14).
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeCodeHost } from '../../../src/adapters/fake/code-host';
import { holdTempRepo } from '../../helpers/held-repo';
import { captureEvents, portFailure, rejection } from '../../helpers/ports';
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

codeHostSuite('fake', async (emit) => ({
  adapter: createFakeCodeHost({ ...files(), env: repo().env, emit }),
  world: {
    label: 'sail',
    base: 'main',
    designated: 1,
    draft: 2,
    missing: 99,
    pendingMerge: 3,
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

test('a merge scripted pending or refused says so, leaves the pull request open, and emits nothing', async () => {
  const capture = captureEvents();
  const host = createFakeCodeHost({
    ...files((seed) => {
      if (seed.pullRequests[0] !== undefined) seed.pullRequests[0].merges = ['refused'];
    }),
    emit: capture.emit,
  });
  const { raw: _refusedRaw, ...refused } = await host.merge(1, 'merge');
  const { raw: _pendingRaw, ...pending } = await host.merge(3, 'rebase');
  expect([refused, pending]).toEqual([
    { state: 'refused', reason: 'fake: merge scripted refused' },
    { state: 'pending', reason: 'fake: merge scripted pending' },
  ]);
  expect([(await host.getPullRequest(1)).state, (await host.getPullRequest(3)).state]).toEqual(['open', 'open']);
  expect(capture.events).toEqual([]);
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

test('a new instance on the same state file carries on where the last left off, and the seed is unchanged', async () => {
  const world = files();
  const seed = readFileSync(world.seed, 'utf8');
  const first = createFakeCodeHost(world);
  expect((await first.merge(3, 'squash')).state).toBe('pending');
  await first.addLabel(1, 'needs-review');

  const next = createFakeCodeHost(world);
  expect((await next.merge(3, 'squash')).state).toBe('merged');
  expect((await next.getPullRequest(1)).labels).toEqual(['sail', 'needs-review']);
  expect(readFileSync(world.seed, 'utf8')).toBe(seed);
});

test('the fixture seed holds the golden pull request, three designated ones, and every capability', async () => {
  const host = createFakeCodeHost({ seed: SEED, state: join(tempDir(), 'prs.json') });
  const { number, url, base, head, headSha, ticketKey, state } = await host.getPullRequest(1);
  expect({ number, url, base, head, headSha, ticketKey, state }).toEqual({
    number: 1,
    url: 'fake://codehost/fixture/pull/1',
    base: 'main',
    head: 'sail/FAKE-1',
    headSha: 'b4efb0c5de84d87c1455d4504b8b75b095a8e10b',
    ticketKey: 'FAKE-1',
    state: 'open',
  });
  expect((await host.listDesignated('sail')).map((pr) => pr.number)).toEqual([1, 3, 4]);
  expect(host.capabilities()).toEqual({
    checks: true,
    labels: true,
    drafts: true,
    mergeMethods: ['merge', 'squash', 'rebase'],
  });
});

test("parseRef takes a number, #number or this remote's pull URL, whole, and nothing else", () => {
  const host = createFakeCodeHost(files());
  const refs = ['7', '#7', 'fake://codehost/fixture/pull/7', 'fake://codehost/other/pull/7', '#x', '7a', 'pull/7'];
  expect(refs.map((ref) => host.parseRef(ref))).toEqual([7, 7, 7, undefined, undefined, undefined, undefined]);
});
