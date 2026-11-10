// Generates the dashboard's dense fixture, `test/fixtures/dashboard/dense/`: five clone folders, each holding what a
// clone's `.sail-runs/` holds, for 44 runs of a busy machine: 4 running, 3 suspended, 1 unreadable, 9 failed and 27
// completed, with a queue in two of the clones. Each readable run is derived from the recorded FAKE-3 run (`run.json`,
// `summary.json`, `events.ndjson` and `journal.ndjson`, no call directories) with its run id, ticket key, title, times
// and ending rewritten, so the folder stays small. Nothing is read from the clock or the machine: the same call writes
// the same bytes anywhere, which `test/dashboard/fixtures.test.ts` holds the committed folder to.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = join(import.meta.dir, '..', 'test', 'fixtures', 'dashboard', 'beta', 'FAKE-3-01M39H4ZW0S46MV303CFX3T4PY');
const BASE_ID = 'FAKE-3-01M39H4ZW0S46MV303CFX3T4PY';
const BASE_TITLE = 'Escape <b>this</b> & "that"';
const BASE_START = Date.parse('2026-09-24T11:00:00.700Z');
const BASE_SPAN_MS = 6200;

export type Ending = 'running' | 'suspended' | 'failed' | 'completed' | 'unreadable';

/** The clones, and the endings of the runs each holds, newest first. */
export const DENSE: Record<string, { prefix: string; endings: Ending[] }> = {
  atlas: {
    prefix: 'ATL',
    endings: ['running', 'suspended', 'failed', 'failed', ...Array<Ending>(6).fill('completed')],
  },
  borealis: {
    prefix: 'BOR',
    endings: ['running', 'suspended', 'unreadable', 'failed', 'failed', ...Array<Ending>(5).fill('completed')],
  },
  cirrus: { prefix: 'CIR', endings: ['running', 'failed', 'failed', ...Array<Ending>(6).fill('completed')] },
  delta: {
    prefix: 'DEL',
    endings: ['running', 'suspended', 'failed', 'failed', ...Array<Ending>(5).fill('completed')],
  },
  ember: { prefix: 'EMB', endings: ['failed', ...Array<Ending>(5).fill('completed')] },
};

const TITLES = [
  'Retry the fetch helper on a 503',
  'Cache the parsed config between commands',
  'Greet in the reader’s language when LANG is set',
  'Stop the watcher logging a poll twice',
  'Add a --json flag to every listing command',
  'Fix the off-by-one in the pagination of the run list',
  'Move the retry policy into one module, with its backoff configurable per adapter and per workflow, and document it',
  'Let sail check name the file a type error is in',
  'Show the stop reason beside a failed run',
  'Drop the unused lockfile reader',
  'Explain why a queue item is parked in the dashboard',
  'Make the first poll after a restart immediate',
];
const REVIEW_EVERY = 4;
const STOP_REASONS = ['stage_error', 'workflow_failed', 'determinism_violation'] as const;
const SUSPEND_REASONS = ['budget_exceeded', 'usage_limit', 'interrupted'] as const;

