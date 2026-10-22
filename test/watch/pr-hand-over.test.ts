// The hand-over end to end, with real processes (14.2's D9, D10): one `sail watch` of a ticket workflow, `ship`, and a
// pull-request workflow, `review-pr`, both polling the label `sail` (ADW-235). `ship`'s run of FAKE-1 opens its pull
// request labelled `sail` and holds at the stub's gate while it holds the branch's lease. The pull request is queued at
// the next poll, waits on that lease, and is reviewed once the ticket run has released it. A second push to the branch
// is a new queue item, reviewed in turn, and the first sha is not queued again. Every wait is on a file or an exit,
// bounded, and no duration is asserted.
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createFakeCodeHost } from '../../src/adapters/fake/code-host';
import { queueDir } from '../../src/watch/queue-store';
import { seedPullRequests, writePrWorkflow, writePublishingWorkflow } from '../helpers/pr-workflow';
import { queueEventIssues, queueEvents } from '../helpers/queue';
import { killOne, runsIn, type SailProcess, sail, sailProcess, until, WAIT_MS } from '../helpers/sail-process';
import { heldRuns, releaseHeld, setHoldAt, writeStub } from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';
import { writeTickets } from '../helpers/watched';

const BRANCH = 'sail/FAKE-1-add-a-greeting';

test("a ticket run's pull request is queued while the run holds its branch, reviewed only once the run has released it, and a second push is reviewed in turn while the first sha is never queued again", async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeStub(repo.dir, { testsPassAt: 1 });
    writePublishingWorkflow(sailDir, 'ship', { label: 'sail', cap: 1 });
    writePrWorkflow(sailDir, 'review-pr', { watch: { label: 'sail', cap: 1 } });
    writeTickets(sailDir, [{ key: 'FAKE-1', labels: ['sail'], title: 'Add a greeting' }]);
    seedPullRequests(sailDir, repo, []);
    setHoldAt(repo.dir, 'open#1');
    const env = { ...repo.env, SAIL_HOME: join(repo.home, 'sail-home') };
    const runs = join(repo.dir, '.sail-runs');
    const reviews = () => runsIn(runs).filter((run) => run.workflow === 'review-pr');
    const completedReviews = () => reviews().filter((run) => run.status === 'completed').length;
    const queued = (type: string) => queueEvents(queueDir(runs, 'review-pr')).filter((event) => event.type === type);
    let watcher: SailProcess | undefined;
    try {
      watcher = sailProcess(repo.dir, env, ['watch', 'ship', 'review-pr']);
      expect(await until('the ticket run held', () => heldRuns(repo.dir).length === 1)).toBe('the ticket run held');
      expect((await sail(repo.dir, env, ['queue', 'poll', 'review-pr'])).code).toBe(0);
      expect(
        await until('the pull request waiting on the lease', () => queued('queue:skipped_leased').length === 1),
      ).toBe('the pull request waiting on the lease');
      releaseHeld(repo.dir);
      expect(await until('the first review completed', () => completedReviews() === 1)).toBe(
        'the first review completed',
      );

      // A second push to the branch, as a person would make it, from a worktree of the clone.
      const worktree = join(repo.dir, '..', 'second-push');
      const [ship] = runsIn(runs).filter((run) => run.workflow === 'ship');
      const pushed = ship?.events.find((event) => event.type === 'codehost:pushed')?.headSha as string;
      repo.git('worktree', 'add', '-q', '--detach', worktree, pushed);
      Bun.spawnSync(['git', 'commit', '-q', '--allow-empty', '-m', 'a second push'], { cwd: worktree, env: repo.env });
      const host = createFakeCodeHost({
        seed: join(sailDir, 'fake', 'prs.json'),
        state: join(runs, 'fake', 'prs.json'),
        env: repo.env,
      });
      const second = (await host.push(worktree, BRANCH)).headSha;
      expect((await sail(repo.dir, env, ['queue', 'poll', 'review-pr'])).code).toBe(0);
      expect(await until('the second review completed', () => completedReviews() === 2)).toBe(
        'the second review completed',
      );
      expect((await sail(repo.dir, env, ['queue', 'poll', 'review-pr'])).code).toBe(0);
      expect((await sail(repo.dir, env, ['unwatch', 'ship', 'review-pr'])).code).toBe(0);
      const code = await Promise.race([watcher.exited, Bun.sleep(WAIT_MS).then(() => 'still running')]);
      expect(code).toBe(0);

      const ticketRun = ship?.runId ?? '';
      const released = ship?.events.find((event) => event.type === 'workspace:lease_released')?.ts ?? '';
      const [first, next] = reviews();
      expect({
        statuses: runsIn(runs).map((run) => `${run.workflow} ${run.via} ${run.status}`),
        added: queued('queue:item_added').map((event) => event.dedupKey),
        heldBy: queued('queue:skipped_leased').map((event) => event.heldBy),
        heads: [first?.source.headSha, next?.source.headSha],
        afterRelease: released !== '' && (first?.startedAt ?? '') >= released,
        issues: [...queueEventIssues(queueDir(runs, 'review-pr')), ...queueEventIssues(queueDir(runs, 'ship'))],
      }).toEqual({
        statuses: ['ship watch completed', 'review-pr watch completed', 'review-pr watch completed'],
        added: [`pr:1@${pushed.slice(0, 7)}`, `pr:1@${second.slice(0, 7)}`],
        heldBy: [ticketRun],
        heads: [pushed, second],
        afterRelease: true,
        issues: [],
      });
    } finally {
      releaseHeld(repo.dir);
      if (watcher !== undefined && watcher.exitCode === null) killOne(watcher.pid, 'SIGKILL');
    }
  });
}, 240_000);
