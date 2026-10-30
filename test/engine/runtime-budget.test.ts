// A run under its budget (runtime.ts with budget.ts): the fixture's ticket-to-pr on the fakes, with its run budget
// rewritten. A run that uses up its budget is suspended with budget_exceeded before its next call, the call that ran
// out of the run's budget left unjournaled, and a resume given a raise takes it on from there. Each case has a temp
// repository of its own: one run per .sail/ in a process, so a resume runs in a copy of the repository it was suspended
// in (copyRun()).
import { expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessScript } from '../../src/adapters/fake/harness';
import { readJournal } from '../../src/engine/journal';
import {
  type ResumeWorkflowOptions,
  type RunEnd,
  type RunWorkflowOptions,
  resumeWorkflow,
  runWorkflow,
} from '../../src/engine/runtime';
import { readEvents } from '../../src/events/consumers/ndjson';
import type { SailEvent } from '../../src/events/types';
import type { HarnessRequest } from '../../src/ports/harness';
import { fakeAdapters } from '../helpers/adapters';
import { writeHarnessScript } from '../helpers/agent-fixture';
import { copyFixture, edit } from '../helpers/fixture';
import { holdTempRepo } from '../helpers/held-repo';
import { REVIEW_KEYS, TRIO, writeTrio } from '../helpers/review-fixture';
import { recording } from '../helpers/scripted-harness';
import { copyRun, STUB_SPEC_CALL, writeStub } from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';

const BUDGET = 'budgets: { run: { maxUsd: 25, maxMinutes: 90 } }';
const FIXTURE_JOURNAL = [
  'intake#1',
  'spec#1',
  'implement#1',
  'tests#1',
  'implement#2',
  'tests#2',
  'self-review#1',
  'publish#1/describe',
  'publish#1/open',
  'publish#1',
];

/** The fixture's `.sail/` in `repoDir`, its run budget set to `budget`. */
function fixtureWith(repoDir: string, budget: string): string {
  const sail = copyFixture(repoDir);
  edit(sail, 'project.yaml', BUDGET, `budgets: { run: ${budget} }`);
  return sail;
}

/** The fixture's harness script, read from a copy in `repoDir`. */
const scriptIn = (repoDir: string): HarnessScript =>
  JSON.parse(readFileSync(join(repoDir, '.sail', 'fake', 'harness.json'), 'utf8')) as HarnessScript;

/** Runs `workflow` (ticket-to-pr) from `cwd` on `FAKE-1`, on the fakes or as `options` say. It must not be refused. */
async function ran(
  cwd: string,
  options: Partial<RunWorkflowOptions> & { requests?: HarnessRequest[] } = {},
): Promise<RunEnd> {
  const adapters = await fakeAdapters(cwd);
  const harness = recording(adapters.ports.harness);
  const end = await runWorkflow({
    cwd,
    adapters: { ...adapters, ports: { ...adapters.ports, harness } },
    workflow: 'ticket-to-pr',
    ticket: 'FAKE-1',
    ...options,
  });
  options.requests?.push(...harness.requests);
  if ('refused' in end) throw new Error(`refused: ${end.refused}`);
  return end;
}

/** Resumes run `runId` from `cwd` on the fakes, with `options`: its end, or its refusal. */
async function resumed(
  cwd: string,
  runId: string,
  options: Partial<ResumeWorkflowOptions> = {},
): Promise<RunEnd | { refused: string }> {
  return resumeWorkflow({ cwd, runId, adapters: await fakeAdapters(cwd), ...options });
}

const keys = (runDir: string) => readJournal(runDir).entries.map((entry) => entry.key);
const sha256 = (path: string) => new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex');
const status = (runDir: string) => readFileSync(join(runDir, 'STATUS'), 'utf8');
const dollars = (value: number) => Math.round(value * 1e6) / 1e6;

/** What the run's sessions spent in all, from their ends. */
const spent = (list: readonly SailEvent[]) =>
  dollars(list.reduce((sum, event) => sum + (event.type === 'harness:session_end' ? event.usage.costUsd : 0), 0));

