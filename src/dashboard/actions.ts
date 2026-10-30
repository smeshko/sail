// What a run offers its viewer, as the server reads it: Resume or Restart, enabled or why not. It is the one check behind
// both the actions route and each POST that starts a run, so a request is judged again as it arrives. Read-only.
//
// - A `completed` run offers neither, and says why. A `running` run offers both, disabled.
// - Resume is offered for a `suspended` run. For stop reason `budget_exceeded` it needs a raise: the budget the run
//   suspended on (its `run:suspended`), else `usd` when the cost has reached the budget's dollars, else `minutes`.
// - Restart is offered for a `failed` run, a stopped one included. It is a seeded run, so it is disabled for the runs
//   `openSeededRun` refuses, in its words: a pull-request run, a run with no workspace, a run whose intake didn't pass.
//   Its stages are those with a journaled call other than the intake, in the order they first ran, less the ones the
//   seed would refuse, each with what runs again: the whole group when its first call ran in one, every step when its
//   first call has step lines, and the loop from the iteration the call ran in. The default is the stage of the call the
//   run failed in: the last journaled call that ended `error`, `failed` or `blocked`, else the last journaled call.
// - Either is disabled while its branch is leased by another run, and while a queue item of the run's workflow names the
//   run and is dispatched, or failed and waiting to retry: the watcher has it.
import { join } from 'node:path';
import { defaultLeasesDir, heldLease } from '../adapters/leases';
import { INTAKE_KEY } from '../engine/intake';
import { type JournalEntry, readJournal } from '../engine/journal';
import { readStatus, runsDir } from '../engine/run-dir';
import { type RunHeader, readRunHeader } from '../engine/run-header';
import { noIntakeRun, notTicketRun, noWorkspaceRun, seedEnd } from '../engine/seed-run';
import { readEvents } from '../events/consumers/ndjson';
import { summarize } from '../events/summary';
import type { SailEvent } from '../events/types';
import type { RegistryEntry } from '../watch/registry';
import { findRunDir } from './files';
import { queueViews } from './queues';

export interface Offer {
  enabled: boolean;
  /** Why the action is disabled. */
  why?: string;
}

type Budget = NonNullable<RunHeader['budget']>;

export interface ResumeOffer extends Offer {
  /** Dollars the run has spent. */
  spentUsd: number;
  /** Minutes the run has used, when it was suspended on its minutes. */
  spentMinutes?: number;
  /** The budget the run has now, its raises included. */
  budget: Budget;
  /** The budget a resume must raise: a run suspended over it needs a raise to go on. */
  raise?: 'usd' | 'minutes';
}

export interface RestartOffer extends Offer {
  /** The stages a seeded run can start from, in the order they first ran. */
  stages: { stage: string; runsAgain: string }[];
  /** The stage the run failed in. */
  stage?: string;
  /** The budget the new run gets: the source's header. */
  budget: Budget;
}

export interface RunActions {
  resume?: ResumeOffer;
  restart?: RestartOffer;
  /** Why the run offers neither. */
  why?: string;
}

