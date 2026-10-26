// Polling: each watched workflow's designated tickets, or designated pull requests, on a timer of its own, into its
// queue. A workflow polls the one kind its intake accepts: tickets through the TicketSource, pull requests through the
// CodeHost, one queue item per pull request and head sha (14.2's D9).
//
// - A provider that refuses the credentials (401 or 403) pauses that workflow's timed polls instead of retrying them:
//   retrying would only hammer the provider. A `poll` command or a watcher restart tries again, and a poll that succeeds
//   clears the pause (DECISIONS D8). Any other failure backs off, never more often than `every`.
// - The answer is checked and filtered again: a repository's own adapter is untrusted code, so one that over-answers
//   still can't queue a started or undesignated ticket (D10), or a draft, closed or unlabelled pull request.
// - One poll at a time per workflow: a poll asked for while one is in flight joins it (D11).
// - A poll that throws, as a queue write on a full disk does, is retried at the backoff all the same. `pollNow` rejects
//   with it, and a poll nobody awaits (a timer's, a command's, the start's) hands it to `onError`, never to an unhandled
//   rejection, which would end the watcher.
import { z } from 'zod';
import type { ProjectConfig } from '../engine/config';
import { loadWorkflow } from '../engine/load-workflow';
import { runsDir } from '../engine/run-dir';
import { parseEvery, pollKind, watchLabel, watchProblem } from '../engine/watchable';
import type { QueueEvent } from '../events/types';
import type { CodeHost } from '../ports/code-host';
import { PortError } from '../ports/errors';
import { holdsLabel } from '../ports/labels';
import type { TicketSource } from '../ports/ticket-source';
import { PullRequest, Ticket } from '../ports/types';
import type { SourceKind } from '../sdk/intake';
import type { Command } from './inbox';
import { DEFAULT_QUEUE_POLICY, openQueue, type QueuePolicy, type QueueStore } from './queue-store';

/**
 * What a watched workflow declares: the kind of source it polls, the label it polls for, how often, and how many of its
 * runs may run at once.
 */
export interface WatchDeclaration {
  workflow: string;
  /** Tickets through the TicketSource, or pull requests through the CodeHost: the one its intake accepts. */
  kind: SourceKind;
  label: string;
  everyMs: number;
  maxConcurrentRuns: number;
}

/** One watched workflow, ready to poll. */
export interface WatchTarget extends WatchDeclaration {
  ticketSource: TicketSource;
  codeHost: CodeHost;
  store: QueueStore;
}

export interface ReadWatchOptions {
  sailDir: string;
  config: Pick<ProjectConfig, 'label'>;
  /** The workflow's name. */
  name: string;
}

/** Loads workflow `name` and reads its watch declaration. A workflow that won't load, or isn't watched, refuses. */
export async function readWatch(options: ReadWatchOptions): Promise<WatchDeclaration | { refused: string }> {
  const { sailDir, name } = options;
  const loaded = await loadWorkflow(sailDir, name);
  if ('refused' in loaded) return loaded;
  const { workflow } = loaded;
  if (workflow.watch === undefined) return { refused: `workflow '${name}' isn't watched: it declares no watch` };
  const everyMs = parseEvery(workflow.watch.every);
  const problem = watchProblem(workflow);
  const { maxConcurrentRuns } = workflow;
  if (problem !== undefined || everyMs === undefined || maxConcurrentRuns === undefined) {
    return { refused: `workflow '${name}' ${problem}` };
  }
  const kind = pollKind(workflow);
  return { workflow: name, kind, label: watchLabel(workflow, options.config), everyMs, maxConcurrentRuns };
}

export interface OpenWatchTargetOptions extends ReadWatchOptions {
  ticketSource: TicketSource;
  codeHost: CodeHost;
  now: () => Date;
  policy?: QueuePolicy;
  /** Hears each event the workflow's queue emits. */
  onEvent?: (event: QueueEvent) => void;
}

/** Loads workflow `name` and opens its queue. A workflow that won't load, or isn't watched, refuses. */
export async function openWatchTarget(options: OpenWatchTargetOptions): Promise<WatchTarget | { refused: string }> {
  const watch = await readWatch(options);
  if ('refused' in watch) return watch;
  const { now, policy, onEvent } = options;
  const store = openQueue({
    runsDir: runsDir(options.sailDir),
    workflow: watch.workflow,
    label: watch.label,
    now,
    ...(policy ? { policy } : {}),
    ...(onEvent ? { onEvent } : {}),
  });
  if ('refused' in store) return store;
  return { ...watch, ticketSource: options.ticketSource, codeHost: options.codeHost, store };
}

