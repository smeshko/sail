// The chain rehearsed offline (ADW-109): `sail watch ticket-to-pr pr-to-main` as one real process over the chain fixture
// (`test/fixtures/chain/.sail/`), on the scripted Linear and GitHub served on 127.0.0.1, git-worktree over a local bare
// origin, and the fake harness. It is what the live run will prove once a real model is behind the harness, for $0:
//
//   1. the watcher starts with CHAIN_HOLD naming a file that doesn't exist. Its first polls queue ADW-1 (a designated
//      ticket), PR 7 (labelled `sail` and `ci-red`) and PR 8 (labelled `sail`), both behind `main` and with no ticket;
//   2. ADW-1's `publish` opens PR 9, moves ADW-1 to In Review and holds, with the branch's lease. `sail queue poll
//      pr-to-main` queues PR 9, and its dispatch is skipped while the ticket run holds the lease;
//   3. PR 8's label is removed once its own run has started its reviewers;
//   4. the dashboard is read while the runs are in flight;
//   5. the hold file is written: ADW-1's run ends and releases its lease, and PR 9 is dispatched, reviewed and merged;
//   6. every run settles, one more poll queues nothing, and `sail unwatch` stops the watcher.
//
// Every wait is on a file, an event or an exit, bounded, and no duration is asserted. The scenario runs once and its
// cases read what it left, copied out before the clone and the worlds went away.
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT_OK } from '../../src/cli/exit-codes';
import { formatIssue, validateRunDir } from '../../src/engine/schemas';
import { type QueueFile, queueDir } from '../../src/watch/queue-store';
import { type Chain, withChain } from '../helpers/chain';
import { worldMergeSha } from '../helpers/github-world';
import { queueEventIssues, queueEvents } from '../helpers/queue';
import {
  killOne,
  type RunOnDisk,
  runsIn,
  type SailProcess,
  sailProcess,
  until,
  WAIT_MS,
} from '../helpers/sail-process';

const WATCHED = ['ticket-to-pr', 'pr-to-main'];
const TIMEOUT_MS = 300_000;