export interface ActionsOptions {
  /** Where branch leases are looked up. By default the fake workspace's, or the machine's. */
  leasesDir?: string | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The budget the run has now: its header's, replaced by the last `budget:raised`. */
function budgetOf(header: RunHeader, events: readonly SailEvent[]): Budget {
  let budget: Budget = { ...header.budget };
  for (const event of events) if (event.type === 'budget:raised') budget = { ...event.budget };
  return budget;
}

/** The raise a budget-suspended run needs. */
function raiseOf(events: readonly SailEvent[], spentUsd: number, budget: Budget): 'usd' | 'minutes' {
  const suspended = events.findLast((event) => event.type === 'run:suspended');
  if (suspended?.type === 'run:suspended' && suspended.stopReason === 'budget_exceeded') return suspended.budget;
  return budget.maxUsd !== undefined && spentUsd >= budget.maxUsd ? 'usd' : 'minutes';
}

/** Why another run holds the branch, or a queue item of the watcher has this run; undefined when neither does. */
function heldBy(entry: RegistryEntry, runId: string, header: RunHeader, options: ActionsOptions): string | undefined {
  const { branch, repository } = header;
  if (branch !== undefined && repository !== undefined) {
    const dir =
      options.leasesDir ??
      (header.adapters.workspace.use === 'fake'
        ? join(runsDir(entry.sailDir), 'fake', 'leases')
        : defaultLeasesDir(options.env));
    const lease = heldLease(dir, repository.url, branch);
    if (lease !== undefined && lease.runId !== runId) return `branch ${branch} is leased by run ${lease.runId}`;
  }
  for (const view of queueViews(entry)) {
    if (view.workflow !== header.workflow.name) continue;
    for (const item of view.queue?.items ?? []) {
      if (item.runId !== runId) continue;
      if (item.state === 'dispatched') return `${view.workflow}'s watcher has this run: ${item.dedupKey} is dispatched`;
      if (item.state === 'failed' && item.retryAt !== undefined) {
        return `${view.workflow}'s watcher will run ${item.dedupKey} again at ${item.retryAt}`;
      }
    }
  }
  return undefined;
}

/** The loop open when the call `key` started, as `name` and the iteration it was in. */
function loopAt(events: readonly SailEvent[], key: string): { name: string; iteration: number } | undefined {
  const open: { name: string; iteration: number }[] = [];
  for (const event of events) {
    if (event.type === 'loop:iteration') {
      const at = open.findIndex((loop) => loop.name === event.loop);
      if (at === -1) open.push({ name: event.loop, iteration: event.iteration });
      else open[at] = { name: event.loop, iteration: event.iteration };
    } else if (event.type === 'loop:exit') {
      const at = open.findIndex((loop) => loop.name === event.loop);
      if (at !== -1) open.splice(at, 1);
    } else if (event.type === 'stage:start' && event.key === key) {
      return open.at(-1);
    }
  }
  return undefined;
}

/** What runs again when a seeded run starts at `stage`: its first call, with the group, steps and loop around it. */
function runsAgain(entries: readonly JournalEntry[], events: readonly SailEvent[], stage: string): string {
  const first = entries.find((entry) => entry.stage === stage) as JournalEntry;
  const own = `${stage}#${first.call}`;
  const group = entries.find((entry) => entry.step === undefined && entry.group?.includes(own))?.group;
  const steps = entries.some((entry) => entry.stage === stage && entry.call === first.call && entry.step !== undefined);
  let what = group === undefined ? own : `the group ${group.join(', ')}`;
  if (steps) what += ', every step of it,';
  what += ' and everything after it';
  const loop = loopAt(events, own);
  return loop === undefined ? what : `${what}, in loop ${loop.name} from iteration ${loop.iteration}`;
}

function restartOf(runId: string, header: RunHeader, entries: readonly JournalEntry[], events: readonly SailEvent[]) {
  const budget: Budget = { ...header.budget };
  const { source } = header;
  const refuse = (why: string): RestartOffer => ({ enabled: false, why, stages: [], budget });
  if (source.kind !== 'ticket') return refuse(notTicketRun(runId, source.number));
  if (header.branch === undefined || header.repository === undefined) return refuse(noWorkspaceRun(runId));
  const [intake] = entries;
  if (intake?.key !== INTAKE_KEY || intake.outcome !== 'passed') return refuse(noIntakeRun(runId));
  const names = [...new Set(entries.map((entry) => entry.stage))].filter((stage) => stage !== intake.stage);
  const stages = names
    .filter((stage) => {
      const at = seedEnd(entries, stage);
      return typeof at === 'number' && at > 0;
    })
    .map((stage) => ({ stage, runsAgain: runsAgain(entries, events, stage) }));
  if (stages.length === 0) return refuse(`run ${runId} ran no stage a seeded run can start from`);
  const calls = entries.filter((entry) => entry.step === undefined);
  const failed = calls.findLast((entry) => ['error', 'failed', 'blocked'].includes(entry.outcome));
  const wanted = (failed ?? calls.at(-1))?.stage;
  const stage = stages.find((each) => each.stage === wanted)?.stage ?? stages.at(-1)?.stage;
  return { enabled: true, stages, ...(stage === undefined ? {} : { stage }), budget } satisfies RestartOffer;
}

/** What run `runId` of the repository offers: Resume or Restart, enabled or why not. */
export function runActions(entry: RegistryEntry, runId: string, options: ActionsOptions = {}): RunActions {
  const dir = findRunDir(entry, runId);
  if (typeof dir !== 'string') return { why: dir.missing };
  try {
    const { status, stopReason } = readStatus(dir);
    const header = readRunHeader(dir);
    if (status === 'completed') return { why: `run ${runId} completed: there is nothing to start again` };
    const events = readEvents(dir);
    const spentUsd = summarize(events)?.totals.usage.costUsd ?? 0;
    const budget = budgetOf(header, events);
    if (status === 'running') {
      const why = `run ${runId} is running`;
      return {
        resume: { enabled: false, why, spentUsd, budget },
        restart: { enabled: false, why, stages: [], budget: { ...header.budget } },
      };
    }
    const busy = heldBy(entry, runId, header, options);
    const disable = <T extends Offer>(offer: T): T =>
      busy === undefined ? offer : { ...offer, enabled: false, why: busy };
    if (status === 'failed') {
      const { entries } = readJournal(dir);
      const restart = restartOf(runId, header, entries, events);
      return { restart: restart.enabled ? disable(restart) : restart };
    }
    const suspended = events.findLast((event) => event.type === 'run:suspended');
    const raise = stopReason === 'budget_exceeded' ? raiseOf(events, spentUsd, budget) : undefined;
    const spentMinutes =
      raise === 'minutes' && suspended?.type === 'run:suspended' && suspended.stopReason === 'budget_exceeded'
        ? suspended.used
        : undefined;
    const resume: ResumeOffer = {
      enabled: true,
      spentUsd,
      ...(spentMinutes === undefined ? {} : { spentMinutes }),
      budget,
      ...(raise === undefined ? {} : { raise }),
    };
    return { resume: disable(resume) };
  } catch (error) {
    return { why: `run ${runId} can't be read: ${messageOf(error)}` };
  }
}
