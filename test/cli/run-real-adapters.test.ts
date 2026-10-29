// The first real run, rehearsed offline: the fixture's ticket-to-pr with `ticketSource: linear` on the scripted Linear
// served on 127.0.0.1, `codeHost: github` on the scripted GitHub served beside it over a local bare origin, the workspace
// on git-worktree, and the fake harness. It proves what the live run will prove once a real model is behind the harness:
// the claim and its comment, the pull request and the comment that links it, the refusal of a second start, the release
// of the worktree and the lease, and a clone that is as it was. Every `sail` is a process of its own, spawned with the
// repository's env: a script step's `sail port` calls inherit that process's environment. Both keys are markers.
//
// One run per repository: the cases that read what a completed run left share one, started in beforeAll under its
// own timeout before any case runs. The refused claim has a repository of its own.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_FAILED, EXIT_OK, EXIT_REFUSED } from '../../src/cli/exit-codes';
import { validateRunDir } from '../../src/engine/schemas';
import { readEvents } from '../../src/events/consumers/ndjson';
import type { SailEvent } from '../../src/events/types';
import { copyFixture, edit } from '../helpers/fixture';
import { createGitHubWorld, type GitHubWorld } from '../helpers/github-world';
import { createLinearWorld, DEFAULT_STATES, type LinearWorld } from '../helpers/linear-world';
import { withOrigin } from '../helpers/origin';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const MAIN = join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts');
const LINEAR_KEY = 'lin_api_MARKER_real_7d41c2e8';
const GITHUB_TOKEN = 'ghp_MARKER_real_b30f6a19c4';
const PR_URL = 'https://github.com/o/r/pull/1';

interface Clone {
  repo: TempRepo;
  linear: LinearWorld;
  github: GitHubWorld;
  /** The environment every `sail` runs in: both marker keys and both worlds' URLs. */
  env: Record<string, string>;
  /** The clone's HEAD and `git status --porcelain` before anything ran. */
  before: { head: string; status: string };
}

/** ADW-1: designated and Todo, with a comment already on it. */
const linearWorld = (): LinearWorld =>
  createLinearWorld({
    team: { key: 'ADW', states: DEFAULT_STATES },
    apiKey: LINEAR_KEY,
    tickets: [
      {
        number: 1,
        title: 'Add a greeting',
        description: 'Greet the user by name.',
        state: 'Todo',
        labels: ['sail'],
        comments: [{ body: 'Keep the exclamation mark.', createdAt: '2026-10-01T09:00:00.000Z', user: 'Ada' }],
      },
    ],
  });

/**
 * A clone of the fixture repository on every real adapter but the harness: `.sail/` uncommitted, `.sail-runs/` ignored,
 * a bare origin that the GitHub world reads its branches from.
 */
async function withClone<T>(fn: (clone: Clone) => Promise<T>, prepare?: (linear: LinearWorld) => void) {
  return withTempRepo(async (repo) => {
    writeFileSync(join(repo.dir, '.gitignore'), '.sail-runs/\n');
    repo.git('add', '.gitignore');
    repo.git('commit', '-q', '-m', 'ignore the runs');
    const origin = withOrigin(repo).url;
    const sail = copyFixture(repo.dir);
    edit(sail, 'project.yaml', 'workspace: { use: fake }', 'workspace: { use: git-worktree }');
    edit(
      sail,
      'project.yaml',
      'ticketSource: { use: fake, seed: ./fake/tickets.json }',
      'ticketSource: { use: linear, team: ADW }',
    );
    edit(
      sail,
      'project.yaml',
      'codeHost: { use: fake, seed: ./fake/prs.json }',
      'codeHost: { use: github, repository: o/r }',
    );
    const github = createGitHubWorld({
      owner: 'o',
      repo: 'r',
      defaultBranch: 'main',
      bare: origin,
      env: repo.env,
      token: GITHUB_TOKEN,
    });
    const linear = linearWorld();
    prepare?.(linear);
    const servedGitHub = github.serve();
    const servedLinear = linear.serve();
    try {
      const { SAIL_GITHUB_TOKEN: _sail, GITHUB_TOKEN: _github, ...base } = repo.env;
      const env = {
        ...base,
        GITHUB_TOKEN,
        SAIL_GITHUB_API_URL: servedGitHub.url,
        LINEAR_API_KEY: LINEAR_KEY,
        SAIL_LINEAR_API_URL: servedLinear.url,
      };
      const before = { head: repo.git('rev-parse', 'HEAD'), status: repo.git('status', '--porcelain') };
      return await fn({ repo, linear, github, env, before });
    } finally {
      servedGitHub.stop();
      servedLinear.stop();
    }
  });
}