/** The budget events and the run:suspended and run:end, in order, without their envelopes. */
const budgetTrail = (list: readonly SailEvent[]) =>
  list
    .filter((event) => event.type.startsWith('budget:') || event.type === 'run:suspended' || event.type === 'run:end')
    .map(({ seq: _s, ts: _t, runId: _r, ...rest }) => ('used' in rest ? { ...rest, used: dollars(rest.used) } : rest));

/** The errors of the first try of `key`, from its `stage:end`'s result. */
function errorsOf(runDir: string, list: readonly SailEvent[], key: string, tryNumber = 1): unknown {
  const ended = list.find((event) => event.type === 'stage:end' && event.key === key && event.try === tryNumber);
  if (ended?.type !== 'stage:end') return undefined;
  return (JSON.parse(readFileSync(join(runDir, ended.resultPath), 'utf8')) as { errors?: unknown }).errors;
}

const OVER = '{ maxUsd: 0.5, maxMinutes: 90 }';

const overRepo = holdTempRepo();
let overOnce: Promise<{ end: RunEnd; requests: HarnessRequest[] }> | undefined;
/**
 * The fixture run with `maxUsd: 0.5`, suspended over its budget once for the file in a repository held for it, and the
 * requests its harness was given. The cases read it, and copy it to resume it: the source is never touched again.
 */
function overBudget(): Promise<{ end: RunEnd; requests: HarnessRequest[] }> {
  overOnce ??= (async () => {
    fixtureWith(overRepo().dir, OVER);
    const requests: HarnessRequest[] = [];
    const end = await ran(overRepo().dir, { requests });
    expect(end.stopReason).toBe('budget_exceeded');
    return { end, requests };
  })();
  return overOnce;
}

/** The fixture run suspended over `budget`, copied into `to`: the shared one for the default budget. Its id. */
async function suspendedCopy(to: string, budget = OVER): Promise<string> {
  if (budget === OVER) {
    const { end } = await overBudget();
    copyRun(overRepo().dir, to);
    return end.runId;
  }
  return withTempRepo(async (from) => {
    fixtureWith(from.dir, budget);
    const end = await ran(from.dir);
    expect(end.stopReason).toBe('budget_exceeded');
    copyRun(from.dir, to);
    return end.runId;
  });
}

test('a run whose budget is below its needs is suspended with budget_exceeded before its next call: STATUS says so, and the journal ends at the last call that completed', async () => {
  const { end } = await overBudget();
  const list = readEvents(end.dir);
  expect({
    end: { status: end.status, stopReason: end.stopReason, budget: end.budget, message: end.message },
    status: status(end.dir),
    journal: keys(end.dir),
    implement: errorsOf(end.dir, list, 'implement#1'),
  }).toEqual({
    end: {
      status: 'suspended',
      stopReason: 'budget_exceeded',
      budget: 'usd',
      message: '$0.50 of its $0.50 used before implement#1: raise it with --raise-budget <usd>',
    },
    status: 'suspended budget_exceeded\n',
    journal: ['intake#1', 'spec#1'],
    implement: [{ reason: 'budget_exceeded', message: 'budget exceeded: maxUsd 0.1875' }],
  });
});

test("the run's warning at 80%, its exceeded budget, the session's own and run:suspended come in that order, and the sessions spent the budget plus one turn", async () => {
  const { end } = await overBudget();
  const list = readEvents(end.dir);
  expect({ trail: budgetTrail(list), spent: spent(list) }).toEqual({
    trail: [
      { type: 'budget:warning', budget: 'usd', limit: 0.5, used: 0.4077 },
      { type: 'budget:exceeded', budget: 'usd', limit: 0.5, used: 0.5029 },
      { type: 'budget:exceeded', key: 'implement#1', budget: 'usd', limit: 0.1875, used: 0.1904 },
      { type: 'run:suspended', stopReason: 'budget_exceeded', budget: 'usd', limit: 0.5, used: 0.5029 },
      {
        type: 'run:end',
        status: 'suspended',
        stopReason: 'budget_exceeded',
        message: '$0.50 of its $0.50 used before implement#1: raise it with --raise-budget <usd>',
        replays: 3,
      },
    ],
    spent: 0.5029,
  });
});