interface Plan {
  repo: string;
  key: string;
  runId: string;
  title: string;
  workflow: string;
  ending: Ending;
  startedAt: number;
  durationMs: number;
  costUsd: number;
  reason: string | undefined;
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');
const iso = (ms: number) => new Date(ms).toISOString();

/** What every run of the fixture is, in order: its clone, key, title, workflow, ending, times and cost. */
export function planRuns(): Plan[] {
  const plans: Plan[] = [];
  let n = 0;
  for (const [repo, { prefix, endings }] of Object.entries(DENSE)) {
    for (const ending of endings) {
      const i = n++;
      const key = `${prefix}-${100 + i}`;
      const startedAt = Date.parse('2026-10-01T11:40:00.000Z') - i * 23 * 60_000;
      plans.push({
        repo,
        key,
        // A ULID's 26 characters: fixed bytes, and the run's place in the fixture.
        runId: `${key}-01M7D${pad(i, 3)}DENSE${'0'.repeat(13)}`,
        title: TITLES[i % TITLES.length] ?? '',
        workflow: i % REVIEW_EVERY === 3 ? 'review' : 'ticket-to-pr',
        ending,
        startedAt,
        durationMs: (4 + ((i * 7) % 23)) * 60_000 + 12_000,
        costUsd: Math.round((0.35 + ((i * 37) % 290) / 100) * 100) / 100,
        reason:
          ending === 'failed'
            ? STOP_REASONS[i % STOP_REASONS.length]
            : ending === 'suspended'
              ? SUSPEND_REASONS[i % SUSPEND_REASONS.length]
              : undefined,
      });
    }
  }
  return plans;
}

const read = (file: string) => readFileSync(join(BASE, file), 'utf8');

/** `text` with the base run's id, key, title and workflow changed to the plan's. */
function rename(text: string, plan: Plan): string {
  const title = JSON.stringify(plan.title).slice(1, -1);
  const baseTitle = JSON.stringify(BASE_TITLE).slice(1, -1);
  const renamed = text.replaceAll(BASE_ID, plan.runId).replaceAll(baseTitle, title).replaceAll('FAKE-3', plan.key);
  return plan.workflow === 'ticket-to-pr' ? renamed : renamed.replaceAll('ticket-to-pr', plan.workflow);
}

const MESSAGES: Record<string, string> = {
  stage_error: 'implement#1 ended in error: harness: the session ended before it submitted a result',
  workflow_failed: 'the review found a blocking problem it could not fix',
  determinism_violation: 'the workflow asked for a call its journal does not hold',
  budget_exceeded: 'stopped during implement#1: the run spent more than its budget',
  usage_limit: 'the provider is out of sessions until its limit resets',
  interrupted: 'interrupted by SIGTERM',
};

/** Where `ts` of the base run falls in the plan's run: its offset from the start, stretched to the plan's duration. */
function shifted(ts: string, plan: Plan): string {
  const offset = Date.parse(ts) - BASE_START;
  return iso(plan.startedAt + Math.round((offset * plan.durationMs) / BASE_SPAN_MS));
}

function eventsOf(plan: Plan): string {
  const lines = read('events.ndjson').trimEnd().split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const event = JSON.parse(rename(line, plan)) as Record<string, unknown>;
    event.ts = shifted(String(event.ts), plan);
    if (event.type === 'run:end') {
      if (plan.ending === 'running') continue;
      event.status = plan.ending;
      delete event.stopReason;
      delete event.message;
      if (plan.reason !== undefined) {
        event.stopReason = plan.reason;
        event.message = MESSAGES[plan.reason] ?? plan.reason;
      }
    }
    out.push(JSON.stringify(event));
  }
  return `${out.join('\n')}\n`;
}

function summaryOf(plan: Plan): string {
  const summary = JSON.parse(rename(read('summary.json'), plan)) as Record<string, unknown> & {
    totals: { usage: { costUsd: number }; budget: { maxUsd: number; usedPct: number } };
  };
  summary.workflow = `${plan.workflow}@1`;
  summary.ticket = { ticketKey: plan.key, title: plan.title, url: `fake://tickets/${plan.key}` };
  summary.status = plan.ending;
  for (const field of ['stopReason', 'message', 'endedAt', 'durationMs']) delete summary[field];
  summary.startedAt = iso(plan.startedAt);
  if (plan.ending !== 'running') {
    summary.endedAt = iso(plan.startedAt + plan.durationMs);
    summary.durationMs = plan.durationMs;
  }
  if (plan.reason !== undefined) {
    summary.stopReason = plan.reason;
    summary.message = MESSAGES[plan.reason] ?? plan.reason;
  }
  summary.totals.usage.costUsd = plan.costUsd;
  summary.totals.budget = { maxUsd: 25, usedPct: Math.round((plan.costUsd / 25) * 1000) / 10 };
  return `${JSON.stringify(summary, null, 2)}\n`;
}

function headerOf(plan: Plan): string {
  const header = JSON.parse(rename(read('run.json'), plan)) as Record<string, unknown>;
  header.startedAt = iso(plan.startedAt);
  return `${JSON.stringify(header, null, 2)}\n`;
}

