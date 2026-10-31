// The first watched run, rehearsed offline: the fixture's ticket-to-pr under a real `sail watch` process, with
// `ticketSource: linear` on the scripted Linear and `codeHost: github` on the scripted GitHub, both served on 127.0.0.1,
// the workspace on git-worktree over a local bare origin that moved after the clone, and the fake harness. It proves
// what the live run will prove once a real model is behind the harness: nobody starts a run, the watcher queues the two
// designated tickets and dispatches both at once into two worktrees, a SIGINT stops the watcher and leaves both runs
// going, and a restarted watcher settles them. Every `sail` is a process of its own, spawned with the repository's env:
// a dispatched run and its script steps inherit the watcher's environment. Both keys are markers.
//
// The fake harness holds each run's `implement#1` for 8 s, so both runs are in flight together and still alive when the
// watcher is restarted. Every wait is on a file or an exit, bounded at a minute, and no duration is asserted. One
// scenario, run once and kept until the file's last case, which the cases below read.
import { afterAll, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK } from '../../src/cli/exit-codes';
import { validateRunDir } from '../../src/engine/schemas';
import { type QueueFile, queueDir } from '../../src/watch/queue-store';
import { copyFixture, edit } from '../helpers/fixture';
import { createGitHubWorld, type GitHubWorld } from '../helpers/github-world';
import { createLinearWorld, DEFAULT_STATES, type LinearWorld } from '../helpers/linear-world';
import { withOrigin } from '../helpers/origin';
import { queueEventIssues, queueEvents } from '../helpers/queue';
import {
  alive,
  gone,
  killOne,
  type RunOnDisk,
  runsIn,
  type SailProcess,
  sailProcess,
  until,
} from '../helpers/sail-process';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const LINEAR_KEY = 'lin_api_MARKER_watch_5e92d0a7';
const GITHUB_TOKEN = 'ghp_MARKER_watch_8c14e3b6d2';
const WORKFLOW = 'ticket-to-pr';
const TIMEOUT_MS = 180_000;
const HOLD_MS = 8_000;

/** ADW-1 and ADW-2 are designated and Todo, ADW-3 is designated but started, and ADW-4 is Todo with no label. */
const linearWorld = (): LinearWorld =>
  createLinearWorld({
    team: { key: 'ADW', states: DEFAULT_STATES },
    apiKey: LINEAR_KEY,
    tickets: [
      { number: 1, title: 'Add a greeting', description: 'Greet the user by name.', state: 'Todo', labels: ['sail'] },
      { number: 2, title: 'Add a farewell', description: 'Say goodbye by name.', state: 'Todo', labels: ['sail'] },
      { number: 3, title: 'Already claimed', description: 'Someone has it.', state: 'In Progress', labels: ['sail'] },
      { number: 4, title: 'Not designated', description: 'No label.', state: 'Todo', labels: [] },
    ],
  });

/** The run directory, as the watcher's runs leave it. */
const RUNS = '.sail-runs';

interface Clone {
  repo: TempRepo;
  linear: LinearWorld;
  github: GitHubWorld;
  env: Record<string, string>;
  runs: string;
  before: { head: string; status: string };
}

/**
 * A clone of the fixture repository on every real adapter but the harness: `.sail/` committed and pushed, `.sail-runs/` ignored,
 * a bare origin that the GitHub world reads its branches from, and `main` there one commit ahead of the clone's.
 */
async function withClone<T>(fn: (clone: Clone) => Promise<T>): Promise<T> {
  return withTempRepo(async (repo) => {
    writeFileSync(join(repo.dir, '.gitignore'), `${RUNS}/\n`);
    repo.git('add', '.gitignore');
    repo.git('commit', '-q', '-m', 'ignore the runs');
    const origin = withOrigin(repo);
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
    const harness = join(sail, 'fake', 'harness.json');
    const answers = JSON.parse(readFileSync(harness, 'utf8'));
    answers['implement#1'][0].delayMs = HOLD_MS;
    writeFileSync(harness, `${JSON.stringify(answers, null, 2)}\n`);
    // A dispatched run reads the `.sail/` committed on the default branch's tip at the origin.
    repo.git('add', '.sail');
    repo.git('commit', '-q', '-m', 'definitions');
    repo.git('push', '-q', 'origin', 'main');
    const github = createGitHubWorld({
      owner: 'o',
      repo: 'r',
      defaultBranch: 'main',
      bare: origin.url,
      env: repo.env,
      token: GITHUB_TOKEN,
    });
    const linear = linearWorld();
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
      // The origin moves after the clone last fetched: both runs' fetches have to update refs/remotes/origin/main.
      origin.push('later.txt');
      return await fn({ repo, linear, github, env, runs: join(repo.dir, RUNS), before });
    } finally {
      servedGitHub.stop();
      servedLinear.stop();
    }
  });
}

