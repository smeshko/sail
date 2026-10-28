// The fakes as built-in adapter definitions: each is created from its `project.yaml` options and the context a run
// gives it, reads its seed from `.sail/` and keeps its state under `.sail-runs/fake/` (DECISIONS D2, D7, D11). Every
// case runs in a temp repository holding a copy of the fixture's `.sail/`.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeAdapters } from '../../../src/adapters/fake/definitions';
import { BUILTINS } from '../../../src/adapters/index';
import { readLease } from '../../../src/adapters/leases';
import type { Port } from '../../../src/engine/config';
import type { AdapterContext } from '../../../src/ports/adapter';
import { copyFixture } from '../../helpers/fixture';
import { captureEvents, settle } from '../../helpers/ports';
import { type TempRepo, withTempRepo } from '../../helpers/temp-repo';

/** The context a run gives an adapter in `repo`, whose `.sail/` is a copy of the fixture's. */
function context(repo: TempRepo, extra: Partial<AdapterContext> = {}): AdapterContext {
  const sailDir = copyFixture(repo.dir);
  return { root: repo.dir, sailDir, runsDir: join(repo.dir, '.sail-runs'), env: repo.env, ...extra };
}

/** What `make` throws, or `'created'`: a definition's `create` may throw at once or reject. */
async function thrown(make: () => unknown): Promise<string> {
  try {
    await make();
    return 'created';
  } catch (error) {
    return (error as Error).message;
  }
}

test('the ticket source reads its seed, keeps its state under runsDir, and a second adapter sees the claim', async () => {
  await withTempRepo(async (repo) => {
    const ctx = context(repo);
    const seed = join(ctx.sailDir, 'fake', 'tickets.json');
    const before = readFileSync(seed, 'utf8');
    const options = { seed: './fake/tickets.json' };
    const first = await fakeAdapters.ticketSource.create(options, ctx);
    const keys = async (adapter: typeof first) => (await adapter.listDesignated('sail')).map((t) => t.ticketKey);
    expect((await first.get('FAKE-1')).ticketKey).toBe('FAKE-1');
    expect(await keys(first)).toContain('FAKE-1');

    expect((await first.claim('FAKE-1')).claimed).toBe(true);
    expect(existsSync(join(ctx.runsDir, 'fake', 'tickets.json'))).toBe(true);
    expect(readFileSync(seed, 'utf8')).toBe(before);

    const second = await fakeAdapters.ticketSource.create(options, ctx);
    expect(await keys(second)).not.toContain('FAKE-1');
  });
});

test('with no options the ticket and pull-request fakes read .sail/fake/tickets.json and .sail/fake/prs.json', async () => {
  await withTempRepo(async (repo) => {
    const ctx = context(repo);
    const tickets = await fakeAdapters.ticketSource.create({}, ctx);
    const host = await fakeAdapters.codeHost.create({}, ctx);
    expect((await tickets.get('FAKE-2')).title).toBe('Print the version with --version');
    expect((await host.getPullRequest(2)).title).toBe('FAKE-2: Print the version with --version');
  });
});

test('the pull-request fake merges #3 as pending, then merged, with its state in runsDir', async () => {
  await withTempRepo(async (repo) => {
    const ctx = context(repo);
    const options = { seed: './fake/prs.json' };
    const first = await fakeAdapters.codeHost.create(options, ctx);
    const request = { method: 'squash', expectedHeadSha: (await first.getPullRequest(3)).headSha } as const;
    expect((await first.merge(3, request)).state).toBe('pending');
    expect(existsSync(join(ctx.runsDir, 'fake', 'prs.json'))).toBe(true);
    const next = await fakeAdapters.codeHost.create(options, ctx);
    expect((await next.merge(3, request)).state).toBe('merged');
  });
});

test('the harness fake is created with no script, resolves as an error naming the file, and answers once one is written', async () => {
  await withTempRepo(async (repo) => {
    const ctx = context(repo);
    // The fixture scripts its harness: this repository is one that doesn't yet.
    rmSync(join(ctx.sailDir, 'fake', 'harness.json'));
    const harness = await fakeAdapters.harness.create({}, ctx);
    const request = {
      key: 'spec#1',
      try: 1,
      prompt: 'Write the spec.',
      cwd: repo.dir,
      env: {},
      model: 'fake-model',
      permissions: { read: ['**'], write: [], commands: [] },
      budget: { maxTurns: 5, maxUsd: 1, maxMinutes: 5 },
      outputSchema: { type: 'object' },
    };
    const missing = await harness.run(request);
    expect(missing.outcome).toBe('error');
    expect(missing.outcome === 'error' ? missing.message : '').toContain(join('fake', 'harness.json'));

    writeFileSync(join(ctx.sailDir, 'fake', 'harness.json'), '{"spec#1":[{"outcome":"done","output":{"ok":true}}]}');
    const answered = await harness.run(request);
    expect(answered.outcome === 'done' ? answered.output : answered).toEqual({ ok: true });
  });
});