test("each agent request is narrowed to what the run has left, keeping its step's own budget where that is smaller", async () => {
  const { requests } = await overBudget();
  expect(requests.map((request) => [request.key, request.budget.maxUsd, request.budget.maxMinutes])).toEqual([
    ['spec#1', 0.5, 10],
    ['implement#1', 0.1875, 20],
  ]);
});

test('a run with maxUsd 0 is suspended before intake#1, with nothing journaled', async () => {
  await withTempRepo(async (repo) => {
    fixtureWith(repo.dir, '{ maxUsd: 0 }');
    const end = await ran(repo.dir);
    expect({
      stopReason: end.stopReason,
      message: end.message,
      journal: keys(end.dir),
      suspended: budgetTrail(readEvents(end.dir)).filter((event) => event.type === 'run:suspended'),
    }).toEqual({
      stopReason: 'budget_exceeded',
      message: '$0.00 of its $0.00 used before intake#1: raise it with --raise-budget <usd>',
      journal: [],
      suspended: [{ type: 'run:suspended', stopReason: 'budget_exceeded', budget: 'usd', limit: 0, used: 0 }],
    });
  });
});

test('a session that finishes done as it crosses the budget, reporting its dollars only at its end, is journaled, and the run is suspended before the next call', async () => {
  await withTempRepo(async (repo) => {
    fixtureWith(repo.dir, '{ maxUsd: 0.5 }');
    const script = scriptIn(repo.dir);
    script['implement#1'] = (script['implement#1'] ?? []).map((answer) => ({ ...answer, turns: 1 }));
    writeHarnessScript(repo.dir, script);
    const adapters = await fakeAdapters(repo.dir);
    const fake = adapters.ports.harness;
    // As claude-code does: no usage update along the way, the session's dollars in its result alone.
    const silent = {
      ...fake,
      name: fake.name,
      capabilities: () => fake.capabilities(),
      run: (request: HarnessRequest) =>
        fake.run({
          ...request,
          onEvent: (event) => (event.type === 'usage:update' ? undefined : request.onEvent?.(event)),
        }),
    };
    const end = await runWorkflow({
      cwd: repo.dir,
      adapters: { ...adapters, ports: { ...adapters.ports, harness: silent } },
      workflow: 'ticket-to-pr',
      ticket: 'FAKE-1',
    });
    if ('refused' in end) throw new Error(end.refused);
    expect({
      journal: readJournal(end.dir).entries.map((entry) => `${entry.key} ${entry.outcome}`),
      message: end.message,
      suspended: budgetTrail(readEvents(end.dir)).find((event) => event.type === 'run:suspended'),
    }).toEqual({
      journal: ['intake#1 passed', 'spec#1 done', 'implement#1 done'],
      message: '$0.79 of its $0.50 used before tests#1: raise it with --raise-budget <usd>',
      suspended: { type: 'run:suspended', stopReason: 'budget_exceeded', budget: 'usd', limit: 0.5, used: 0.7885 },
    });
  });
});