/** How a poll went. `dropped`: its poller was dropped while it waited for the provider, so its answer went unrecorded. */
export type PollOutcome = 'polled' | 'failed' | 'paused' | 'dropped';

const PAUSING: readonly string[] = ['unauthorized', 'forbidden'];

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The wait before the next poll after `failures` polls in a row failed: the backoff, never shorter than `every`. */
function retryInMs(target: Pick<WatchTarget, 'everyMs'>, failures: number, policy: QueuePolicy): number {
  const backoff = policy.pollBackoffMs;
  return Math.max(target.everyMs, backoff[Math.min(Math.max(0, failures - 1), backoff.length - 1)] ?? 0);
}

/** A ticket the queue can hold: one with a key, which its dedup key and queue.json need. */
const Answer = z.array(Ticket.extend({ ticketKey: z.string().min(1) }));

/** The tickets `listDesignated` answered, checked: an answer that isn't a list of tickets is a PortError. */
async function listDesignated(target: WatchTarget): Promise<Ticket[]> {
  const answer: unknown = await target.ticketSource.listDesignated(target.label);
  const parsed = Answer.safeParse(answer);
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  const where = [issue?.path.join('.'), issue?.message].filter(Boolean).join(' ');
  throw new PortError('ticketSource', 'listDesignated', 'invalid', `the answer is not a list of tickets: ${where}`);
}

/** The pull requests `listDesignated` answered, checked: an answer that isn't a list of them is a PortError. */
async function listPullRequests(target: WatchTarget): Promise<PullRequest[]> {
  const answer: unknown = await target.codeHost.listDesignated(target.label);
  const parsed = z.array(PullRequest).safeParse(answer);
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  const where = [issue?.path.join('.'), issue?.message].filter(Boolean).join(' ');
  throw new PortError('codeHost', 'listDesignated', 'invalid', `the answer is not a list of pull requests: ${where}`);
}

/**
 * Lists `target`'s designated sources, filters them again, and queues them: how many were found, and how many queued.
 * A designated pull request is open, no draft, and carries the label, whatever its case.
 */
async function pollSources(target: WatchTarget): Promise<() => { found: number; added: number }> {
  if (target.kind === 'pr') {
    const answered = await listPullRequests(target);
    return () => {
      const prs = answered.filter((pr) => pr.state === 'open' && !pr.draft && holdsLabel(pr.labels, target.label));
      return { found: prs.length, added: target.store.addPullRequests(prs) };
    };
  }
  const answered = await listDesignated(target);
  return () => {
    const { ticketSource, label } = target;
    const tickets = answered.filter(
      (ticket) => ticketSource.isDesignated(ticket, label) && ticket.state.type === 'unstarted',
    );
    return { found: tickets.length, added: target.store.add(tickets) };
  };
}

/**
 * Polls `target` once into its queue, and says how it went. When `dropped` says so once the provider has answered,
 * nothing is recorded: the queue store is no longer this poll's to write.
 */
export async function pollOnce(
  target: WatchTarget,
  now: () => Date,
  policy: QueuePolicy = DEFAULT_QUEUE_POLICY,
  dropped?: () => boolean,
): Promise<PollOutcome> {
  const started = now().getTime();
  let queue: () => { found: number; added: number };
  try {
    queue = await pollSources(target);
  } catch (error) {
    if (dropped?.()) return 'dropped';
    const code = error instanceof PortError ? error.code : undefined;
    const port = target.kind === 'pr' ? ('codeHost' as const) : ('ticketSource' as const);
    const failure = {
      port,
      adapter: target.kind === 'pr' ? target.codeHost.name : target.ticketSource.name,
      ...(code === undefined ? {} : { code }),
      message: messageOf(error),
    };
    if (code !== undefined && PAUSING.includes(code)) {
      target.store.pollFailed({ ...failure, paused: true });
      return 'paused';
    }
    const failures = target.store.snapshot().polling.failures + 1;
    target.store.pollFailed({ ...failure, paused: false, retryInMs: retryInMs(target, failures, policy) });
    return 'failed';
  }
  if (dropped?.()) return 'dropped';
  const { found, added } = queue();
  target.store.polled({
    kind: target.kind,
    found,
    added,
    durationMs: Math.max(0, now().getTime() - started),
  });
  return 'polled';
}