/** The queue of workflow `workflow`, as `queue.json` holds it now. */
function queueOf(runs: string, workflow: string): QueueFile | undefined {
  try {
    return JSON.parse(readFileSync(join(queueDir(runs, workflow), 'queue.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

/** Whether a run has ended, by its STATUS. */
const ended = (run: RunOnDisk): boolean => run.status === 'completed' || run.status.startsWith('failed');

/** The pull-request runs of `number`. */
const runsOfPull = (runs: string, number: number): RunOnDisk[] =>
  runsIn(runs).filter((run) => run.source.kind === 'pr' && run.source.number === number);

/** The event types of `run` that match `pattern`, with their timestamps. */
const stamped = (run: RunOnDisk | undefined, type: string): string[] =>
  (run?.events ?? []).filter((event) => event.type === type).map((event) => event.ts);

/** What the scenario saw. */
interface Watched {
  waits: string[];
  /** Every run when everything had settled, each with its events. */
  runs: RunOnDisk[];
  runDirs: string[];
  /** The queues, as `queue.json` held them when everything had settled. */
  queues: Record<string, QueueFile | undefined>;
  /** What each queue's event stream recorded: type and dedup key, and the lease holder where it names one. */
  queueEvents: Record<string, { type: string; dedupKey?: string; heldBy?: string; reason?: string }[]>;
  queueIssues: string[];
  /** The dashboard, read while the runs were in flight. */
  dashboard: { repos: { name: string; watching?: unknown }[]; queues: { workflow: string; queue?: QueueFile }[] };
  /** `queue:skipped_leased` seen before the hold was released. */
  skippedLeased: boolean;
  /** The pull-request runs the dashboard-time read found in flight. */
  inFlight: string[];
  /** What a last poll queued after everything settled. */
  lastPoll: { code: number; stdout: string; added: number };
  watcher: { code: number | 'still running' };
  pulls: Chain['github']['pullRequests'];
  tickets: Record<number, { state: string; comments: string[] }>;
  requests: Chain['github']['requests'];
  /** Validation problems of every run directory. */
  issues: string[];
  leases: string[];
  worktrees: string[];
  clone: { before: Chain['before']; after: Chain['before'] };
  tokenMatched: boolean;
}

/** Reads the dashboard at `base`: the repositories, and the queues of the first. */
async function readDashboard(base: string): Promise<Watched['dashboard']> {
  const get = async (path: string) => (await fetch(`${base}${path}`, { headers: { 'X-Sail-Dashboard': '1' } })).json();
  const { repos } = (await get('/api/repos')) as { repos: { name: string }[] };
  const [first] = repos;
  const queues = first === undefined ? [] : await get(`/api/repos/${encodeURIComponent(first.name)}/queues`);
  return { repos, queues } as Watched['dashboard'];
}

let shared: Promise<Watched> | undefined;
const scenario = (): Promise<Watched> => {
  shared ??= run();
  return shared;
};

async function run(): Promise<Watched> {
  const holdRoot = realpathSync(mkdtempSync(join(tmpdir(), 'chain-hold-')));
  const hold = join(holdRoot, 'release');
  try {
    return await withChain(
      {
        pulls: [
          { number: 7, branch: 'sail/ADW-7-red', labels: ['sail', 'ci-red'] },
          { number: 8, branch: 'sail/ADW-8-stop' },
        ],
        tickets: [
          { number: 1, title: 'Add a chain', description: 'Open a pull request.', state: 'Todo', labels: ['sail'] },
          { number: 2, title: 'Claimed', description: 'Someone has it.', state: 'In Progress', labels: ['sail'] },
          { number: 3, title: 'Not designated', description: 'No label.', state: 'Todo', labels: [] },
        ],
        // A reviewer that takes a moment, so a pull request's label can be removed while its reviewers run.
        harness: (answers) => {
          const [coverage] = answers['coverage-check'] ?? [];
          if (coverage !== undefined) coverage.delayMs = 1500;
        },
        env: { CHAIN_HOLD: hold },
      },
      async (chain) => {
        const { repo, env, runs } = chain;
        const waits: string[] = [];
        const wait = async (what: string, ready: () => boolean) => {
          const said = await until(what, ready);
          if (said !== what) waits.push(said);
        };
        const poll = () => chain.run(['queue', 'poll', 'pr-to-main']);
        const skipped = () => queueEvents(queueDir(runs, 'pr-to-main')).some((e) => e.type === 'queue:skipped_leased');
        let watcher: SailProcess | undefined;
        let dashboard: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
        try {
          watcher = sailProcess(repo.dir, env, ['watch', ...WATCHED]);

          // PR 8's label goes once its own run's reviewers have started.
          const removal = (async () => {
            await wait('PR 8 reviewers started', () =>
              runsOfPull(runs, 8).some((each) => each.events.some((event) => event.type === 'all:start')),
            );
            const pull = chain.pull(8);
            pull.labels = pull.labels.filter((label) => label !== 'sail');
          })();

          // ADW-1's run opens PR 9 and holds with the lease: PR 9 is queued and waits.
          await wait('PR 9 opened', () => chain.github.pullRequests.some((pull) => pull.number === 9));
          const deadline = performance.now() + WAIT_MS;
          while (!skipped() && performance.now() < deadline) {
            await poll();
            await Bun.sleep(500);
          }
          const skippedLeased = skipped();
          if (!skippedLeased) waits.push('PR 9 waiting on the lease did not happen');
          await removal;

          // The dashboard, while the ticket run is held and the other runs are in flight or just ended.
          dashboard = Bun.spawn(
            [process.execPath, join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts'), 'dashboard', '--port', '0'],
            {
              cwd: repo.dir,
              env: { ...env },
              stdin: 'ignore',
              stdout: 'pipe',
              stderr: 'pipe',
            },
          );
          const reader = dashboard.stdout.getReader();
          let said = '';
          const first = performance.now() + 30_000;
          while (!said.includes('\n') && performance.now() < first) {
            const chunk = await Promise.race([reader.read(), Bun.sleep(1000).then(() => undefined)]);
            if (chunk?.value !== undefined) said += new TextDecoder().decode(chunk.value);
            if (chunk?.done) break;
          }
          const url = /^sail dashboard: (http:\/\/127\.0\.0\.1:\d+)/.exec(said)?.[1];
          const seen = url === undefined ? { repos: [], queues: [] } : await readDashboard(url);
          if (url === undefined) waits.push('the dashboard did not print its URL');
          const inFlight = runsIn(runs)
            .filter((each) => !ended(each))
            .map((each) => `${each.workflow} ${each.source.kind === 'pr' ? `#${each.source.number}` : each.ticketKey}`);
          killOne(dashboard.pid, 'SIGINT');
          await dashboard.exited;

          // Release the ticket run's lease: PR 9 is dispatched.
          writeFileSync(hold, 'go\n');
          await wait('every run settled', () => {
            const all = runsIn(runs);
            return (
              runsOfPull(runs, 9).length === 1 &&
              all.length >= 4 &&
              all.every(ended) &&
              (queueOf(runs, 'pr-to-main')?.items ?? []).every((item) => item.state !== 'dispatched')
            );
          });
          // Pushes the runs made were queued as new heads: their dispatch drops them, never runs them.
          await wait('no pull request left queued', () => {
            const items = queueOf(runs, 'pr-to-main')?.items ?? [];
            return items.every((item) => item.state === 'done' || item.state === 'failed' || item.state === 'parked');
          });
          const addedBefore = queueEvents(queueDir(runs, 'pr-to-main')).filter(
            (e) => e.type === 'queue:item_added',
          ).length;
          const lastPoll = await poll();
          const unwatch = await chain.run(['unwatch', ...WATCHED]);
          if (unwatch.code !== EXIT_OK) waits.push(`sail unwatch exited ${unwatch.code}`);
          const code = await Promise.race([watcher.exited, Bun.sleep(WAIT_MS).then(() => 'still running' as const)]);

          const finished = runsIn(runs);
          const leases = join(repo.home, '.sail', 'leases');
          return {
            waits,
            runs: finished,
            runDirs: chain.runDirs(),
            queues: Object.fromEntries(WATCHED.map((name) => [name, queueOf(runs, name)])),
            queueEvents: Object.fromEntries(
              WATCHED.map((name) => [
                name,
                queueEvents(queueDir(runs, name)).map((event) => ({
                  type: String(event.type),
                  ...(event.dedupKey === undefined ? {} : { dedupKey: String(event.dedupKey) }),
                  ...(event.heldBy === undefined ? {} : { heldBy: String(event.heldBy) }),
                  ...(event.reason === undefined ? {} : { reason: String(event.reason) }),
                })),
              ]),
            ),
            queueIssues: WATCHED.flatMap((name) => queueEventIssues(queueDir(runs, name))),
            dashboard: seen,
            skippedLeased,
            inFlight,
            lastPoll: {
              code: lastPoll.code,
              stdout: lastPoll.stdout,
              added:
                queueEvents(queueDir(runs, 'pr-to-main')).filter((e) => e.type === 'queue:item_added').length -
                addedBefore,
            },
            watcher: { code },
            pulls: structuredClone(chain.github.pullRequests),
            tickets: Object.fromEntries(
              [1, 2, 3].map((number) => {
                const ticket = chain.linear.ticket(number);
                return [number, { state: ticket.state, comments: (ticket.comments ?? []).map((c) => c.body) }];
              }),
            ),
            requests: [...chain.github.requests],
            issues: chain.runDirs().flatMap((dir) => validateRunDir(join(runs, dir)).issues.map(formatIssue)),
            leases: existsSync(leases) ? readdirSync(leases) : [],
            worktrees: repo
              .git('worktree', 'list', '--porcelain')
              .split('\n')
              .filter((line) => line.startsWith('worktree '))
              .map((line) => line.slice('worktree '.length)),
            clone: {
              before: chain.before,
              after: { head: repo.git('rev-parse', 'HEAD'), status: repo.git('status', '--porcelain') },
            },
            tokenMatched: chain.github.requests.every((request) => request.tokenMatched),
          };
        } finally {
          if (dashboard !== undefined && dashboard.exitCode === null) killOne(dashboard.pid, 'SIGKILL');
          if (watcher !== undefined && watcher.exitCode === null) killOne(watcher.pid, 'SIGKILL');
          // A dispatched run leads a session of its own, so it outlives its watcher: one still going is stopped.
          for (const item of [...WATCHED].flatMap((name) => queueOf(runs, name)?.items ?? [])) {
            if (item.state === 'dispatched' && item.pid !== undefined) killOne(item.pid, 'SIGKILL');
          }
        }
      },
    );
  } finally {
    rmSync(holdRoot, { recursive: true, force: true });
  }
}

/** The scenario, whose waits all happened. */
async function watched(): Promise<Watched> {
  const seen = await scenario();
  expect(seen.waits).toEqual([]);
  return seen;
}

const ticketRun = (seen: Watched) => seen.runs.find((each) => each.workflow === 'ticket-to-pr');
const prRun = (seen: Watched, number: number) => runsOfPullIn(seen.runs, number);
const runsOfPullIn = (all: RunOnDisk[], number: number) =>
  all.filter((each) => each.source.kind === 'pr' && each.source.number === number);

test(
  'the watcher alone started the runs: ADW-1 by the ticket workflow, and PRs 7, 8 and 9 by the PR workflow, with ADW-2 (claimed) and ADW-3 (not designated) never queued',
  async () => {
    const seen = await watched();
    const added = (workflow: string) =>
      (seen.queueEvents[workflow] ?? [])
        .filter((event) => event.type === 'queue:item_added')
        .map((event) => event.dedupKey?.replace(/@.*/, ''));
    expect({
      runs: seen.runs
        .map(
          (each) =>
            `${each.workflow} ${each.via} ${each.source.kind === 'pr' ? `#${each.source.number}` : each.ticketKey}`,
        )
        .sort(),
      tickets: added('ticket-to-pr'),
    }).toEqual({
      runs: ['pr-to-main watch #7', 'pr-to-main watch #8', 'pr-to-main watch #9', 'ticket-to-pr watch ADW-1'],
      tickets: ['ticket:ADW-1'],
    });
    expect(new Set(added('pr-to-main').filter((key) => key !== undefined))).toEqual(new Set(['pr:7', 'pr:8', 'pr:9']));
    expect(seen.watcher).toEqual({ code: EXIT_OK });
  },
  TIMEOUT_MS,
);

test(
  'ADW-1 was claimed, linked to PR 9, moved to In Review once PR 9 opened, and is Done after the merge, with the merged comment; ADW-2 and ADW-3 are untouched',
  async () => {
    const seen = await watched();
    const run = ticketRun(seen);
    const merged = seen.pulls.find((pull) => pull.number === 9);
    expect(seen.tickets[1]).toEqual({
      state: 'Done',
      comments: [
        `sail run ${run?.runId} started`,
        `sail run ${run?.runId} opened https://github.com/o/r/pull/9`,
        `sail run ${prRun(seen, 9)[0]?.runId} merged https://github.com/o/r/pull/9 as ${worldMergeSha(9, merged?.headSha ?? '')}`,
      ],
    });
    expect(seen.tickets[2]).toEqual({ state: 'In Progress', comments: [] });
    expect(seen.tickets[3]).toEqual({ state: 'Todo', comments: [] });
  },
  TIMEOUT_MS,
);

test(
  "PR 9 waited on the lease: queue:skipped_leased names the ticket run as the holder, its workspace:lease_released comes before PR 9's run started, and the run completed with codehost:merged carrying the world's sha",
  async () => {
    const seen = await watched();
    const ticket = ticketRun(seen);
    const [pr9] = prRun(seen, 9);
    const events = seen.queueEvents['pr-to-main'] ?? [];
    expect(seen.skippedLeased).toBe(true);
    expect(events.filter((event) => event.type === 'queue:skipped_leased').map((event) => event.heldBy)).toContain(
      ticket?.runId,
    );
    const released = stamped(ticket, 'workspace:lease_released')[0] ?? '';
    expect(released).not.toBe('');
    expect((pr9?.startedAt ?? '') >= released).toBe(true);
    expect(pr9?.status).toBe('completed');
    const pull = seen.pulls.find((each) => each.number === 9);
    const merged = (pr9?.events ?? []).filter((event) => event.type === 'codehost:merged');
    expect(merged.map((event) => event.sha)).toEqual([worldMergeSha(9, pull?.headSha ?? '')]);
    expect({ state: pull?.state, merge: pull?.mergeCommitSha }).toEqual({
      state: 'closed',
      merge: worldMergeSha(9, pull?.headSha ?? ''),
    });
  },
  TIMEOUT_MS,
);

test(
  'PR 7, whose check stays red, was handed back: labels ci-red and sail-blocked, the hand-back comment, the run failed, and no merge request',
  async () => {
    const seen = await watched();
    const [run] = prRun(seen, 7);
    const pull = seen.pulls.find((each) => each.number === 7);
    expect({ status: run?.status, labels: pull?.labels, state: pull?.state }).toEqual({
      status: 'failed workflow_failed',
      labels: ['ci-red', 'sail-blocked'],
      state: 'open',
    });
    expect(pull?.comments.map((comment) => comment.body)).toEqual([
      `sail run ${run?.runId} handed this pull request back: checks failed\n\n\`\`\`\n- test: failed\n\`\`\`\n`,
    ]);
    expect(
      seen.requests.filter((request) => request.method === 'PUT' && request.path === '/repos/o/r/pulls/7/merge'),
    ).toEqual([]);
  },
  TIMEOUT_MS,
);

test(
  'PR 8, whose label was removed before the gate, was stopped: no sail-blocked, the stop comment, the run failed, and no merge request',
  async () => {
    const seen = await watched();
    const [run] = prRun(seen, 8);
    const pull = seen.pulls.find((each) => each.number === 8);
    expect({ status: run?.status, labels: pull?.labels, state: pull?.state }).toEqual({
      status: 'failed workflow_failed',
      labels: [],
      state: 'open',
    });
    expect(pull?.comments.map((comment) => comment.body)).toEqual([
      `sail run ${run?.runId} did not merge: the label sail was removed`,
    ]);
    expect(
      seen.requests.filter((request) => request.method === 'PUT' && request.path === '/repos/o/r/pulls/8/merge'),
    ).toEqual([]);
    expect(
      seen.requests.filter((request) => request.path === '/repos/o/r/issues/8/labels' && request.method === 'POST'),
    ).toEqual([]);
  },
  TIMEOUT_MS,
);

test(
  "exactly one pr-to-main run per pull request, the last poll queued nothing, and every item the runs' own pushes added was dropped at dispatch, never run",
  async () => {
    const seen = await watched();
    expect([7, 8, 9].map((number) => prRun(seen, number).length)).toEqual([1, 1, 1]);
    expect(seen.runs.filter((each) => each.workflow === 'pr-to-main')).toHaveLength(3);
    expect({ code: seen.lastPoll.code, added: seen.lastPoll.added }).toEqual({ code: 0, added: 0 });
    const events = seen.queueEvents['pr-to-main'] ?? [];
    const added = events.filter((event) => event.type === 'queue:item_added').map((event) => event.dedupKey ?? '');
    const dispatched = events.filter((event) => event.type === 'queue:dispatched').map((event) => event.dedupKey ?? '');
    // Every added key that was not dispatched was dropped, with a reason.
    const dropped = events.filter((event) => event.type === 'queue:dropped').map((event) => event.dedupKey ?? '');
    expect(dispatched).toHaveLength(3);
    expect(
      added
        .filter((key) => !dispatched.includes(key))
        .every(
          (key) =>
            dropped.includes(key) ||
            (seen.queues['pr-to-main']?.items ?? []).some((item) => item.dedupKey === key && item.state === 'done'),
        ),
    ).toBe(true);
    expect(seen.queueIssues).toEqual([]);
  },
  TIMEOUT_MS,
);

test(
  'while runs were in flight the dashboard listed the watcher and the queues of both workflows',
  async () => {
    const seen = await watched();
    expect(seen.dashboard.repos).toHaveLength(1);
    expect(seen.dashboard.queues.map((view) => view.workflow).sort()).toEqual(WATCHED.slice().sort());
    expect(seen.inFlight).toContain(`ticket-to-pr ADW-1`);
  },
  TIMEOUT_MS,
);

test(
  'afterwards no lease is left, the clone is its only worktree, its HEAD and status are what they were, the watcher exited 0, every run directory validates, and no marker token was refused',
  async () => {
    const seen = await watched();
    expect({
      leases: seen.leases,
      worktrees: seen.worktrees.length,
      clone: seen.clone.after,
      watcher: seen.watcher,
      issues: seen.issues,
      tokenMatched: seen.tokenMatched,
    }).toEqual({
      leases: [],
      worktrees: 1,
      clone: seen.clone.before,
      watcher: { code: EXIT_OK },
      issues: [],
      tokenMatched: true,
    });
  },
  TIMEOUT_MS,
);