test('reviewers that run at once share what the run has left: the one handed it is journaled, those it starved are not, and the run is suspended before asking for them again', async () => {
  await withTempRepo(async (repo) => {
    fixtureWith(repo.dir, '{ maxUsd: 0.1 }');
    const script = scriptIn(repo.dir);
    // Two turns of $0.02 each: a reviewer handed nothing ends after its first.
    for (const key of REVIEW_KEYS) {
      const name = key.replace('#1', '');
      script[name] = (script[name] ?? []).map((answer) => ({ ...answer, turns: 2, usage: { costUsd: 0.04 } }));
    }
    writeHarnessScript(repo.dir, script);
    const end = await ran(repo.dir, { workflow: 'review' });
    const list = readEvents(end.dir);
    const reviewed = keys(end.dir).filter((key) => key !== 'intake#1');
    const starved = REVIEW_KEYS.filter((key) => !reviewed.includes(key));
    expect({
      stopReason: end.stopReason,
      journaled: reviewed.length,
      starved: starved.map((key) => errorsOf(end.dir, list, key)),
      spent: spent(list),
      message: end.message,
    }).toEqual({
      stopReason: 'budget_exceeded',
      journaled: 1,
      // Each starved reviewer is handed the least share, $0.000001, never $0, which claude-code refuses.
      starved: Array(5).fill([{ reason: 'budget_exceeded', message: 'budget exceeded: maxUsd 0.000001' }]),
      // The budget, and one turn for each of the five it starved: within the budget plus a turn per session.
      spent: 0.14,
      message: `$0.14 of its $0.10 used before the group ${REVIEW_KEYS.join(', ')}: raise it with --raise-budget <usd>`,
    });
  });
});

test('a sibling starved by the shares of the others while the run is under its budget is asked for again, not journaled as an error, and the run completes', async () => {
  await withTempRepo(async (repo) => {
    const sail = writeTrio(repo.dir, { a: 300, b: 300, c: 300 });
    edit(sail, 'project.yaml', BUDGET, 'budgets: { run: { maxUsd: 2 } }');
    const script = scriptIn(repo.dir);
    for (const name of ['a', 'b', 'c']) {
      script[name] = (script[name] ?? []).map((answer) => ({ ...answer, turns: 2, usage: { costUsd: 0.02 } }));
    }
    writeHarnessScript(repo.dir, script);
    const end = await ran(repo.dir, { workflow: TRIO });
    const list = readEvents(end.dir);
    const retried = ['a#1', 'b#1', 'c#1'].filter((key) =>
      list.some((event) => event.type === 'stage:start' && event.key === key && event.try === 2),
    );
    expect({
      status: end.status,
      journal: readJournal(end.dir)
        .entries.map((entry) => `${entry.key} ${entry.outcome}`)
        .sort(),
      retried: retried.length,
      firstTry: retried.map((key) => errorsOf(end.dir, list, key)),
    }).toEqual({
      status: 'completed',
      journal: ['a#1 done', 'b#1 done', 'c#1 done', 'd#1 done', 'intake#1 passed'],
      retried: 1,
      firstTry: [[{ reason: 'budget_exceeded', message: 'budget exceeded: maxUsd 0.000001' }]],
    });
  });
});

test('a session handed less time than it needs ends over the minutes, and the run is suspended over its minutes with that call unjournaled', async () => {
  await withTempRepo(async (repo) => {
    // 1.2 s: enough for the intake, well short of the session's 6 s.
    fixtureWith(repo.dir, '{ maxMinutes: 0.02 }');
    const script = scriptIn(repo.dir);
    script.spec = (script.spec ?? []).map((answer) => ({ ...answer, delayMs: 6000 }));
    writeHarnessScript(repo.dir, script);
    const end = await ran(repo.dir);
    expect({ budget: end.budget, journal: keys(end.dir) }).toEqual({ budget: 'minutes', journal: ['intake#1'] });
  });
});

