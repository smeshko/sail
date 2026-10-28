// reconcileItem() (DECISIONS D5, D6): what one dispatched item's run needs, case by case, on run directories, dispatch
// logs and branch leases the test writes by hand. The leases are read through the real lease files.
import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { heldLease, takeLease } from '../../src/adapters/leases';
import { type Status, type StopReason, writeStatus } from '../../src/engine/run-dir';
import type { QueueItem } from '../../src/watch/queue-store';
import { type ReconcileContext, type Reconciled, reconcileItem } from '../../src/watch/reconcile';
import { dispatchLog } from '../../src/watch/spawn';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const REMOTE = 'fake://origin';
const NOW = '2026-10-28T10:00:00.000Z';
const BACKOFF = 15 * 60_000;
/** The pid of the run's process when it is alive: no real process has it. */
const LIVE = 900_100;
const DEAD = 900_101;

/** A `.sail-runs/` in a temp dir, with its leases beside it. */
function world() {
  const root = mkdtempSync(join(tmpdir(), 'sail-reconcile-'));
  dirs.push(root);
  const runsDir = join(root, '.sail-runs');
  const leases = join(root, 'leases');
  mkdirSync(runsDir, { recursive: true });
  const context = (fields: Partial<ReconcileContext> = {}): ReconcileContext => ({
    runsDir,
    workflow: 'a',
    isAlive: (pid) => pid === LIVE || pid === process.pid,
    workspace: { holder: async (remote, branch) => heldLease(leases, remote, branch) },
    now: new Date(NOW),
    backoffMs: BACKOFF,
    first: false,
    resumed: false,
    ...fields,
  });
  return { runsDir, leases, context };
}

/** Item `n`, dispatched as run `FAKE-<n>-…` with process `pid`. */
function item(n: number, pid?: number): QueueItem {
  return {
    dedupKey: `ticket:FAKE-${n}`,
    source: { kind: 'ticket', ticketKey: `FAKE-${n}` },
    title: `Ticket FAKE-${n}`,
    url: `fake://tickets/FAKE-${n}`,
    state: 'dispatched',
    attempts: 1,
    addedAt: '2026-10-19T09:00:00.000Z',
    runId: runIdOf(n),
    ...(pid === undefined ? {} : { pid }),
  };
}

const runIdOf = (n: number) => `FAKE-${n}-01M3BWNZM08Q4T6V2XRJ5KWD3N`;
const branchOf = (n: number) => `sail/FAKE-${n}-ticket-fake-${n}`;

/** Writes run `n`'s run.json, naming its branch and remote, and its STATUS. */
function runDir(runsDir: string, n: number, status: Status, stopReason?: StopReason): string {
  const dir = join(runsDir, runIdOf(n));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), `${JSON.stringify({ branch: branchOf(n), repository: { url: REMOTE } })}\n`);
  writeStatus(dir, status, stopReason);
  return dir;
}

/** Writes the line run `n`'s dispatch log ends with. */
function logLine(runsDir: string, n: number, line: string): void {
  const log = dispatchLog(runsDir, 'a', runIdOf(n));
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, `the run's output\n${line}\n`);
}

test("a live pid is in flight and adopted only on a first settle, completed is done, failed stopped parks at once, any other failure is a failed attempt, and no run.json is a refused start with its log's last line or its exit", async () => {
  const w = world();
  runDir(w.runsDir, 2, 'completed');
  runDir(w.runsDir, 3, 'failed', 'stopped');
  runDir(w.runsDir, 4, 'failed', 'stage_error');
  logLine(w.runsDir, 5, 'sail FAKE-5: the branch is leased by run X');
  expect([
    await reconcileItem(item(1, LIVE), w.context({ first: true })),
    await reconcileItem(item(1, LIVE), w.context()),
    await reconcileItem(item(2, DEAD), w.context()),
    await reconcileItem(item(3, DEAD), w.context()),
    await reconcileItem(item(4, DEAD), w.context()),
    await reconcileItem(item(5, DEAD), w.context({ exited: 3 })),
    await reconcileItem(item(6, DEAD), w.context({ exited: 3 })),
    await reconcileItem(item(7), w.context()),
  ]).toEqual([
    { kind: 'in-flight', adopt: true },
    { kind: 'in-flight', adopt: false },
    { kind: 'done' },
    { kind: 'park', reason: `run ${runIdOf(3)} was stopped` },
    { kind: 'failed', reason: `run ${runIdOf(4)} failed (stage_error)` },
    { kind: 'failed', reason: 'its start was refused: sail FAKE-5: the branch is leased by run X' },
    { kind: 'failed', reason: 'its start was refused: it exited 3' },
    { kind: 'failed', reason: 'its start left no run directory' },
  ]);
});

