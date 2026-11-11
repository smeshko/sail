// cleanRuns(): the loop `sail clean` and the dashboard share, over fake ports: a run no queue item names is cleaned, one
// a queue item names is refused without `settle` or with no watcher, and a refused run neither stops the next nor is
// touched.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readConfig } from '../../src/engine/config';
import { writeStatus } from '../../src/engine/run-dir';
import { runWorkflow } from '../../src/engine/runtime';
import { type CleanedRun, cleanRuns, lazyPorts } from '../../src/watch/clean-runs';
import { queueDir } from '../../src/watch/queue-store';
import { fakeAdapters } from '../helpers/adapters';
import { sail as sailProcess } from '../helpers/sail-process';
import { writeStub } from '../helpers/stub-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

async function failedRun(repo: TempRepo, ticket: string): Promise<string> {
  const end = await runWorkflow({
    cwd: repo.dir,
    adapters: await fakeAdapters(repo.dir),
    workflow: 'ticket-to-pr',
    ticket,
    until: 'spec',
  });
  if ('refused' in end) throw new Error(end.refused);
  writeStatus(end.dir, 'failed', 'workflow_failed');
  return end.runId;
}

/** A failed run made by a `sail` process of its own, since one process opens one run of a repository. */
async function failedByProcess(repo: TempRepo, ticket: string): Promise<string> {
  const before = new Set(readdirSync(join(repo.dir, '.sail-runs')));
  await sailProcess(repo.dir, { ...repo.env, SAIL_HOME: join(dirname(repo.dir), 'sail-home') }, [
    ticket,
    '--until',
    'spec',
  ]);
  const made = readdirSync(join(repo.dir, '.sail-runs')).find((n) => n.startsWith(`${ticket}-`) && !before.has(n));
  if (made === undefined) throw new Error(`no run of ${ticket} was made`);
  writeStatus(join(repo.dir, '.sail-runs', made), 'failed', 'workflow_failed');
  return made;
}

function project(repo: TempRepo): void {
  writeStub(repo.dir);
  mkdirSync(join(repo.dir, '.sail', 'fake'), { recursive: true });
  writeFileSync(
    join(repo.dir, '.sail', 'fake', 'prs.json'),
    JSON.stringify({ remote: 'fake://codehost/stub', defaultBranch: 'main', branches: {}, pullRequests: [] }),
  );
}

function parkedItem(repo: TempRepo, runId: string, ticket: string): void {
  const dir = queueDir(join(repo.dir, '.sail-runs'), 'a');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'queue.json'),
    JSON.stringify({
      version: 1,
      workflow: 'a',
      updatedAt: '2026-10-15T09:00:00.000Z',
      polling: { label: 'sail-a', failures: 0 },
      items: [
        {
          dedupKey: `ticket:${ticket}`,
          source: { kind: 'ticket', ticketKey: ticket },
          title: `Ticket ${ticket}`,
          url: `fake://tickets/${ticket}`,
          state: 'parked',
          attempts: 2,
          addedAt: '2026-10-15T09:00:00.000Z',
          runId,
          reason: 'spec blocked',
        },
      ],
    }),
  );
}

async function clean(repo: TempRepo, runIds: string[], settle?: 'requeue' | 'drop'): Promise<CleanedRun[]> {
  const adapters = await fakeAdapters(repo.dir);
  const sailDir = join(repo.dir, '.sail');
  const config = readConfig(sailDir);
  if ('issues' in config) throw new Error('config');
  const env = { ...repo.env };
  return cleanRuns({
    sailDir,
    config,
    workspace: adapters.ports.workspace,
    ...lazyPorts({ sailDir, config, env }),
    env,
    runIds,
    ...(settle === undefined ? {} : { settle }),
    locate: async () => ({ name: 'stub', holder: undefined }),
    taken: async () => true,
    showPath: (file) => file,
  });
}

test('cleanRuns cleans a failed run no queue item names and says so, resetting its ticket', async () => {
  await withTempRepo(async (repo) => {
    project(repo);
    const runId = await failedRun(repo, 'FAKE-1');
    const [result] = await clean(repo, [runId]);
    expect(result?.runId).toBe(runId);
    expect(result?.problem).toBeUndefined();
    expect(result?.cleaned?.archived).toContain(runId);
    expect(result?.lines.map((line) => line.kind)).toEqual(['said', 'said']);
    expect(result?.lines[0]?.text).toStartWith(`cleaned ${runId}: `);
    expect(result?.lines[1]?.text).toBe('reset FAKE-1 to Todo');
    expect(existsSync(join(repo.dir, '.sail-runs', runId))).toBe(false);
  });
});

test('cleanRuns refuses a run a queue item names when nothing says what to do with it, and still cleans the next', async () => {
  await withTempRepo(async (repo) => {
    project(repo);
    const named = await failedRun(repo, 'FAKE-1');
    const other = await failedByProcess(repo, 'FAKE-2');
    parkedItem(repo, named, 'FAKE-1');
    const results = await clean(repo, [named, other]);
    expect(results.map((each) => each.runId)).toEqual([named, other]);
    expect(results[0]?.problem).toBe('refused');
    expect(results[0]?.cleaned).toBeUndefined();
    expect(results[0]?.lines).toEqual([
      {
        kind: 'warned',
        text: `queue item ticket:FAKE-1 of a (parked) names run ${named}: clean it with --requeue or --drop, or \`sail queue requeue|drop\``,
      },
    ]);
    expect(existsSync(join(repo.dir, '.sail-runs', named))).toBe(true);
    expect(results[1]?.cleaned).toBeDefined();
    expect(existsSync(join(repo.dir, '.sail-runs', other))).toBe(false);
  });
});

test('cleanRuns with settle and no watcher refuses the named run in the watcher check words and leaves it whole', async () => {
  await withTempRepo(async (repo) => {
    project(repo);
    const named = await failedRun(repo, 'FAKE-1');
    parkedItem(repo, named, 'FAKE-1');
    const [result] = await clean(repo, [named], 'requeue');
    expect(result?.problem).toBe('refused');
    expect(result?.cleaned).toBeUndefined();
    expect(result?.lines).toEqual([
      { kind: 'warned', text: `run ${named}: no watcher is running for 'stub' here: sail watch a first` },
    ]);
    expect(existsSync(join(repo.dir, '.sail-runs', named))).toBe(true);
  });
});