test("a replay that hangs in the workflow's own code is suspended with budget_exceeded once the run's minutes are used up", async () => {
  await withTempRepo(async (repo) => {
    const sail = writeStub(repo.dir);
    edit(sail, 'project.yaml', BUDGET, 'budgets: { run: { maxMinutes: 0.01 } }');
    edit(
      sail,
      'workflows/ticket-to-pr/workflow.ts',
      STUB_SPEC_CALL,
      `  await new Promise<void>(() => {});\n${STUB_SPEC_CALL}`,
    );
    const end = await Promise.race([
      ran(repo.dir),
      Bun.sleep(2000).then(() => {
        throw new Error('hung replay did not suspend within two seconds');
      }),
    ]);
    expect({
      status: end.status,
      reason: end.stopReason,
      budget: end.budget,
      statusFile: status(end.dir),
      journal: keys(end.dir),
    }).toEqual({
      status: 'suspended',
      reason: 'budget_exceeded',
      budget: 'minutes',
      statusFile: 'suspended budget_exceeded\n',
      journal: ['intake#1'],
    });
    expect(end.message).toMatch(
      /^[\d.]+ of its 0.01 minutes used during the replay: raise it with --raise-minutes <minutes>$/,
    );
    const trail = budgetTrail(readEvents(end.dir));
    expect(trail.map((event) => event.type)).toEqual(['budget:warning', 'budget:exceeded', 'run:suspended', 'run:end']);
    expect(trail[1]).toEqual({ type: 'budget:exceeded', budget: 'minutes', limit: 0.01, used: expect.any(Number) });
    expect(trail[2]).toEqual({
      type: 'run:suspended',
      stopReason: 'budget_exceeded',
      budget: 'minutes',
      limit: 0.01,
      used: expect.any(Number),
    });
  });
});

test('a large minute budget caps each replay timer wait at the signed 32-bit maximum', async () => {
  await withTempRepo(async (repo) => {
    const sail = writeStub(repo.dir);
    edit(sail, 'project.yaml', BUDGET, 'budgets: { run: { maxMinutes: 40000 } }');
    const timer = spyOn(globalThis, 'setTimeout');
    try {
      const end = await ran(repo.dir);
      expect(end.status).toBe('completed');
      const waits = timer.mock.calls.map((call) => call[1] ?? 0);
      expect(waits.some((wait) => wait === 2 ** 31 - 1)).toBe(true);
      expect(waits.every((wait) => wait <= 2 ** 31 - 1)).toBe(true);
    } finally {
      timer.mockRestore();
    }
  });
});

test("a replay that settles before the budget's timer still ends the run its own way", async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const end = await ran(repo.dir);
    expect(end.status).toBe('completed');
    expect(readEvents(end.dir).filter((event) => event.type === 'run:suspended')).toEqual([]);
  });
});

test("a workflow that waits past the run's minutes before its first stage is suspended before that stage starts", async () => {
  await withTempRepo(async (repo) => {
    const sail = writeStub(repo.dir);
    edit(sail, 'project.yaml', BUDGET, 'budgets: { run: { maxMinutes: 0.01 } }');
    edit(
      sail,
      'workflows/ticket-to-pr/workflow.ts',
      STUB_SPEC_CALL,
      // The first replay alone waits, so a run that isn't suspended goes on at the stub's pace.
      `  if (!(globalThis as { waited?: boolean }).waited) {\n    (globalThis as { waited?: boolean }).waited = true;\n    await new Promise((resolve) => setTimeout(resolve, 1000));\n  }\n${STUB_SPEC_CALL}`,
    );
    const end = await ran(repo.dir);
    const list = readEvents(end.dir);
    expect({
      stopReason: end.stopReason,
      budget: end.budget,
      message: end.message?.replace(/^[\d.]+ of/, '<used> of'),
      specStarted: list.some((event) => event.type === 'stage:start' && event.key === 'spec#1'),
      journal: keys(end.dir),
    }).toEqual({
      stopReason: 'budget_exceeded',
      budget: 'minutes',
      message: '<used> of its 0.01 minutes used during the replay: raise it with --raise-minutes <minutes>',
      specStarted: false,
      journal: ['intake#1'],
    });
  });
});