/** The queue of the watched workflow, as `queue.json` holds it now. */
function queueOf(runs: string): QueueFile | undefined {
  try {
    return JSON.parse(readFileSync(join(queueDir(runs, WORKFLOW), 'queue.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

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
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));

/** Whether a run has ended, by its STATUS. */
const ended = (run: RunOnDisk): boolean => run.status === 'completed' || run.status.startsWith('failed');

/** Every file under `dir` that holds `needle`, read as bytes, by its path under `dir`. */
function holding(dir: string, needle: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((path) => {
    const full = join(dir, path);
    return statSync(full).isFile() && readFileSync(full).includes(needle);
  });
}

/** What the scenario saw. */
interface Watched extends Clone {
  /** Each wait that did not happen, as `until()` says it. Empty when every wait did. */
  waits: string[];
  /** The clone's worktrees while both runs were in flight. */
  inFlight: string[];
  /** The two runs' process ids, from the queue, when the first watcher was stopped. */
  runPids: number[];
  /** `queue:dispatched` events seen when the first watcher was stopped. */
  dispatchedAtSigint: number;
  first: { code: number | 'still running'; runsAlive: boolean[] };
  second: { code: number | 'still running' };
  /** The runs that had ended before the second watcher started. */
  endedBeforeRestart: string[];
  finished: RunOnDisk[];
}

/** Waits for `child` to exit, for at most a minute: its exit code, or that it is still running. */
const exitOf = (child: SailProcess) =>
  Promise.race([child.exited, Bun.sleep(60_000).then(() => 'still running' as const)]);

let release = (): void => {};
let shared: Promise<Watched> | undefined;
/** The scenario's own end: its runs stopped, its servers stopped and its clone removed. */
let torndown: Promise<unknown> = Promise.resolve();

/**
 * `sail watch ticket-to-pr`, stopped with a SIGINT once both runs are in flight, then started again until both runs
 * are settled and stopped again: run once and kept until the file's last case.
 */
function scenario(): Promise<Watched> {
  shared ??= new Promise<Watched>((resolve, reject) => {
    torndown = withClone(async (clone) => {
      const { repo, env, runs } = clone;
      const waits: string[] = [];
      const wait = async (what: string, ready: () => boolean) => {
        const said = await until(what, ready);
        if (said !== what) waits.push(said);
      };
      const watchers: SailProcess[] = [];
      try {
        const first = sailProcess(repo.dir, env, ['watch', WORKFLOW]);
        watchers.push(first);
        await wait(
          'two runs in flight',
          () =>
            runsIn(runs).length === 2 &&
            worktrees(repo).length === 3 &&
            (queueOf(runs)?.items.filter((item) => item.pid !== undefined).length ?? 0) === 2,
        );
        const inFlight = worktrees(repo);
        const runPids = (queueOf(runs)?.items ?? []).flatMap((item) => (item.pid === undefined ? [] : [item.pid]));
        const dispatchedAtSigint = queueEvents(queueDir(runs, WORKFLOW)).filter(
          (event) => event.type === 'queue:dispatched',
        ).length;
        killOne(first.pid, 'SIGINT');
        const firstCode = await exitOf(first);
        const runsAlive = runPids.map((pid) => alive(pid));
        const endedBeforeRestart = runsIn(runs)
          .filter(ended)
          .map((run) => run.runId);

        const second = sailProcess(repo.dir, env, ['watch', WORKFLOW]);
        watchers.push(second);
        await wait(
          'both runs settled',
          () =>
            runsIn(runs).length === 2 &&
            runsIn(runs).every(ended) &&
            (queueOf(runs)?.items.length ?? 0) === 2 &&
            queueOf(runs)?.items.every((item) => item.state === 'done') === true,
        );
        killOne(second.pid, 'SIGINT');
        const secondCode = await exitOf(second);
        resolve({
          ...clone,
          waits,
          inFlight,
          runPids,
          dispatchedAtSigint,
          first: { code: firstCode, runsAlive },
          second: { code: secondCode },
          endedBeforeRestart,
          finished: runsIn(runs),
        });
        await new Promise<void>((done) => {
          release = done;
        });
      } finally {
        for (const watcher of watchers) if (watcher.exitCode === null) killOne(watcher.pid, 'SIGKILL');
        // A dispatched run leads a session of its own, so it outlives its watcher. One whose item is not done, when the
        // scenario failed midway or a wait ran out, is stopped with its group before its clone and HOME are removed.
        const left = (queueOf(runs)?.items ?? []).flatMap((item) =>
          item.state === 'done' || item.pid === undefined ? [] : [item.pid],
        );
        for (const pid of left) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            // Gone already, or its group is exiting.
          }
        }
        for (const pid of left) await gone(pid);
      }
    }).catch(reject);
  });
  return shared;
}
afterAll(async () => {
  release();
  await torndown;
});

/** The scenario, whose waits all happened. */
async function watched(): Promise<Watched> {
  const run = await scenario();
  expect(run.waits).toEqual([]);
  return run;
}

/** The ticket key a pull request's head names: `sail/ADW-1-add-…` is ADW-1. */
const ticketOf = (head: string): string | undefined => /^sail\/(ADW-\d+)-/.exec(head)?.[1];

test(
  'the watcher alone started the runs: ADW-1 and ADW-2 were queued and dispatched, ADW-3 (started) and ADW-4 (not designated) never were',
  async () => {
    const run = await watched();
    const events = queueEvents(queueDir(run.runs, WORKFLOW));
    expect({
      runs: run.finished.map((each) => `${each.ticketKey} via ${each.via}`).sort(),
      queued: (queueOf(run.runs)?.items ?? []).map((item) => item.dedupKey).sort(),
      added: events
        .filter((event) => event.type === 'queue:item_added')
        .map((event) => event.dedupKey)
        .sort(),
      dispatchedAtSigint: run.dispatchedAtSigint,
    }).toEqual({
      runs: ['ADW-1 via watch', 'ADW-2 via watch'],
      queued: ['ticket:ADW-1', 'ticket:ADW-2'],
      added: ['ticket:ADW-1', 'ticket:ADW-2'],
      dispatchedAtSigint: 2,
    });
  },
  TIMEOUT_MS,
);

test(
  'both runs were in flight together, in two worktrees of the clone: two distinct workspaces, both listed while they ran',
  async () => {
    const run = await watched();
    const created = run.finished.flatMap((each) =>
      each.events
        .filter((event) => event.type === 'workspace:created')
        .map((event) => join(run.repo.dir, String(event.path))),
    );
    expect(created).toHaveLength(2);
    expect(new Set(created).size).toBe(2);
    expect([...run.inFlight].sort()).toEqual([run.repo.dir, ...created].sort());
    expect(run.runPids).toHaveLength(2);
  },
  TIMEOUT_MS,
);

test(
  'each run the watcher dispatched went through the engine keep-awake: one run:keep_awake in its events, opted out by the environment',
  async () => {
    const run = await watched();
    const reported = run.finished.map((each) =>
      each.events
        .filter((event) => event.type === 'run:keep_awake')
        .map((event) => ({ held: event.held, reason: event.reason })),
    );
    expect(reported).toEqual([
      [{ held: false, reason: 'SAIL_KEEP_AWAKE is off' }],
      [{ held: false, reason: 'SAIL_KEEP_AWAKE is off' }],
    ]);
  },
  TIMEOUT_MS,
);

test(
  'the SIGINT stopped the watcher with exit 0 and left both runs going: both pids were alive just after, and both runs end completed',
  async () => {
    const run = await watched();
    expect({
      first: run.first,
      statuses: run.finished.map((each) => each.status),
    }).toEqual({
      first: { code: EXIT_OK, runsAlive: [true, true] },
      statuses: ['completed', 'completed'],
    });
  },
  TIMEOUT_MS,
);

test(
  'the restarted watcher settled both: it exited 0 on its SIGINT, each run was adopted by it or had already ended, no third run exists, and both items are done',
  async () => {
    const run = await watched();
    const events = queueEvents(queueDir(run.runs, WORKFLOW));
    const adopted = events.filter((event) => event.type === 'run:adopted').map((event) => String(event.run));
    const unaccounted = run.finished
      .map((each) => each.runId)
      .filter((runId) => !adopted.includes(runId) && !run.endedBeforeRestart.includes(runId));
    expect({
      second: run.second,
      unaccounted,
      runs: run.finished.length,
      items: (queueOf(run.runs)?.items ?? []).map((item) => item.state),
      resumed: events.filter((event) => event.type === 'run:resumed'),
      issues: queueEventIssues(queueDir(run.runs, WORKFLOW)),
    }).toEqual({
      second: { code: EXIT_OK },
      unaccounted: [],
      runs: 2,
      items: ['done', 'done'],
      resumed: [],
      issues: [],
    });
  },
  TIMEOUT_MS,
);

test(
  'GitHub holds two pull requests from sail/ADW-1-* and sail/ADW-2-* into main, each labelled sail and not a draft',
  async () => {
    const run = await watched();
    expect(
      run.github.pullRequests
        .map((pr) => ({ ticket: ticketOf(pr.head), base: pr.base, labels: pr.labels, draft: pr.draft }))
        .sort((a, b) => String(a.ticket).localeCompare(String(b.ticket))),
    ).toEqual([
      { ticket: 'ADW-1', base: 'main', labels: ['sail'], draft: false },
      { ticket: 'ADW-2', base: 'main', labels: ['sail'], draft: false },
    ]);
  },
  TIMEOUT_MS,
);

test(
  'in Linear ADW-1 and ADW-2 are In Progress with the claim comment and then the comment that links their pull request, and ADW-3 and ADW-4 are untouched',
  async () => {
    const run = await watched();
    const expected = run.finished.map((each) => {
      const number = Number(each.ticketKey.replace('ADW-', ''));
      const pr = run.github.pullRequests.find((one) => ticketOf(one.head) === each.ticketKey);
      return {
        number,
        state: 'In Progress',
        comments: [
          `sail run ${each.runId} started`,
          `sail run ${each.runId} opened https://github.com/o/r/pull/${pr?.number}`,
        ],
      };
    });
    const seen = [1, 2].map((number) => ({
      number,
      state: run.linear.ticket(number).state,
      comments: (run.linear.ticket(number).comments ?? []).map((comment) => comment.body),
    }));
    expect(seen).toEqual(expected.sort((a, b) => a.number - b.number));
    expect([run.linear.ticket(3).state, run.linear.ticket(3).comments ?? []]).toEqual(['In Progress', []]);
    expect([run.linear.ticket(4).state, run.linear.ticket(4).comments ?? []]).toEqual(['Todo', []]);
  },
  TIMEOUT_MS,
);

test(
  "afterwards each run released its worktree and lease, HOME holds no lease, the clone has only itself as a worktree, and the clean clone was fast-forwarded to the origin's tip with its status unchanged",
  async () => {
    const run = await watched();
    expect({
      released: run.finished.map((each) =>
        each.events.map((event) => event.type).filter((type) => /^workspace:(released|lease_released)$/.test(type)),
      ),
      leases: leases(run.repo),
      worktrees: worktrees(run.repo),
      head: run.repo.git('rev-parse', 'HEAD'),
      status: run.repo.git('status', '--porcelain'),
    }).toEqual({
      released: [
        ['workspace:released', 'workspace:lease_released'],
        ['workspace:released', 'workspace:lease_released'],
      ],
      leases: [],
      worktrees: [run.repo.dir],
      head: run.repo.git('rev-parse', 'origin/main'),
      status: run.before.status,
    });
    expect(run.repo.git('rev-parse', 'HEAD')).not.toBe(run.before.head);
  },
  TIMEOUT_MS,
);

test(
  'both run directories validate, and neither marker key is in any file of .sail-runs, the clone’s git config and logs, or HOME',
  async () => {
    const run = await watched();
    expect(run.finished.flatMap((each) => validateRunDir(join(run.runs, each.runId)).issues)).toEqual([]);
    for (const key of [LINEAR_KEY, GITHUB_TOKEN]) {
      expect({
        runs: holding(run.runs, key),
        config: readFileSync(join(run.repo.dir, '.git', 'config'), 'utf8').includes(key),
        logs: holding(join(run.repo.dir, '.git', 'logs'), key),
        home: holding(run.repo.home, key),
      }).toEqual({ runs: [], config: false, logs: [], home: [] });
    }
    expect(run.github.requests.every((request) => request.tokenMatched)).toBe(true);
  },
  TIMEOUT_MS,
);