/** `sail <argv>` in its own process in the clone, run to its end. */
async function sail(clone: Clone, argv: string[]) {
  const child = Bun.spawn([process.execPath, MAIN, ...argv], {
    cwd: clone.repo.dir,
    env: clone.env,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr };
}

/** The clone's runs, by id. */
const runIds = (repo: TempRepo): string[] =>
  existsSync(join(repo.dir, '.sail-runs'))
    ? readdirSync(join(repo.dir, '.sail-runs'))
        .filter((name) => name !== 'fake')
        .sort()
    : [];

/** The leases HOME holds: one file per branch a run holds. */
const leases = (repo: TempRepo): string[] => {
  const dir = join(repo.home, '.sail', 'leases');
  return existsSync(dir) ? readdirSync(dir) : [];
};

/** The worktrees of the clone, as `git worktree list --porcelain` names them. */
const worktrees = (repo: TempRepo): string[] =>
  repo
    .git('worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '));

const moves = (linear: LinearWorld) => linear.operations().filter((operation) => operation === 'SailMove');

/** Every file under `dir` that holds `needle`, read as bytes, by its path under `dir`. */
function holding(dir: string, needle: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((path) => {
    const full = join(dir, path);
    return statSync(full).isFile() && readFileSync(full).includes(needle);
  });
}

interface Ran extends Clone {
  code: number;
  stderr: string;
  runId: string;
  dir: string;
  events: SailEvent[];
}

let release = (): void => {};
let shared: Promise<Ran> | undefined;

/** `sail ADW-1` in a clone on every real adapter, started once in beforeAll and kept until the file's last case. */
function firstRun(): Promise<Ran> {
  shared ??= new Promise<Ran>((resolve, reject) => {
    withClone(async (clone) => {
      const ran = await sail(clone, ['ADW-1']);
      const [runId = ''] = runIds(clone.repo);
      const dir = join(clone.repo.dir, '.sail-runs', runId);
      resolve({ ...clone, ...ran, runId, dir, events: runId === '' ? [] : readEvents(dir) });
      await new Promise<void>((done) => {
        release = done;
      });
    }).catch(reject);
  });
  return shared;
}
// Spawn once before any case so no case pays for it; failures surface in each case's completed().
beforeAll(async () => {
  await firstRun().catch(() => undefined);
}, 300_000);
afterAll(() => release());

/** The shared run, which must have completed. */
async function completed(): Promise<Ran> {
  expect(shared).toBeInstanceOf(Promise);
  const ran = await firstRun();
  expect([ran.code, ran.stderr, existsSync(ran.dir) ? readFileSync(join(ran.dir, 'STATUS'), 'utf8') : '']).toEqual([
    EXIT_OK,
    '',
    'completed\n',
  ]);
  return ran;
}

test("sail ADW-1 ends completed with GitHub's one labelled pull request into main, marked with the ticket, and run:end's result is that pull request", async () => {
  const run = await completed();
  const [pr] = run.github.pullRequests;
  expect(run.github.pullRequests).toHaveLength(1);
  expect(pr?.head).toMatch(/^sail\/ADW-1-/);
  // The title and the body's text are the fake harness's `describe` answer, which names FAKE-1: what ties the pull
  // request to ADW-1 is the marker the code host adapter adds from `--ticket`.
  expect({
    base: pr?.base,
    labels: pr?.labels,
    draft: pr?.draft,
    marker: pr?.body.endsWith('\n\n<!-- sail:ticket ADW-1 -->'),
  }).toEqual({ base: 'main', labels: ['sail'], draft: false, marker: true });
  expect(run.events.at(-1)).toMatchObject({
    type: 'run:end',
    status: 'completed',
    result: { pr: { number: 1, url: PR_URL, draft: false } },
  });
}, 90_000);