test("a session's end that can't be confirmed on disk crashes the run before its call is journaled, and STATUS stays running", async () => {
  await withTempRepo(async (repo) => {
    fixtureWith(repo.dir, '{ maxUsd: 25 }');
    const events = join(repo.dir, '.sail-runs');
    let runDir = '';
    // Once run:start is written, the events file takes no more lines: each append fails, and the bus swallows it.
    const freeze = {
      name: 'freeze',
      onEvent(event: SailEvent) {
        if (event.type !== 'run:start') return;
        runDir = join(events, event.runId);
        chmodSync(join(runDir, 'events.ndjson'), 0o444);
      },
    };
    let crashed: unknown;
    try {
      await ran(repo.dir, { consumers: [freeze], unreported: () => {} });
    } catch (error) {
      crashed = error;
    }
    expect({
      crashed: crashed instanceof Error ? crashed.message.replace(/\d+/g, 'n') : crashed,
      journal: existsSync(runDir) ? keys(runDir) : 'no run',
      status: existsSync(runDir) ? status(runDir) : 'no run',
    }).toEqual({
      crashed: 'events.ndjson ends with event n, not harness:session_end n: it is not on disk',
      journal: ['intake#1'],
      status: 'running\n',
    });
  });
});

// The resume after a raise (TASK-005).

test('a resume raised by $5 records budget:raised right after its renewed lease, runs implement#1 again as its second try, completes, and leaves run.json byte for byte', async () => {
  await withTempRepo(async (repo) => {
    const runId = await suspendedCopy(repo.dir);
    const dir = join(repo.dir, '.sail-runs', runId);
    const header = sha256(join(dir, 'run.json'));
    const before = readEvents(dir).length;
    const end = await resumed(repo.dir, runId, { raise: { usd: 5 } });
    const after = readEvents(dir).slice(before);
    const at = after.findIndex((event) => event.type === 'budget:raised');
    expect({
      status: 'status' in end ? end.status : end.refused,
      raised: after
        .filter((event) => event.type === 'budget:raised')
        .map(({ seq: _s, ts: _t, runId: _r, ...rest }) => rest),
      before: after[at - 1]?.type,
      implement: after.find((event) => event.type === 'stage:start' && event.key === 'implement#1'),
      journal: keys(dir),
      header: sha256(join(dir, 'run.json')),
    }).toEqual({
      status: 'completed',
      raised: [{ type: 'budget:raised', usd: 5, budget: { maxUsd: 5.5, maxMinutes: 90 } }],
      before: 'workspace:leased',
      implement: expect.objectContaining({ try: 2 }),
      journal: FIXTURE_JOURNAL,
      header,
    });
  });
});

test('a resume with no raise, or one too small, of a run over its budget is refused, and STATUS and the events file stay as they were', async () => {
  await withTempRepo(async (repo) => {
    const runId = await suspendedCopy(repo.dir);
    const dir = join(repo.dir, '.sail-runs', runId);
    const events = sha256(join(dir, 'events.ndjson'));
    const plain = await resumed(repo.dir, runId);
    const small = await resumed(repo.dir, runId, { raise: { usd: 0.001 } });
    expect({ plain, small, status: status(dir), events: sha256(join(dir, 'events.ndjson')) }).toEqual({
      plain: { refused: `run ${runId} has used $0.50 of its $0.50: resume it with --raise-budget <usd>` },
      small: { refused: `run ${runId} has used $0.50 of its $0.50: resume it with --raise-budget <usd>` },
      status: 'suspended budget_exceeded\n',
      events,
    });
  });
});

test('a raise of minutes for a run with no minute budget is refused, and STATUS stays as it was', async () => {
  await withTempRepo(async (repo) => {
    const runId = await suspendedCopy(repo.dir, '{ maxUsd: 0 }');
    const dir = join(repo.dir, '.sail-runs', runId);
    expect({
      refused: await resumed(repo.dir, runId, { raise: { minutes: 30 } }),
      status: status(dir),
    }).toEqual({
      refused: { refused: `run ${runId} has no minute budget to raise` },
      status: 'suspended budget_exceeded\n',
    });
  });
});

// A multi-step stage under the run's budget: the fixture's publish, describe (an agent step) then open (a script step).
// The calls before it spend $1.249, and describe spends $0.02525 a turn over four turns.

