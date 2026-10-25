// Restarts, end to end with real processes (DECISIONS D5, D11, D13): `sail watch` dispatching real runs of the stub's
// watched copies, held at the stub's gate for exactly as long as a case needs them in flight. A case kills the watcher
// or a run's process, one pid at a time and never a group, then shows what a restarted watcher does: adopt the live
// runs, resume the dead ones from their journals, and leave a workflow it doesn't watch alone. Every wait is on a file
// or an exit, bounded at a minute, and no duration is asserted. Each case has its own temp repository and SAIL_HOME, and
// ends every watcher it started.
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateRunDir } from '../../src/engine/schemas';
import { type QueueFile, queueDir } from '../../src/watch/queue-store';
import { queueEventIssues, queueEvents, sourceKey } from '../helpers/queue';
import {
  alive,
  gone,
  killOne,
  runsIn,
  type SailProcess,
  sail,
  sailProcess,
  until,
  WAIT_MS,
} from '../helpers/sail-process';
import { heldRuns, releaseHeld, setHoldAt, stubExecutions, writeStub } from '../helpers/stub-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';
import { type SeedTicket, writeTickets, writeWatched } from '../helpers/watched';

const TIMEOUT_MS = 180_000;

/** The stub, its tests passing at once, with watched copies a (sail-a) and b (sail-b), and a SAIL_HOME of its own. */
function repository(repo: TempRepo, caps: { a: number; b: number }, tickets: SeedTicket[]) {
  const sailDir = writeStub(repo.dir, { testsPassAt: 1 });
  writeWatched(sailDir, 'a', { label: 'sail-a', cap: caps.a });
  writeWatched(sailDir, 'b', { label: 'sail-b', cap: caps.b });
  writeTickets(sailDir, tickets);
  setHoldAt(repo.dir, 'implement#1');
  const env = { ...repo.env, SAIL_HOME: join(repo.home, 'sail-home') };
  const runs = join(repo.dir, '.sail-runs');
  return { env, runs };
}

/** The queue of `workflow`, as `queue.json` holds it now. */
const queueOf = (runs: string, workflow: string): QueueFile =>
  JSON.parse(readFileSync(join(queueDir(runs, workflow), 'queue.json'), 'utf8'));

/** The events of `workflow`'s queue stream of `type`, by dedup key and run. */
const eventsOf = (runs: string, workflow: string, type: string) =>
  queueEvents(queueDir(runs, workflow)).filter((event) => event.type === type);

const completed = (runs: string) => runsIn(runs).filter((run) => run.status === 'completed').length;

/** Ends what a case left running: the gate opened, and each process still alive killed alone. */
function cleanUp(repoDir: string, processes: (SailProcess | undefined)[]): void {
  releaseHeld(repoDir);
  for (const each of processes) if (each !== undefined && each.exitCode === null) killOne(each.pid, 'SIGKILL');
}

/** Waits for `child` to exit, for at most a minute: its exit code, or that it is still running. */
const exitOf = (child: SailProcess) =>
  Promise.race([child.exited, Bun.sleep(WAIT_MS).then(() => 'still running' as const)]);

/** Every run in `runs` and every queue stream named validates. */
function issues(runs: string, workflows: string[]): string[] {
  return [
    ...workflows.flatMap((workflow) => queueEventIssues(queueDir(runs, workflow))),
    ...runsIn(runs).flatMap((run) => validateRunDir(join(runs, run.runId)).issues.map((issue) => issue.message)),
  ];
}

