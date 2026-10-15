// What the watcher's tests share: watched copies of the stub workflow and the tickets they poll, written into a test's
// temp repository, and a fake spawner that stands in for a dispatched run's process.
//
// The spawner hands out pids from 900000 up, which no real process has, and counts a pid alive until the test ends its
// run. A run it is given a TicketSource for claims its ticket as a dispatched `sail <ticket>` would, through
// `claimSource()`. The test then ends it: with a run directory and a STATUS, or refused, with only a dispatch log.
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isAlive as processIsAlive } from '../../src/adapters/leases';
import { type Status, type StopReason, writeStatus } from '../../src/engine/run-dir';
import { claimSource } from '../../src/engine/source';
import type { TicketSource } from '../../src/ports/ticket-source';
import { dispatchLog, type SpawnedRun, type SpawnRunOptions } from '../../src/watch/spawn';
import { edit } from './fixture';

/** One ticket of the fake TicketSource: Todo with the title `Ticket <key>` unless it says otherwise. */
export interface SeedTicket {
  key: string;
  labels: string[];
  title?: string;
  state?: { type: string; name: string };
}

/** Replaces the fake TicketSource's seed in `sail` with `tickets`. */
export function writeTickets(sail: string, tickets: readonly SeedTicket[]): void {
  const world = {
    tickets: tickets.map((ticket) => ({
      ticketKey: ticket.key,
      title: ticket.title ?? `Ticket ${ticket.key}`,
      description: `What ${ticket.key} asks for.`,
      state: ticket.state ?? { type: 'unstarted', name: 'Todo' },
      labels: ticket.labels,
      comments: [],
      links: [],
      attachments: [],
    })),
  };
  writeFileSync(join(sail, 'fake', 'tickets.json'), `${JSON.stringify(world, null, 2)}\n`);
}

const STUB_WORKFLOW = "workflow('ticket-to-pr', { intake: ticket, version: 1 }";

/**
 * Adds workflow `name` to a stub `.sail/` (from `writeStub()`): a copy of its `ticket-to-pr`, watched on `label` every
 * `every`, with at most `cap` runs at once.
 */
export function writeWatched(sail: string, name: string, watch: { label: string; cap: number; every?: string }): void {
  const from = join(sail, 'workflows', 'ticket-to-pr');
  cpSync(from, join(sail, 'workflows', name), { recursive: true });
  const every = watch.every ?? '30s';
  edit(
    sail,
    join('workflows', name, 'workflow.ts'),
    STUB_WORKFLOW,
    `workflow('${name}', { intake: ticket, version: 1, watch: { every: '${every}', label: '${watch.label}' }, maxConcurrentRuns: ${watch.cap} }`,
  );
}

/** The first pid the spawner hands out. */
export const FAKE_PID = 900_000;

/** A run the fake spawner started. */
export interface FakeRun extends Pick<SpawnRunOptions, 'workflow' | 'ticketKey' | 'runId'> {
  pid: number;
  /** Its claim, when the spawner claims. */
  claimed: Promise<unknown>;
}

/** How a run ends: with a run directory and STATUS, or refused before it made one, with a line in its dispatch log. */
export type Ending = { status: Status; stopReason?: StopReason } | { refused: string; code?: number } | { gone: true };

export interface FakeSpawner {
  spawn(options: SpawnRunOptions): SpawnedRun;
  isAlive(pid: number): boolean;
  /** Every run started, in order. */
  readonly runs: FakeRun[];
  /** The most runs of each workflow alive at once. */
  readonly peak: Record<string, number>;
  /** The latest run of `ticketKey`. */
  run(ticketKey: string): FakeRun;
  /** Ends the latest run of `ticketKey`: its process exits once its run directory reads as `ending` says. */
  end(ticketKey: string, ending?: Ending): Promise<void>;
  /** Waits for every claim the runs made. */
  claims(): Promise<void>;
}

export function fakeSpawner(runsDir: string, ticketSource?: TicketSource): FakeSpawner {
  const runs: FakeRun[] = [];
  const live = new Set<number>();
  const exits = new Map<number, (code: number | null) => void>();
  const peak: Record<string, number> = {};
  let next = FAKE_PID;
  const run = (ticketKey: string): FakeRun => {
    const found = runs.findLast((each) => each.ticketKey === ticketKey);
    if (found === undefined) throw new Error(`no run of ${ticketKey} was spawned`);
    return found;
  };
  return {
    runs,
    peak,
    spawn(options) {
      const pid = next++;
      live.add(pid);
      const exited = new Promise<number | null>((resolve) => exits.set(pid, resolve));
      const { workflow, ticketKey, runId } = options;
      const claimed = ticketSource === undefined ? Promise.resolve() : claimSource({ ticketKey, runId, ticketSource });
      runs.push({ workflow, ticketKey, runId, pid, claimed });
      const alive = runs.filter((each) => each.workflow === workflow && live.has(each.pid)).length;
      peak[workflow] = Math.max(peak[workflow] ?? 0, alive);
      return { pid, exited };
    },
    isAlive: (pid) => live.has(pid) || (pid < FAKE_PID && processIsAlive(pid)),
    run,
    async end(ticketKey, ending = { status: 'completed' }) {
      const ended = run(ticketKey);
      await ended.claimed;
      let code: number | null = 0;
      if ('status' in ending) {
        const dir = join(runsDir, ended.runId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'run.json'), '{}\n');
        writeStatus(dir, ending.status, ending.stopReason);
        code = ending.status === 'completed' ? 0 : 1;
      } else if ('refused' in ending) {
        const log = dispatchLog(runsDir, ended.workflow, ended.runId);
        mkdirSync(dirname(log), { recursive: true });
        writeFileSync(log, `${ending.refused}\n`);
        code = ending.code ?? 3;
      } else {
        code = null;
      }
      live.delete(ended.pid);
      exits.get(ended.pid)?.(code);
    },
    async claims() {
      await Promise.all(runs.map((each) => each.claimed));
    },
  };
}