test('suspended until and budget_exceeded wait; a dead running, a suspended interrupted and a suspended unwatched run are resumed from where they were, and parked with why once this dispatcher has resumed them', async () => {
  const w = world();
  runDir(w.runsDir, 1, 'suspended', 'until');
  runDir(w.runsDir, 2, 'suspended', 'budget_exceeded');
  runDir(w.runsDir, 3, 'running');
  runDir(w.runsDir, 4, 'suspended', 'interrupted');
  runDir(w.runsDir, 5, 'suspended', 'unwatched');
  logLine(
    w.runsDir,
    4,
    `sail resume: run ${runIdOf(4)}'s workspace can't be reopened: the workspace is gone (invalid)`,
  );
  expect([
    await reconcileItem(item(1, DEAD), w.context()),
    await reconcileItem(item(2, DEAD), w.context()),
    await reconcileItem(item(3, DEAD), w.context()),
    await reconcileItem(item(4, DEAD), w.context()),
    await reconcileItem(item(5, DEAD), w.context()),
    await reconcileItem(item(4, DEAD), w.context({ resumed: true, exited: 3 })),
    await reconcileItem(item(5, DEAD), w.context({ resumed: true, exited: 1 })),
  ]).toEqual([
    { kind: 'wait' },
    { kind: 'wait' },
    { kind: 'resume', from: { status: 'running' } },
    { kind: 'resume', from: { status: 'suspended', stopReason: 'interrupted' } },
    { kind: 'resume', from: { status: 'suspended', stopReason: 'unwatched' } },
    {
      kind: 'park',
      reason: `its resume failed: sail resume: run ${runIdOf(4)}'s workspace can't be reopened: the workspace is gone (invalid)`,
    },
    { kind: 'park', reason: 'its resume failed: it exited 1' },
  ]);
});

test("a failed resume is parked with only what it logged after logFrom: its exit, a signal, or its own line, never the run's last line", async () => {
  const w = world();
  runDir(w.runsDir, 4, 'suspended', 'interrupted');
  logLine(w.runsDir, 4, "the original run's last line");
  const log = dispatchLog(w.runsDir, 'a', runIdOf(4));
  const logFrom = Buffer.byteLength(readFileSync(log, 'utf8'));
  const silent = [
    await reconcileItem(item(4, DEAD), w.context({ resumed: true, exited: 1, logFrom })),
    await reconcileItem(item(4, DEAD), w.context({ resumed: true, exited: null, logFrom })),
  ];
  appendFileSync(log, 'sail resume: it fell over\n');
  const loud = await reconcileItem(item(4, DEAD), w.context({ resumed: true, exited: 1, logFrom }));
  expect([...silent, loud]).toEqual([
    { kind: 'park', reason: 'its resume failed: it exited 1' },
    { kind: 'park', reason: 'its resume failed: it was ended by a signal' },
    { kind: 'park', reason: 'its resume failed: sail resume: it fell over' },
  ]);
});

test("a dead pid whose run's lease a live process holds is adopted under that process's pid, and a lease whose pid is dead is no reason not to resume", async () => {
  const w = world();
  runDir(w.runsDir, 1, 'running');
  runDir(w.runsDir, 2, 'suspended', 'interrupted');
  for (const [n, pid] of [
    [1, process.pid],
    [2, DEAD],
  ] as const) {
    const leased = takeLease(w.leases, REMOTE, branchOf(n), {
      runId: runIdOf(n),
      runDir: join(w.runsDir, runIdOf(n)),
      pid,
    });
    expect(leased.leased).toBe(true);
  }
  expect([await reconcileItem(item(1, DEAD), w.context()), await reconcileItem(item(2, DEAD), w.context())]).toEqual([
    { kind: 'adopt', pid: process.pid },
    { kind: 'resume', from: { status: 'suspended', stopReason: 'interrupted' } },
  ]);
});