test('in Linear ADW-1 is In Progress, moved once, and its comments end with the one that starts the run and the one that links the pull request, whose URL is the pull request’s', async () => {
  const run = await completed();
  const ticket = run.linear.ticket(1);
  expect(ticket.state).toBe('In Progress');
  expect(moves(run.linear)).toHaveLength(1);
  expect(ticket.comments?.map((comment) => comment.body)).toEqual([
    'Keep the exclamation mark.',
    `sail run ${run.runId} started`,
    `sail run ${run.runId} opened ${PR_URL}`,
  ]);
}, 90_000);

test('the claim and its comment come inside the intake, the push, the pull request and the link comment are under publish#1/open, and the worktree and the lease are released before run:end', async () => {
  const run = await completed();
  const types = run.events.map((event) => event.type);
  const intake = types.indexOf('intake:start');
  const intakeEnd = types.indexOf('intake:end');
  expect(types.indexOf('ticket:claimed')).toBeGreaterThan(intake);
  expect(types.indexOf('ticket:claimed')).toBeLessThan(intakeEnd);
  expect(types.indexOf('ticket:commented')).toBeGreaterThan(intake);
  expect(types.indexOf('ticket:commented')).toBeLessThan(intakeEnd);
  const own = run.events.filter((event) => 'key' in event && event.key === 'publish#1/open').map((event) => event.type);
  expect(own.filter((type) => /^(codehost|ticket):/.test(type))).toEqual([
    'codehost:pushed',
    'codehost:pr_opened',
    'codehost:labelled',
    'ticket:commented',
  ]);
  expect(types.filter((type) => type === 'ticket:commented')).toHaveLength(2);
  const end = types.indexOf('run:end');
  expect(types.indexOf('workspace:released')).toBeGreaterThan(-1);
  expect(types.indexOf('workspace:released')).toBeLessThan(types.indexOf('workspace:lease_released'));
  expect(types.indexOf('workspace:lease_released')).toBeLessThan(end);
}, 90_000);

test("after the run the clone has only itself as a worktree, HOME holds no lease, and the clone's HEAD and status are what they were", async () => {
  const run = await completed();
  expect({
    worktrees: worktrees(run.repo),
    leases: leases(run.repo),
    head: run.repo.git('rev-parse', 'HEAD'),
    status: run.repo.git('status', '--porcelain'),
  }).toEqual({
    worktrees: [`worktree ${run.repo.dir}`],
    leases: [],
    head: run.before.head,
    status: run.before.status,
  });
}, 90_000);

test('summary.json validates against sail.summary.v1, with a cost on each agent call and a total above zero', async () => {
  const run = await completed();
  expect(validateRunDir(run.dir).issues).toEqual([]);
  const summary = JSON.parse(readFileSync(join(run.dir, 'summary.json'), 'utf8'));
  const agents = summary.calls.filter((call: { kind: string }) => call.kind === 'agent');
  expect(agents.length).toBeGreaterThan(0);
  for (const call of agents) expect(call.costUsd).toBeGreaterThan(0);
  expect(summary.totals.usage.costUsd).toBeGreaterThan(0);
}, 90_000);

test('a second sail ADW-1 exits 3 as already claimed, makes no second run directory and no second move in Linear', async () => {
  const run = await completed();
  const second = await sail(run, ['ADW-1']);
  expect(second).toEqual({
    code: EXIT_REFUSED,
    stderr: 'sail ADW-1: the ticket is already claimed: it is In Progress. --force runs it anyway\n',
  });
  expect(runIds(run.repo)).toEqual([run.runId]);
  expect(moves(run.linear)).toHaveLength(1);
}, 90_000);