// SIGKILL is the harder way to lose a watcher: its queue lease and registry field are left behind by a dead pid. A
// SIGTERM'd watcher leaving its runs running is the next case's first step, and its tidy exit is test/cli/watch.test.ts's.
test(
  'a watcher killed with SIGKILL while two runs are held in flight leaves both running; a new sail watch a adopts both, starts the third ticket only once one has completed, and all three complete with one run each',
  async () => {
    await withTempRepo(async (repo) => {
      const { env, runs } = repository(repo, { a: 2, b: 1 }, [
        { key: 'FAKE-1', labels: ['sail-a'] },
        { key: 'FAKE-2', labels: ['sail-a'] },
        { key: 'FAKE-3', labels: ['sail-a'] },
      ]);
      const first = sailProcess(repo.dir, env, ['watch', 'a']);
      let second: SailProcess | undefined;
      try {
        expect(await until('two runs held', () => heldRuns(repo.dir).length === 2)).toBe('two runs held');
        killOne(first.pid, 'SIGKILL');
        expect(await gone(first.pid)).toBe(true);
        const inFlight = queueOf(runs, 'a').items.filter((item) => item.state === 'dispatched');
        expect(inFlight.map((item) => item.pid !== undefined && alive(item.pid))).toEqual([true, true]);
        second = sailProcess(repo.dir, env, ['watch', 'a']);
        expect(await until('both runs adopted', () => eventsOf(runs, 'a', 'run:adopted').length === 2)).toBe(
          'both runs adopted',
        );
        releaseHeld(repo.dir);
        expect(await until('three runs completed', () => completed(runs) === 3)).toBe('three runs completed');
        expect((await sail(repo.dir, env, ['unwatch', 'a'])).code).toBe(0);
        expect(await exitOf(second)).toBe(0);

        const all = runsIn(runs);
        const held = heldRuns(repo.dir).map((each) => each.runId);
        const firstEnd = all
          .filter((run) => held.includes(run.runId))
          .map((run) => run.events.find((event) => event.type === 'run:end')?.ts ?? '')
          .sort()[0];
        const third = all.find((run) => run.ticketKey === 'FAKE-3');
        expect({
          runs: all.map((run) => `${run.ticketKey} ${run.status}`).sort(),
          adopted: eventsOf(runs, 'a', 'run:adopted')
            .map((event) => event.run)
            .sort(),
          resumed: eventsOf(runs, 'a', 'run:resumed'),
          thirdAfterAnEnd: firstEnd !== undefined && firstEnd !== '' && (third?.startedAt ?? '') >= firstEnd,
          issues: issues(runs, ['a']),
        }).toEqual({
          runs: ['FAKE-1 completed', 'FAKE-2 completed', 'FAKE-3 completed'],
          adopted: [...held].sort(),
          resumed: [],
          thirdAfterAnEnd: true,
          issues: [],
        });
      } finally {
        cleanUp(repo.dir, [first, second]);
      }
    });
  },
  TIMEOUT_MS,
);

test(
  'a run whose process was killed with SIGKILL, and one killed with SIGTERM, are resumed by sail watch a from their journals: run:resumed says where each was, both complete, and only the interrupted call ran twice',
  async () => {
    await withTempRepo(async (repo) => {
      const { env, runs } = repository(repo, { a: 2, b: 1 }, [
        { key: 'FAKE-1', labels: ['sail-a'] },
        { key: 'FAKE-2', labels: ['sail-a'] },
      ]);
      const first = sailProcess(repo.dir, env, ['watch', 'a']);
      let second: SailProcess | undefined;
      try {
        expect(await until('two runs held', () => heldRuns(repo.dir).length === 2)).toBe('two runs held');
        killOne(first.pid, 'SIGTERM');
        expect(await gone(first.pid)).toBe(true);
        const items = queueOf(runs, 'a').items;
        const [killed, interrupted] = ['ticket:FAKE-1', 'ticket:FAKE-2'].map((key) =>
          items.find((item) => item.dedupKey === key),
        );
        killOne(killed?.pid ?? 0, 'SIGKILL');
        killOne(interrupted?.pid ?? 0, 'SIGTERM');
        expect([await gone(killed?.pid ?? 0), await gone(interrupted?.pid ?? 0)]).toEqual([true, true]);
        const statusOf = (runId = '') => runsIn(runs).find((run) => run.runId === runId)?.status;
        expect([statusOf(killed?.runId), statusOf(interrupted?.runId)]).toEqual(['running', 'suspended interrupted']);
        releaseHeld(repo.dir);
        second = sailProcess(repo.dir, env, ['watch', 'a']);
        expect(await until('both runs completed', () => completed(runs) === 2)).toBe('both runs completed');
        expect((await sail(repo.dir, env, ['unwatch', 'a'])).code).toBe(0);
        expect(await exitOf(second)).toBe(0);
        expect({
          resumed: eventsOf(runs, 'a', 'run:resumed').map(({ dedupKey, run, from }) => ({ dedupKey, run, from })),
          ran: stubExecutions(repo.dir).sort(),
          issues: issues(runs, ['a']),
        }).toEqual({
          resumed: [
            { dedupKey: 'ticket:FAKE-1', run: killed?.runId, from: { status: 'running' } },
            {
              dedupKey: 'ticket:FAKE-2',
              run: interrupted?.runId,
              from: { status: 'suspended', stopReason: 'interrupted' },
            },
          ],
          ran: [
            ...Array(4).fill('implement#1'),
            ...Array(2).fill('publish#1'),
            ...Array(2).fill('self-review#1'),
            ...Array(2).fill('spec#1'),
            ...Array(2).fill('tests#1'),
          ],
          issues: [],
        });
      } finally {
        cleanUp(repo.dir, [first, second]);
      }
    });
  },
  TIMEOUT_MS,
);