test('the workspace fake defaults its repo to context.root: it leases and creates a worktree of the temp repository', async () => {
  await withTempRepo(async (repo) => {
    const ctx = context(repo);
    const workspace = await fakeAdapters.workspace.create({}, ctx);
    const runDir = join(ctx.runsDir, 'r1');
    mkdirSync(runDir, { recursive: true });
    const run = { runId: 'r1', runDir };
    const created = await workspace.create(run, { base: 'main', branch: 'sail/FAKE-1' });
    const listed = () => repo.git('worktree', 'list', '--porcelain').split('\n');
    expect(listed()).toContain(`worktree ${created.path}`);
    await workspace.release(run, false);
    expect(listed()).not.toContain(`worktree ${created.path}`);
  });
});

test('the workspace fake takes remote and defaultBranch, and keeps its leases in runsDir/fake/leases', async () => {
  await withTempRepo(async (repo) => {
    const ctx = context(repo);
    const workspace = await fakeAdapters.workspace.create({ remote: 'fake://elsewhere', defaultBranch: 'main' }, ctx);
    const repository = await settle(workspace.repository());
    const runDir = join(ctx.runsDir, 'r1');
    mkdirSync(runDir, { recursive: true });
    await workspace.lease('fake://elsewhere', 'sail/FAKE-1', { runId: 'r1', runDir, pid: process.pid });
    const leases = join(ctx.runsDir, 'fake', 'leases');
    expect({
      repository: 'rejected' in repository ? repository : { url: repository.url, branch: repository.defaultBranch },
      lease: readLease(leases, 'fake://elsewhere', 'sail/FAKE-1')?.runId,
    }).toEqual({ repository: { url: 'fake://elsewhere', branch: 'main' }, lease: 'r1' });
    await workspace.releaseLease('fake://elsewhere', 'sail/FAKE-1', 'r1');
  });
});

test.each<[Port, Record<string, unknown>, string]>([
  ['ticketSource', { seeds: 'x' }, 'seeds'],
  ['ticketSource', { seed: 3 }, 'seed'],
  ['codeHost', { seed: 3 }, 'seed'],
  ['harness', { script: 3 }, 'script'],
  ['workspace', { repo: 3 }, 'repo'],
  ['workspace', { remote: '' }, 'remote'],
  ['workspace', { defaultBranch: 7 }, 'defaultBranch'],
  ['harness', { seed: './fake/tickets.json' }, 'seed'],
])('%s created with %j throws, naming %s', async (port, options, name) => {
  await withTempRepo(async (repo) => {
    const ctx = context(repo);
    const message = await thrown(() => fakeAdapters[port].create(options, ctx));
    expect(message).toContain(name);
    expect(message).not.toBe('created');
  });
});

test('an emit in the context receives ticket:fetched from the ticket source', async () => {
  await withTempRepo(async (repo) => {
    const capture = captureEvents();
    const ctx = context(repo, { emit: capture.emit });
    const tickets = await fakeAdapters.ticketSource.create({}, ctx);
    await tickets.get('FAKE-1');
    expect(capture.events.map((event) => event.type)).toEqual(['ticket:fetched']);
  });
});

test('BUILTINS holds the fake for every port, each a definition with create alone, linear for the ticket source, which requires its key, claude-code, git-worktree and github', () => {
  expect(Object.keys(BUILTINS)).toEqual(['fake', 'linear', 'claude-code', 'git-worktree', 'github', 'typesafe']);
  const definitions = Object.entries(BUILTINS.fake ?? {}).map(([port, definition]) => [port, Object.keys(definition)]);
  expect(Object.fromEntries(definitions)).toEqual({
    ticketSource: ['create'],
    codeHost: ['create'],
    harness: ['create'],
    workspace: ['create'],
    jev: ['create'],
  });
  const linear = Object.entries(BUILTINS.linear ?? {}).map(([port, definition]) => [port, Object.keys(definition)]);
  expect(Object.fromEntries(linear)).toEqual({ ticketSource: ['requires', 'create'] });
  const github = Object.entries(BUILTINS.github ?? {}).map(([port, definition]) => [port, Object.keys(definition)]);
  expect(Object.fromEntries(github)).toEqual({ codeHost: ['requires', 'create'] });
});