/** Writes run `n`'s events.ndjson with one `run:suspended` on the usage limit, at `ts`, with the reset time if any. */
function limitedAt(runsDir: string, n: number, ts: string, resetsAt?: string): void {
  const event = {
    seq: 1,
    ts,
    runId: runIdOf(n),
    type: 'run:suspended',
    stopReason: 'usage_limit',
    key: 'spec#1',
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
  writeFileSync(join(runsDir, runIdOf(n), 'events.ndjson'), `${JSON.stringify(event)}\n`);
}

test('a suspended usage_limit run is held until its reset time, or the back-off after it hit the limit, and is resumed once that has passed, even by a dispatcher that resumed it before', async () => {
  const w = world();
  runDir(w.runsDir, 1, 'suspended', 'usage_limit');
  limitedAt(w.runsDir, 1, '2026-10-28T09:50:00.000Z', '2026-10-28T14:20:00.000Z');
  runDir(w.runsDir, 2, 'suspended', 'usage_limit');
  limitedAt(w.runsDir, 2, '2026-10-28T09:50:00.000Z');
  runDir(w.runsDir, 3, 'suspended', 'usage_limit');
  const later = (minutes: number) => w.context({ now: new Date(Date.parse(NOW) + minutes * 60_000) });
  const resume: Reconciled = { kind: 'resume', from: { status: 'suspended', stopReason: 'usage_limit' } };
  expect([
    await reconcileItem(item(1, DEAD), w.context()),
    await reconcileItem(item(2, DEAD), w.context()),
    await reconcileItem(item(3, DEAD), w.context()),
    await reconcileItem(item(2, DEAD), later(5)),
    await reconcileItem(item(2, DEAD), { ...later(6), resumed: true }),
    await reconcileItem(item(1, DEAD), later(260)),
    await reconcileItem(item(1, DEAD), { ...later(260), resumed: true }),
  ]).toEqual([
    { kind: 'held', until: '2026-10-28T14:20:00.000Z', reason: 'spec#1 hit the usage limit' },
    { kind: 'held', until: '2026-10-28T10:05:00.000Z', reason: 'spec#1 hit the usage limit' },
    { kind: 'held', until: '2026-10-28T10:15:00.000Z', reason: 'a run hit the usage limit' },
    resume,
    resume,
    resume,
    resume,
  ]);
});

test('a suspended usage_limit run whose lease a live process holds is adopted, not held or resumed', async () => {
  const w = world();
  runDir(w.runsDir, 1, 'suspended', 'usage_limit');
  limitedAt(w.runsDir, 1, '2026-10-28T09:50:00.000Z', '2026-10-28T14:20:00.000Z');
  takeLease(w.leases, REMOTE, branchOf(1), {
    runId: runIdOf(1),
    runDir: join(w.runsDir, runIdOf(1)),
    pid: process.pid,
  });
  expect(await reconcileItem(item(1, DEAD), w.context())).toEqual({ kind: 'adopt', pid: process.pid });
});

test('a suspended usage_limit run this dispatcher resumed, and which hit no limit since, is parked with why its resume failed; one that hit the limit again after the resume is held again', async () => {
  const w = world();
  runDir(w.runsDir, 1, 'suspended', 'usage_limit');
  limitedAt(w.runsDir, 1, '2026-10-28T09:00:00.000Z', '2026-10-28T09:30:00.000Z');
  logLine(w.runsDir, 1, 'sail resume: LINEAR_API_KEY is not set');
  runDir(w.runsDir, 2, 'suspended', 'usage_limit');
  limitedAt(w.runsDir, 2, '2026-10-28T09:55:00.000Z', '2026-10-28T14:20:00.000Z');
  const resumedAt = new Date('2026-10-28T09:40:00.000Z');
  expect([
    await reconcileItem(item(1, DEAD), w.context({ resumed: true, resumedAt, exited: 3 })),
    await reconcileItem(item(2, DEAD), w.context({ resumed: true, resumedAt })),
  ]).toEqual([
    { kind: 'park', reason: 'its resume failed: sail resume: LINEAR_API_KEY is not set' },
    { kind: 'held', until: '2026-10-28T14:20:00.000Z', reason: 'spec#1 hit the usage limit' },
  ]);
});