test(
  "an interrupted run of b stays suspended while sail watch a runs, with no run:resumed in b's stream, until sail watch b adds b and resumes it",
  async () => {
    await withTempRepo(async (repo) => {
      const { env, runs } = repository(repo, { a: 1, b: 1 }, [
        { key: 'FAKE-1', labels: ['sail-a'] },
        { key: 'FAKE-2', labels: ['sail-b'] },
      ]);
      const first = sailProcess(repo.dir, env, ['watch', 'b']);
      let second: SailProcess | undefined;
      try {
        expect(await until("b's run held", () => heldRuns(repo.dir).length === 1)).toBe("b's run held");
        killOne(first.pid, 'SIGTERM');
        expect(await gone(first.pid)).toBe(true);
        const [run] = queueOf(runs, 'b').items;
        killOne(run?.pid ?? 0, 'SIGTERM');
        expect(await gone(run?.pid ?? 0)).toBe(true);
        releaseHeld(repo.dir);
        second = sailProcess(repo.dir, env, ['watch', 'a']);
        expect(await until("a's run completed", () => completed(runs) === 1)).toBe("a's run completed");
        const ofB = () => runsIn(runs).find((each) => each.runId === run?.runId);
        const whileA = { status: ofB()?.status, resumed: eventsOf(runs, 'b', 'run:resumed').length };
        const added = await sail(repo.dir, env, ['watch', 'b']);
        expect(await until("b's run completed", () => completed(runs) === 2)).toBe("b's run completed");
        expect((await sail(repo.dir, env, ['unwatch', 'a', 'b'])).code).toBe(0);
        expect(await exitOf(second)).toBe(0);
        expect({
          whileA,
          added: added.code,
          resumed: eventsOf(runs, 'b', 'run:resumed').map(({ run: id, from }) => ({ run: id, from })),
          issues: issues(runs, ['a', 'b']),
        }).toEqual({
          whileA: { status: 'suspended interrupted', resumed: 0 },
          added: 0,
          resumed: [{ run: run?.runId, from: { status: 'suspended', stopReason: 'interrupted' } }],
          issues: [],
        });
      } finally {
        cleanUp(repo.dir, [first, second]);
      }
    });
  },
  TIMEOUT_MS,
);

test(
  "sail unwatch b suspends b's held run at its next call boundary with unwatched and keeps b's queue; sail watch b resumes the run to its end, then dispatches b's next ticket",
  async () => {
    await withTempRepo(async (repo) => {
      const { env, runs } = repository(repo, { a: 1, b: 1 }, [
        { key: 'FAKE-1', labels: ['sail-b'] },
        { key: 'FAKE-2', labels: ['sail-b'] },
      ]);
      const watcher = sailProcess(repo.dir, env, ['watch', 'a', 'b']);
      try {
        expect(await until("b's run held", () => heldRuns(repo.dir).length === 1)).toBe("b's run held");
        const [held] = heldRuns(repo.dir);
        const runDir = join(runs, held?.runId ?? '');
        const unwatched = await sail(repo.dir, env, ['unwatch', 'b']);
        const control = existsSync(join(runDir, 'CONTROL')) ? readFileSync(join(runDir, 'CONTROL'), 'utf8') : 'none';
        releaseHeld(repo.dir);
        const suspended = () => runsIn(runs).find((run) => run.runId === held?.runId)?.status === 'suspended unwatched';
        expect(await until('the run suspended', suspended)).toBe('the run suspended');
        const kept = queueOf(runs, 'b').items.map((item) => `${sourceKey(item)} ${item.state}`);
        const watched = await sail(repo.dir, env, ['watch', 'b']);
        expect(await until("both of b's runs completed", () => completed(runs) === 2)).toBe(
          "both of b's runs completed",
        );
        expect((await sail(repo.dir, env, ['unwatch', 'a', 'b'])).code).toBe(0);
        expect(await exitOf(watcher)).toBe(0);
        const [resumedRun, next] = runsIn(runs);
        const resumedEnd = resumedRun?.events.filter((event) => event.type === 'run:end').at(-1)?.ts ?? '';
        expect({
          unwatched: [unwatched.code, unwatched.stdout],
          control,
          kept,
          watched: watched.code,
          resumed: eventsOf(runs, 'b', 'run:resumed').map(({ run, from }) => ({ run, from })),
          order: [resumedRun?.runId, next?.ticketKey, resumedEnd !== '' && (next?.startedAt ?? '') >= resumedEnd],
          issues: issues(runs, ['a', 'b']),
        }).toEqual({
          unwatched: [0, `sail unwatch: the watcher of 'stub' (pid ${watcher.pid}) watches a\n`],
          control: 'unwatched\n',
          kept: ['FAKE-1 dispatched', 'FAKE-2 queued'],
          watched: 0,
          resumed: [{ run: held?.runId, from: { status: 'suspended', stopReason: 'unwatched' } }],
          order: [held?.runId, 'FAKE-2', true],
          issues: [],
        });
      } finally {
        cleanUp(repo.dir, [watcher]);
      }
    });
  },
  TIMEOUT_MS,
);
