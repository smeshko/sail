// `sail watch` end to end, with real processes (DECISIONS D21): a watcher of the stub's watched copies a and b, one
// run at a time each, dispatching real `sail <ticket> --dispatch` runs on the fakes, a second `sail watch` that adds b
// to it, and a `sail unwatch` that ends it. Every wait is on a file or an exit, bounded, and no duration is asserted.
// Nothing here signals a process but the watcher itself, and only when the test failed before the watcher could exit.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readStatus } from '../../src/engine/run-dir';
import { queueDir } from '../../src/watch/queue-store';
import { queueEventIssues } from '../helpers/queue';
import { writeStub } from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';
import { writeTickets, writeWatched } from '../helpers/watched';

const MAIN = join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts');
const WAIT_MS = 60_000;

interface Run {
  runId: string;
  workflow: string;
  via: string;
  startedAt: string;
  status: string;
  events: { type: string; ts: string }[];
}

/** The runs in `runs`, by their run.json, with their STATUS and events: none until a run has written its header. */
function runsIn(runs: string): Run[] {
  if (!existsSync(runs)) return [];
  return readdirSync(runs)
    .filter((name) => existsSync(join(runs, name, 'run.json')))
    .map((runId) => {
      const dir = join(runs, runId);
      const header = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
      let status = 'starting';
      try {
        status = readStatus(dir).status;
      } catch {
        // No STATUS yet.
      }
      const events = existsSync(join(dir, 'events.ndjson'))
        ? readFileSync(join(dir, 'events.ndjson'), 'utf8')
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => JSON.parse(line))
        : [];
      return {
        runId,
        workflow: header.workflow.name,
        via: header.source.via,
        startedAt: header.startedAt,
        status,
        events,
      };
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** Waits until `ready` holds, looking every 200 ms, for at most a minute: `what`, or that it didn't happen. */
async function until(what: string, ready: () => boolean): Promise<string> {
  const deadline = performance.now() + WAIT_MS;
  while (!ready()) {
    if (performance.now() > deadline) return `${what} did not happen within ${WAIT_MS / 1000} s`;
    await Bun.sleep(200);
  }
  return what;
}

// biome-ignore format: TDD-PENDING TASK-010
test
  .skip // TDD-PENDING TASK-010
  ("sail watch a runs a's tickets one at a time as dispatched runs, a second sail watch b adds b, and sail unwatch a b ends the watcher with 0", async () => {
  await withTempRepo(async (repo) => {
    const sail = writeStub(repo.dir, { testsPassAt: 1 });
    writeWatched(sail, 'a', { label: 'sail-a', cap: 1 });
    writeWatched(sail, 'b', { label: 'sail-b', cap: 1 });
    writeTickets(sail, [
      { key: 'FAKE-1', labels: ['sail-a'] },
      { key: 'FAKE-2', labels: ['sail-a'] },
      { key: 'FAKE-3', labels: ['sail-b'] },
      { key: 'FAKE-4', labels: ['sail-b'] },
    ]);
    const env = { ...repo.env, SAIL_HOME: join(repo.home, 'sail-home') };
    const runs = join(repo.dir, '.sail-runs');
    const sailProcess = (argv: string[]) =>
      Bun.spawn([process.execPath, MAIN, ...argv], { cwd: repo.dir, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const completed = (workflow: string) =>
      runsIn(runs).filter((run) => run.workflow === workflow && run.status === 'completed').length;

    const watcher = sailProcess(['watch', 'a']);
    const watcherOut = new Response(watcher.stdout).text();
    const watcherErr = new Response(watcher.stderr).text();
    try {
      expect(await until("a's two runs completing", () => completed('a') === 2)).toBe("a's two runs completing");
      const second = sailProcess(['watch', 'b']);
      const [added, addedErr, addedCode] = await Promise.all([
        new Response(second.stdout).text(),
        new Response(second.stderr).text(),
        second.exited,
      ]);
      expect({ code: addedCode, stderr: addedErr }).toEqual({ code: 0, stderr: '' });
      expect(added).toMatch(/^sail watch: the watcher of 'stub' \(pid \d+\) watches a, b\n$/);
      expect(await until("b's two runs completing", () => completed('b') === 2)).toBe("b's two runs completing");
      const third = sailProcess(['unwatch', 'a', 'b']);
      const [removed, removedCode] = await Promise.all([new Response(third.stdout).text(), third.exited]);
      expect(removedCode).toBe(0);
      expect(removed).toMatch(/^sail unwatch: the watch set is empty: the watcher of 'stub' \(pid \d+\) stops\n$/);
      const code = await Promise.race([watcher.exited, Bun.sleep(WAIT_MS).then(() => 'still running')]);
      expect({ code, stderr: await watcherErr }).toEqual({ code: 0, stderr: '' });
    } finally {
      if (watcher.exitCode === null) watcher.kill();
    }

    const all = runsIn(runs);
    expect(all.map((run) => `${run.workflow} ${run.via} ${run.status}`)).toEqual([
      'a watch completed',
      'a watch completed',
      'b watch completed',
      'b watch completed',
    ]);
    for (const run of all) {
      const types = run.events.map((event) => event.type);
      expect([run.runId, types.indexOf('ticket:claimed') >= 0, types.indexOf('ticket:claimed') < types.indexOf('intake:start')]).toEqual([run.runId, true, true]);
    }
    const [first, next] = all.filter((run) => run.workflow === 'a');
    const firstEnd = first?.events.find((event) => event.type === 'run:end')?.ts ?? '';
    expect(firstEnd !== '' && (next?.startedAt ?? '') >= firstEnd).toBe(true);
    expect([...queueEventIssues(queueDir(runs, 'a')), ...queueEventIssues(queueDir(runs, 'b'))]).toEqual([]);
    expect(await watcherOut).toContain(' watch set: a, b\n');
  });
}, 150_000);