test('the harness fake with a playback option plays from sailDir/<playback>, named fake', async () => {
  await withTempRepo(async (repo) => {
    const ctx = context(repo);
    const harness = await fakeAdapters.harness.create({ playback: './sessions/x' }, ctx);
    expect(harness.name).toBe('fake');
    const out = join(repo.dir, 'out');
    mkdirSync(out);
    const result = await harness.run({
      key: 'spec#1',
      try: 1,
      prompt: 'p',
      cwd: repo.dir,
      env: { STAGE_OUT: out },
      model: 'fake-model',
      permissions: { read: ['**'], write: [], commands: [] },
      budget: { maxTurns: 5, maxUsd: 1, maxMinutes: 5 },
      outputSchema: { type: 'object' },
    });
    expect(result.outcome === 'error' ? result.message : result).toBe(
      `fake harness: nothing recorded for spec#1 in ${join(ctx.sailDir, 'sessions', 'x')}`,
    );
    const warned = await fakeAdapters.harness.create({ playback: './sessions/x', onPromptMismatch: 'warn' }, ctx);
    expect(warned.name).toBe('fake');
  });
});

test.each<[Record<string, unknown>, string]>([
  [{ script: './s.json', playback: './sessions/x' }, 'playback'],
  [{ onPromptMismatch: 'warn' }, 'onPromptMismatch'],
  [{ playback: './sessions/x', onPromptMismatch: 'loud' }, 'onPromptMismatch'],
  [{ playback: 3 }, 'playback'],
])('the harness fake created with %j throws, naming %s', async (options, name) => {
  await withTempRepo(async (repo) => {
    const message = await thrown(() => fakeAdapters.harness.create(options, context(repo)));
    expect(message).toContain(name);
    expect(message).not.toBe('created');
  });
});

test.each<[unknown, string]>([
  [['Nope'], "option pickUp: 'Nope' is no state of the fake ticket source"],
  [['Todo', 'In Progress'], "option pickUp: 'In Progress' is a started state; pickUp takes unstarted states"],
  [['Done'], "option pickUp: 'Done' is a completed state; pickUp takes unstarted states"],
  [[], 'option pickUp:'],
  [[''], 'option pickUp.0:'],
  [['Todo', 'Todo'], 'option pickUp:'],
])('the ticket source fake created with pickUp %j throws %s', async (pickUp, message) => {
  await withTempRepo(async (repo) => {
    const thrownMessage = await thrown(() => fakeAdapters.ticketSource.create({ pickUp }, context(repo)));
    expect(thrownMessage).toContain(`fake ticketSource: ${message}`);
  });
});

test('the ticket source fake created with pickUp [Backlog, Todo] picks up from both and moves unstarted to Backlog', async () => {
  await withTempRepo(async (repo) => {
    const source = await fakeAdapters.ticketSource.create({ pickUp: ['Backlog', 'Todo'] }, context(repo));
    expect((await source.update('FAKE-2', { state: 'unstarted' })).state).toEqual({
      type: 'unstarted',
      name: 'Backlog',
    });
    const listed = (await source.listDesignated('sail')).map((ticket) => ticket.ticketKey);
    const ticket = await source.get('FAKE-1');
    const pickable = ['Triage', 'Backlog', 'Todo'].map((name) =>
      source.canPickUp({ ...ticket, state: { type: 'unstarted', name } }),
    );
    expect([listed, pickable]).toEqual([
      ['FAKE-1', 'FAKE-2'],
      [false, true, true],
    ]);
  });
});

test('the jev fake reads its seed from sailDir/<seed>, and refuses an option it does not know', async () => {
  await withTempRepo(async (repo) => {
    const ctx = context(repo);
    writeFileSync(join(ctx.sailDir, 'fake', 'jev.json'), JSON.stringify({ model: 'jev-seeded' }));
    const jev = await fakeAdapters.jev.create({}, ctx);
    const request = {
      state: 'x',
      questions: { q: { type: 'noul' as const, instructions: 'ok?', criteria: { true: 'yes', false: 'no' } } },
    };
    expect((await jev.ask(request)).model).toBe('jev-seeded');
    expect(await thrown(() => fakeAdapters.jev.create({ sead: 'x' }, ctx))).toMatch(/^fake jev: option sead:/);
  });
});
