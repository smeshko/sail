// A run whose script step a signal sail didn't send ends (runtime.ts): the fixture's ticket-to-pr on the fakes, its tests
// stage killing itself once. The run is suspended `interrupted`, not failed: the call is left unjournaled, the workspace
// and the lease are kept, and a resume (in a copy of the repository, copyRun()) runs it again. A crash signal still fails
// the run, a call that passes `onError: 'return'` gets the error back, and in a group (the review fixture's trio, b a
// script that kills itself) the members that passed are journaled.
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJournal } from '../../src/engine/journal';
import { type RunEnd, resumeWorkflow, runWorkflow } from '../../src/engine/runtime';
import { readEvents } from '../../src/events/consumers/ndjson';
import type { SailEvent } from '../../src/events/types';
import { fakeAdapters } from '../helpers/adapters';
import { copyFixture, edit, write } from '../helpers/fixture';
import { TRIO, writeTrio } from '../helpers/review-fixture';
import { copyRun } from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';

const keys = (runDir: string) => readJournal(runDir).entries.map((entry) => entry.key);
const status = (runDir: string) => readFileSync(join(runDir, 'STATUS'), 'utf8');
const bare = ({ seq: _s, ts: _t, runId: _r, ...rest }: SailEvent) => rest;
const leasesIn = (repoDir: string) => {
  const dir = join(repoDir, '.sail-runs', 'fake', 'leases');
  return existsSync(dir) ? readdirSync(dir) : [];
};

/** The fixture with its first `tests` call killing itself with `signal`. */
function killedOnce(repoDir: string, signal: string): void {
  copyFixture(repoDir);
  edit(
    join(repoDir, '.sail'),
    'stages/tests/run.sh',
    'set -euo pipefail\n',
    // `$$$$` is a literal `$$` in a replacement string.
    `set -euo pipefail\nif [ ! -e .killed-once ]; then touch .killed-once; kill -${signal} $$$$; fi\n`,
  );
}

/** trio, its b a script that kills itself with TERM every time it runs. */
function trioKilledAtB(repoDir: string): void {
  const sail = writeTrio(repoDir, { a: 0, b: 0, c: 0 });
  write(
    sail,
    `workflows/${TRIO}/stages/b/stage.ts`,
    `// b: a script that is ended by a signal.
import { file, script, z } from 'sail';

export const b = script('b', {
  run: './run.sh',
  consumes: { brief: file('brief.md') },
  output: z.object({ name: z.string() }),
});
`,
  );
  const run = write(sail, `workflows/${TRIO}/stages/b/run.sh`, '#!/usr/bin/env bash\nkill -TERM $$\n');
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

const testsResult = (dir: string) => {
  const stage = readdirSync(dir).find((name) => name.endsWith('-tests')) ?? '';
  return JSON.parse(readFileSync(join(dir, stage, 'call-1', 'result.json'), 'utf8')) as { errors: { code?: string }[] };
};

test('a run whose tests#1 is ended by an outside SIGTERM is suspended interrupted, tests#1 is not journaled, and the lease is kept', async () => {
  await withTempRepo(async (repo) => {
    killedOnce(repo.dir, 'TERM');
    const end = await ran(repo.dir);
    const list = readEvents(end.dir);
    expect({
      end: { status: end.status, stopReason: end.stopReason, message: end.message },
      status: status(end.dir),
      tail: list.slice(-1).map(bare),
      journaled: keys(end.dir).some((key) => key.startsWith('tests#1')),
      code: testsResult(end.dir).errors[0]?.code,
      workspace: existsSync(join(end.dir, 'workspace', '.git')),
      leases: leasesIn(repo.dir).length,
    }).toEqual({
      end: {
        status: 'suspended',
        stopReason: 'interrupted',
        message: "tests#1 was ended by a signal sail didn't send: a resume runs it again",
      },
      status: 'suspended interrupted\n',
      tail: [
        {
          type: 'run:end',
          status: 'suspended',
          stopReason: 'interrupted',
          message: "tests#1 was ended by a signal sail didn't send: a resume runs it again",
          replays: expect.any(Number),
        },
      ],
      journaled: false,
      code: 'signalled',
      workspace: true,
      leases: 1,
    });
  });
});

test('a resume of a run suspended on an outside SIGTERM runs tests#1 again and completes', async () => {
  await withTempRepo(async (from) => {
    killedOnce(from.dir, 'TERM');
    const suspended = await ran(from.dir);
    await withTempRepo(async (repo) => {
      copyRun(from.dir, repo.dir);
      const end = await resumed(repo.dir, suspended.runId);
      const dir = join(repo.dir, '.sail-runs', suspended.runId);
      expect({
        status: end.status,
        tests: keys(dir).filter((key) => key === 'tests#1'),
        final: status(dir),
      }).toEqual({ status: 'completed', tests: ['tests#1'], final: 'completed\n' });
    });
  });
});

test('a script ended by SIGKILL from outside sail suspends the run the same way', async () => {
  await withTempRepo(async (repo) => {
    killedOnce(repo.dir, 'KILL');
    const end = await ran(repo.dir);
    expect({
      status: end.status,
      stopReason: end.stopReason,
      journaled: keys(end.dir).some((key) => key.startsWith('tests#1')),
    }).toEqual({ status: 'suspended', stopReason: 'interrupted', journaled: false });
  });
});

test('a script ended by SIGSEGV fails the run with stage_error, and tests#1 is journaled', async () => {
  await withTempRepo(async (repo) => {
    killedOnce(repo.dir, 'SEGV');
    const end = await ran(repo.dir);
    expect({
      status: end.status,
      stopReason: end.stopReason,
      journaled: keys(end.dir).includes('tests#1'),
      code: testsResult(end.dir).errors[0]?.code,
    }).toEqual({ status: 'failed', stopReason: 'stage_error', journaled: true, code: undefined });
  });
});

test('a call that passes onError: return gets its signalled error back, and the run goes on', async () => {
  await withTempRepo(async (repo) => {
    trioKilledAtB(repo.dir);
    write(
      join(repo.dir, '.sail'),
      `workflows/${TRIO}/workflow.ts`,
      `import { workflow } from 'sail';
import { ticket } from 'sail/intakes';
import { b } from './stages/b/stage';

export default workflow('${TRIO}', { intake: ticket, version: 1 }, async (run) => {
  const brief = run.intake.files['brief.md'];
  const alone = await run.stage(b, { brief }, { onError: 'return' });
  const [grouped] = await run.all([[b, { brief }, { onError: 'return' }]] as const);
  return { alone: alone.outcome, grouped: grouped.outcome };
});
`,
    );
    const end = await ran(repo.dir, TRIO);
    expect({ status: end.status, stopReason: end.stopReason, journal: keys(end.dir) }).toEqual({
      status: 'completed',
      stopReason: undefined,
      journal: ['intake#1', 'b#1', 'b#2'],
    });
  });
});

test('in a group, a member ended by an outside signal is left unjournaled while the members that passed are journaled, and the run is suspended interrupted', async () => {
  await withTempRepo(async (repo) => {
    trioKilledAtB(repo.dir);
    const end = await ran(repo.dir, TRIO);
    expect({ status: end.status, stopReason: end.stopReason, journal: keys(end.dir).sort() }).toEqual({
      status: 'suspended',
      stopReason: 'interrupted',
      journal: ['a#1', 'c#1', 'intake#1'],
    });
  });
});
