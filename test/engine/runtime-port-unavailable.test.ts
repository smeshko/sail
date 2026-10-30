// A run whose script step ends on an unavailable port (runtime.ts): the fixture's ticket-to-pr on the fakes, with the fake
// code host seeded to fail its first push as `unavailable`. The run is suspended with `port_unavailable`, not failed: the
// call is left unjournaled, the workspace and the lease are kept, and a resume runs it again, from the step that failed. A
// resume runs in a copy of the repository the run was suspended in (copyRun()). In a group (the review fixture's trio, b
// a script that ends on an unavailable port), the members that passed are journaled, and a usage limit takes precedence.
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJournal } from '../../src/engine/journal';
import { type RunEnd, resumeWorkflow, runWorkflow } from '../../src/engine/runtime';
import { readEvents } from '../../src/events/consumers/ndjson';
import type { SailEvent } from '../../src/events/types';
import { fakeAdapters } from '../helpers/adapters';
import { copyFixture, write } from '../helpers/fixture';
import { TRIO, writeTrio } from '../helpers/review-fixture';
import { copyRun } from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';

const RESETS_AT = '2026-10-28T14:20:00.000Z';
const keys = (runDir: string) => readJournal(runDir).entries.map((entry) => entry.key);
const status = (runDir: string) => readFileSync(join(runDir, 'STATUS'), 'utf8');
const bare = ({ seq: _s, ts: _t, runId: _r, ...rest }: SailEvent) => rest;
const leasesIn = (repoDir: string) => {
  const dir = join(repoDir, '.sail-runs', 'fake', 'leases');
  return existsSync(dir) ? readdirSync(dir) : [];
};

/** The fixture with its code host failing the first `pushes` pushes as unavailable. */
function downFor(repoDir: string, pushes: number): void {
  copyFixture(repoDir);
  const file = join(repoDir, '.sail', 'fake', 'prs.json');
  const world = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, `${JSON.stringify({ ...world, unavailable: { push: pushes } }, null, 2)}\n`);
}

/** trio, its b a script whose port call fails unavailable and which exits 1; `answers` replaces any agent's answers. */
function trioDownAtB(repoDir: string, answers: Parameters<typeof writeTrio>[2] = {}): void {
  const sail = writeTrio(repoDir, { a: 0, b: 0, c: 0 }, answers);
  write(
    sail,
    `workflows/${TRIO}/stages/b/stage.ts`,
    `// b: a script whose code host is down.
import { file, script, z } from 'sail';

export const b = script('b', {
  run: './run.sh',
  consumes: { brief: file('brief.md') },
  output: z.object({ name: z.string() }),
});
`,
  );
  const run = write(
    sail,
    `workflows/${TRIO}/stages/b/run.sh`,
    `#!/usr/bin/env bash
printf '%s\\n' '{"type":"error:port","port":"codeHost","op":"push","code":"unavailable","message":"codeHost.push: GitHub is unreachable"}' >> "$SAIL_EVENTS"
exit 1
`,
  );
  chmodSync(run, 0o755);
}

async function ran(cwd: string, workflow = 'ticket-to-pr'): Promise<RunEnd> {
  const end = await runWorkflow({ cwd, adapters: await fakeAdapters(cwd), workflow, ticket: 'FAKE-1' });
  if ('refused' in end) throw new Error(`refused: ${end.refused}`);
  return end;
}

async function resumed(cwd: string, runId: string): Promise<RunEnd> {
  const end = await resumeWorkflow({ cwd, runId, adapters: await fakeAdapters(cwd) });
  if ('refused' in end) throw new Error(`refused: ${end.refused}`);
  return end;
}