/** Each step's start, as `<key> try <n>`, in order. */
const stepStarts = (list: readonly SailEvent[]) =>
  list.flatMap((event) => (event.type === 'step:start' ? [`${event.key} try ${event.try}`] : []));

/** A keyed `budget:exceeded`, without its envelope. */
const exceededOf = (list: readonly SailEvent[], key: string) =>
  budgetTrail(list).find((event) => event.type === 'budget:exceeded' && 'key' in event && event.key === key);

test("an agent step that runs out of the run's budget is left unjournaled with its call, the run is suspended before the call, and a raised resume runs the call again from that step", async () => {
  await withTempRepo(async (repo) => {
    // describe is handed the $0.051 left of $1.30, not its own $1, and its third turn reaches $0.07575.
    const runId = await suspendedCopy(repo.dir, '{ maxUsd: 1.3 }');
    const dir = join(repo.dir, '.sail-runs', runId);
    const first = readEvents(dir);
    const suspendedWith = { journal: keys(dir), status: status(dir) };
    const end = await resumed(repo.dir, runId, { raise: { usd: 1 } });
    const list = readEvents(dir);
    expect({
      suspendedWith,
      describe: exceededOf(first, 'publish#1/describe'),
      message: first.findLast((event) => event.type === 'run:end')?.message,
      status: 'status' in end ? end.status : end.refused,
      journal: keys(dir),
      steps: stepStarts(list),
    }).toEqual({
      suspendedWith: { journal: FIXTURE_JOURNAL.slice(0, 7), status: 'suspended budget_exceeded\n' },
      describe: { type: 'budget:exceeded', key: 'publish#1/describe', budget: 'usd', limit: 0.051, used: 0.07575 },
      message: '$1.32 of its $1.30 used before publish#1: raise it with --raise-budget <usd>',
      status: 'completed',
      journal: FIXTURE_JOURNAL,
      steps: ['publish#1/describe try 1', 'publish#1/describe try 2', 'publish#1/open try 1'],
    });
  });
});

test("once a step uses up the run's budget no further step of its call starts: the run is suspended before the call with that step journaled, and a raised resume runs only the steps after it", async () => {
  await withTempRepo(async (repo) => {
    // describe is handed $0.081 of $1.33, finishes done at $0.101, and the run has then used $1.35.
    const runId = await suspendedCopy(repo.dir, '{ maxUsd: 1.33 }');
    const dir = join(repo.dir, '.sail-runs', runId);
    const first = readEvents(dir);
    const suspendedWith = { journal: keys(dir), steps: stepStarts(first) };
    const end = await resumed(repo.dir, runId, { raise: { usd: 1 } });
    const list = readEvents(dir);
    expect({
      suspendedWith,
      message: first.findLast((event) => event.type === 'run:end')?.message,
      status: 'status' in end ? end.status : end.refused,
      journal: keys(dir),
      steps: stepStarts(list),
      sessions: list.filter((event) => event.type === 'harness:session_start' && event.key === 'publish#1/describe')
        .length,
    }).toEqual({
      suspendedWith: { journal: FIXTURE_JOURNAL.slice(0, 8), steps: ['publish#1/describe try 1'] },
      message: '$1.35 of its $1.33 used before publish#1: raise it with --raise-budget <usd>',
      status: 'completed',
      journal: FIXTURE_JOURNAL,
      steps: ['publish#1/describe try 1', 'publish#1/open try 1'],
      sessions: 1,
    });
  });
});

test("a step's idle limit of 0 opens the run and fails it with the agent kind's own message, never an internal error (review D1)", async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const budget = 'budget: { maxTurns: 40, maxUsd: 2, maxMinutes: 10 }';
    edit(sail, 'workflows/ticket-to-pr/stages/spec/stage.ts', budget, budget.replace(' }', ', maxIdleMinutes: 0 }'));
    const end = await ran(repo.dir);
    expect(end.status).toBe('failed');
    expect(JSON.stringify(readEvents(end.dir))).toContain('budget.maxIdleMinutes must be a positive number: 0');
  });
});