test('neither marker key is in any run file, the clone’s git config and logs, or HOME, though both services got theirs on every request', async () => {
  const run = await completed();
  for (const key of [LINEAR_KEY, GITHUB_TOKEN]) {
    expect({
      runs: holding(join(run.repo.dir, '.sail-runs'), key),
      config: readFileSync(join(run.repo.dir, '.git', 'config'), 'utf8').includes(key),
      logs: holding(join(run.repo.dir, '.git', 'logs'), key),
      home: holding(run.repo.home, key),
    }).toEqual({ runs: [], config: false, logs: [], home: [] });
  }
  expect(run.github.requests.length).toBeGreaterThan(0);
  expect(run.github.requests.every((request) => request.tokenMatched)).toBe(true);
}, 90_000);

/** Linear's answer to a request it fails: a 500 with a GraphQL error. */
const DOWN = { status: 500, body: { errors: [{ message: 'Linear is down' }] } };

/** The SailComment requests Linear got: the claim's, then each try of the link comment. */
const comments = (linear: LinearWorld) => linear.operations().filter((operation) => operation === 'SailComment');

test('a link comment Linear fails once is tried again: the run ends completed, and ADW-1 holds the one link comment', async () => {
  await withClone(
    async (clone) => {
      const ran = await sail(clone, ['ADW-1']);
      const [runId = ''] = runIds(clone.repo);
      const status = runId === '' ? '' : readFileSync(join(clone.repo.dir, '.sail-runs', runId, 'STATUS'), 'utf8');
      expect({
        ran: [ran.code, ran.stderr, status],
        pulls: clone.github.pullRequests.length,
        requests: comments(clone.linear).length,
        bodies: clone.linear.ticket(1).comments?.map((comment) => comment.body),
      }).toEqual({
        ran: [EXIT_OK, '', 'completed\n'],
        pulls: 1,
        requests: 3,
        bodies: ['Keep the exclamation mark.', `sail run ${runId} started`, `sail run ${runId} opened ${PR_URL}`],
      });
    },
    (linear) => linear.failNext('SailComment', DOWN, { after: 'SailComment' }),
  );
}, 90_000);

test('a link comment Linear fails three times fails open after its third try, and ADW-1 holds no link comment', async () => {
  await withClone(
    async (clone) => {
      const ran = await sail(clone, ['ADW-1']);
      const [runId = ''] = runIds(clone.repo);
      const status = runId === '' ? '' : readFileSync(join(clone.repo.dir, '.sail-runs', runId, 'STATUS'), 'utf8');
      expect({
        ran: [ran.code, status],
        pulls: clone.github.pullRequests.length,
        requests: comments(clone.linear).length,
        bodies: clone.linear.ticket(1).comments?.map((comment) => comment.body),
      }).toEqual({
        ran: [EXIT_FAILED, 'failed stage_error\n'],
        pulls: 1,
        requests: 4,
        bodies: ['Keep the exclamation mark.', `sail run ${runId} started`],
      });
    },
    (linear) => {
      for (let time = 0; time < 3; time++) linear.failNext('SailComment', DOWN, { after: 'SailComment' });
    },
  );
}, 90_000);

test('a claim whose move Linear fails ends the run failed at intake#1 and leaves no worktree and no lease, and the ticket as it was', async () => {
  await withClone(
    async (clone) => {
      const ran = await sail(clone, ['ADW-1']);
      expect(ran.code).toBe(EXIT_FAILED);
      expect({
        runs: runIds(clone.repo).length,
        worktrees: worktrees(clone.repo),
        leases: leases(clone.repo),
        state: clone.linear.ticket(1).state,
        pulls: clone.github.pullRequests,
        head: clone.repo.git('rev-parse', 'HEAD'),
      }).toEqual({
        runs: 1,
        worktrees: [`worktree ${clone.repo.dir}`],
        leases: [],
        state: 'Todo',
        pulls: [],
        head: clone.before.head,
      });
    },
    (linear) => linear.failNext('SailMove', { status: 500, body: { errors: [{ message: 'Linear is down' }] } }),
  );
}, 90_000);