test('a run whose publish#1 ends on an unavailable push is suspended port_unavailable: run:suspended names the call, then run:end, and publish#1 is not journaled', async () => {
  await withTempRepo(async (repo) => {
    downFor(repo.dir, 1);
    const end = await ran(repo.dir);
    const list = readEvents(end.dir);
    const at = list.findIndex((event) => event.type === 'run:suspended');
    expect({
      end: { status: end.status, stopReason: end.stopReason, message: end.message },
      status: status(end.dir),
      trail: list.slice(at).map(bare),
      journal: keys(end.dir).filter((key) => key.startsWith('publish')),
      workspace: existsSync(join(end.dir, 'workspace', '.git')),
      released: list.filter(
        (event) => event.type === 'workspace:released' || event.type === 'workspace:lease_released',
      ),
      leases: leasesIn(repo.dir).length,
    }).toEqual({
      end: {
        status: 'suspended',
        stopReason: 'port_unavailable',
        message: 'publish#1 could not reach a provider: a resume runs it again',
      },
      status: 'suspended port_unavailable\n',
      trail: [
        { type: 'run:suspended', stopReason: 'port_unavailable', key: 'publish#1' },
        {
          type: 'run:end',
          status: 'suspended',
          stopReason: 'port_unavailable',
          message: 'publish#1 could not reach a provider: a resume runs it again',
          replays: expect.any(Number),
        },
      ],
      journal: ['publish#1/describe'],
      workspace: true,
      released: [],
      leases: 1,
    });
  });
});

test('a resume of a run suspended on an unavailable port runs publish#1/open again, not describe, journals the call and completes', async () => {
  await withTempRepo(async (from) => {
    downFor(from.dir, 1);
    const suspended = await ran(from.dir);
    await withTempRepo(async (repo) => {
      copyRun(from.dir, repo.dir);
      const dir = join(repo.dir, '.sail-runs', suspended.runId);
      const before = readEvents(dir).length;
      const end = await resumed(repo.dir, suspended.runId);
      const after = readEvents(dir).slice(before);
      expect({
        status: end.status,
        started: after.filter((event) => event.type === 'step:start').map((event) => event.key),
        journal: keys(dir).filter((key) => key.startsWith('publish')),
        final: status(dir),
      }).toEqual({
        status: 'completed',
        started: ['publish#1/open'],
        journal: ['publish#1/describe', 'publish#1/open', 'publish#1'],
        final: 'completed\n',
      });
    });
  });
});

test('in a group, a member that ends on an unavailable port is left unjournaled while the members that passed are journaled, and the run is suspended port_unavailable (review R6)', async () => {
  await withTempRepo(async (repo) => {
    trioDownAtB(repo.dir);
    const end = await ran(repo.dir, TRIO);
    expect({
      status: end.status,
      stopReason: end.stopReason,
      journal: keys(end.dir).sort(),
      suspended: readEvents(end.dir)
        .filter((event) => event.type === 'run:suspended')
        .map(bare),
    }).toEqual({
      status: 'suspended',
      stopReason: 'port_unavailable',
      journal: ['a#1', 'c#1', 'intake#1'],
      suspended: [{ type: 'run:suspended', stopReason: 'port_unavailable', key: 'b#1' }],
    });
  });
});

test('in a group whose member ends on an unavailable port while another hits the usage limit, the usage limit suspends the run (review R6)', async () => {
  await withTempRepo(async (repo) => {
    trioDownAtB(repo.dir, { c: [{ outcome: 'error', reason: 'usage_limit', message: 'limit', resetsAt: RESETS_AT }] });
    const end = await ran(repo.dir, TRIO);
    expect({
      status: end.status,
      stopReason: end.stopReason,
      journal: keys(end.dir).sort(),
      suspended: readEvents(end.dir)
        .filter((event) => event.type === 'run:suspended')
        .map(bare),
    }).toEqual({
      status: 'suspended',
      stopReason: 'usage_limit',
      journal: ['a#1', 'intake#1'],
      suspended: [{ type: 'run:suspended', stopReason: 'usage_limit', key: 'c#1', resetsAt: RESETS_AT }],
    });
  });
});