function statusOf(plan: Plan): string {
  return plan.reason === undefined ? `${plan.ending}\n` : `${plan.ending} ${plan.reason}\n`;
}

/** A queue of `workflow` in a clone: its items, polled at the given time. */
function queueOf(workflow: string, plans: Plan[], waiting: string[], polledAt: string) {
  const dispatched = plans.find((plan) => plan.ending === 'running');
  const item = (key: string, title: string, state: string, extra: Record<string, unknown> = {}) => ({
    dedupKey: `ticket:${key}`,
    source: { kind: 'ticket', ticketKey: key },
    title,
    url: `fake://tickets/${key}`,
    state,
    attempts: state === 'queued' ? 0 : 1,
    addedAt: '2026-10-01T10:50:00.000Z',
    ...extra,
  });
  const items = [
    ...waiting.map((key, at) => item(key, TITLES[(at + 4) % TITLES.length] ?? '', 'queued', { priority: 'high' })),
    ...(dispatched === undefined
      ? []
      : [item(dispatched.key, dispatched.title, 'dispatched', { runId: dispatched.runId })]),
    item('OLD-1', 'Keep the changelog in step with the releases', 'done', { finishedAt: '2026-10-01T10:58:00.000Z' }),
  ];
  const queue = {
    version: 1,
    workflow,
    updatedAt: polledAt,
    polling: { label: 'sail', failures: 0, lastPolledAt: polledAt },
    items,
  };
  const events = [
    {
      seq: 1,
      ts: '2026-10-01T10:49:59.000Z',
      type: 'watch:added',
      workflow,
      pid: 4242,
      label: 'sail',
      everyMs: 300000,
      maxConcurrentRuns: 2,
    },
    {
      seq: 2,
      ts: polledAt,
      type: 'queue:polled',
      workflow,
      kind: 'ticket',
      label: 'sail',
      found: items.length,
      added: 0,
      durationMs: 120,
    },
  ];
  return {
    'queue.json': `${JSON.stringify(queue, null, 2)}\n`,
    'events.ndjson': `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  };
}

/**
 * Writes the dense fixture under `outDir`: a folder per clone, and in it one directory per run and `queue/<workflow>/`
 * for the two clones that have a queue. Gives the files it wrote, relative to `outDir`, in the order written.
 */
export function writeDenseFixture(outDir: string): string[] {
  const written: string[] = [];
  const put = (file: string, text: string) => {
    const path = join(outDir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    written.push(file);
  };
  const plans = planRuns();
  for (const plan of plans) {
    const dir = `${plan.repo}/${plan.runId}`;
    if (plan.ending === 'unreadable') {
      // A run directory whose header is no run header: the index lists it by id, with its problem.
      put(`${dir}/run.json`, '{"schema":"sail.run.v0","note":"the header of a run an older sail wrote"}\n');
      continue;
    }
    put(`${dir}/run.json`, headerOf(plan));
    put(`${dir}/STATUS`, statusOf(plan));
    put(`${dir}/summary.json`, summaryOf(plan));
    put(`${dir}/events.ndjson`, eventsOf(plan));
    put(`${dir}/journal.ndjson`, rename(read('journal.ndjson'), plan));
  }
  const queues: [repo: string, workflow: string, waiting: string[]][] = [
    ['atlas', 'ticket-to-pr', ['ATL-201', 'ATL-202']],
    ['cirrus', 'review', []],
  ];
  for (const [repo, workflow, waiting] of queues) {
    const files = queueOf(
      workflow,
      plans.filter((plan) => plan.repo === repo),
      waiting,
      '2026-10-01T11:55:00.000Z',
    );
    for (const [name, text] of Object.entries(files)) put(`${repo}/queue/${workflow}/${name}`, text);
  }
  return written;
}

if (import.meta.main) {
  const out = process.argv[2];
  if (out === undefined) throw new Error('usage: bun scripts/dense-fixture.ts <outDir>');
  for (const file of writeDenseFixture(out)) console.log(file);
}