/** How the poller waits: `setTimeout` for the watcher, a fake in tests. */
export interface Timers {
  set(fn: () => unknown, ms: number): unknown;
  clear(handle: unknown): void;
}

export const systemTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface Poller {
  /** Polls every target at once, then keeps each on its own timer. */
  start(): Promise<void>;
  /** Clears every timer. A poll in flight is still recorded, and not rescheduled. */
  stop(): void;
  /**
   * Stops for good, and a poll in flight records nothing when its answer comes: for a caller that lets the queue store
   * go, so that a store opened afresh on the same queue is the only one that writes it.
   */
  drop(): void;
  /** Polls the workflow now, paused or not, or joins its poll in flight. A workflow it doesn't poll throws. */
  pollNow(workflow: string): Promise<PollOutcome>;
  /**
   * Applies a command from the inbox: the poll starts, and a failure goes to `onError`. One for a workflow it doesn't
   * poll throws.
   */
  apply(command: Command): void;
}

export interface PollerOptions {
  targets: readonly WatchTarget[];
  timers: Timers;
  now: () => Date;
  policy?: QueuePolicy;
  /** Hears a poll nobody awaits that threw. Without it, the poller writes the error to stderr. */
  onError?: (workflow: string, error: unknown) => void;
}

export function createPoller(options: PollerOptions): Poller {
  const { targets, timers, now } = options;
  const policy = options.policy ?? DEFAULT_QUEUE_POLICY;
  const timer = new Map<string, unknown>();
  const inFlight = new Map<string, Promise<PollOutcome>>();
  let stopped = false;
  let dropped = false;

  const find = (workflow: string): WatchTarget => {
    const target = targets.find((each) => each.workflow === workflow);
    if (target === undefined) throw new Error(`not polling workflow '${workflow}'`);
    return target;
  };
  const clear = (target: WatchTarget) => {
    if (timer.has(target.workflow)) timers.clear(timer.get(target.workflow));
    timer.delete(target.workflow);
  };
  const schedule = (target: WatchTarget, outcome: PollOutcome) => {
    if (stopped || outcome === 'paused') return;
    const ms =
      outcome === 'polled' ? target.everyMs : retryInMs(target, target.store.snapshot().polling.failures, policy);
    timer.set(
      target.workflow,
      timers.set(() => unawaited(target), ms),
    );
  };
  const poll = (target: WatchTarget): Promise<PollOutcome> => {
    const running = inFlight.get(target.workflow);
    if (running !== undefined) return running;
    clear(target);
    const polling = pollOnce(target, now, policy, () => dropped).then(
      (outcome) => {
        inFlight.delete(target.workflow);
        schedule(target, outcome);
        return outcome;
      },
      (error: unknown) => {
        inFlight.delete(target.workflow);
        // The poll may have saved a pause before it threw, as when the pause's event couldn't be appended: honour it.
        schedule(target, target.store.snapshot().polling.paused === undefined ? 'failed' : 'paused');
        throw error;
      },
    );
    inFlight.set(target.workflow, polling);
    return polling;
  };
  /** Polls `target` for a caller that won't await it, and hands a failure to `onError`. */
  const unawaited = (target: WatchTarget): Promise<unknown> =>
    poll(target).catch((error: unknown) => {
      if (options.onError !== undefined) options.onError(target.workflow, error);
      else process.stderr.write(`sail: polling workflow '${target.workflow}' failed: ${messageOf(error)}\n`);
    });

  const poller: Poller = {
    async start() {
      stopped = false;
      await Promise.all(targets.map(unawaited));
    },
    stop() {
      stopped = true;
      for (const target of targets) clear(target);
    },
    drop() {
      dropped = true;
      poller.stop();
    },
    pollNow: (workflow) => poll(find(workflow)),
    apply(command) {
      if (command.op !== 'poll') throw new Error(`a poller applies poll commands, not ${command.op}`);
      void unawaited(find(command.workflow));
    },
  };
  return poller;
}
