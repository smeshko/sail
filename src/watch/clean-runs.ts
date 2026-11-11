// The per-run loop of `sail clean`, shared with the dashboard's server: for each failed run it resolves the ticket source
// for a ticket run, finds the queue item that names the run, refuses it unless `settle` says what to do with it, checks
// the watcher and the command, cleans the run (the engine's `cleanRun()`), resets its ticket and then settles the item
// through a command file. It prints nothing: each run's lines come back tagged `said`, `warned` or `waiting`, with the
// problem that ended it, if any, so the CLI and the dashboard each say them in their own way, in the same words.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BUILTINS } from '../adapters/index';
import { resolveAdapters } from '../engine/adapters';
import { cleanedMessage, cleanRun, resetTicket } from '../engine/clean';
import type { ProjectConfig } from '../engine/config';
import { runsDir } from '../engine/run-dir';
import { readRunHeader } from '../engine/run-header';
import { formatIssue } from '../engine/schemas';
import type { CodeHost } from '../ports/code-host';
import { PortError } from '../ports/errors';
import type { TicketSource } from '../ports/ticket-source';
import type { WorkspacePort } from '../ports/workspace';
import { dropCommand, NOT_TAKEN, type Command as WatcherCommand } from './inbox';
import { commandFor, itemLine, outcomeOf, streamMark } from './queue-commands';
import { type QueueItem, queueItemsNaming } from './queue-store';
import { type Holder, liveSet, liveWatcher, type RegistryEntry } from './registry';
import { holderRefusal } from './watcher';

export type WatcherLocator = () => Promise<{ name: string; holder: Holder | undefined }>;

/** The locator of a registered repository: its live watcher, `here` when it watches the entry's own `.sail/`. */
export function locateRegistered(entry: RegistryEntry, isAlive?: (pid: number) => boolean): WatcherLocator {
  return async () => {
    const watcher = liveWatcher(entry, isAlive);
    if (watcher === undefined) return { name: entry.name, holder: undefined };
    const kind = watcher.sailDir === entry.sailDir ? 'here' : 'name';
    return { name: entry.name, holder: { kind, entry, watcher } };
  };
}

/** The live watcher of this repository that watches a workflow, and the label it polls it on. */
export interface Watching {
  pid: number;
  label: string;
}

/** The live watcher of the repository that watches `workflow`, or why there is none. */
export async function watcherOf(
  sailDir: string,
  workflow: string,
  located: { name: string; holder: Holder | undefined },
): Promise<Watching | { refused: string }> {
  const { name, holder } = located;
  if (holder?.kind === 'name') return { refused: holderRefusal(holder, name) };
  if (holder?.kind !== 'here') {
    return { refused: `no watcher is running for '${name}' here: sail watch ${workflow} first` };
  }
  const { pid } = holder.watcher;
  const watched = liveSet(sailDir, pid).find((each) => each.workflow === workflow);
  if (watched === undefined) {
    return { refused: `the watcher of '${name}' (pid ${pid}) does not watch '${workflow}'` };
  }
  return { pid, label: watched.label };
}

export interface CleanLine {
  kind: 'said' | 'warned' | 'waiting';
  text: string;
}

export interface CleanedRun {
  runId: string;
  /** Set once the run was cleaned and archived, whatever came after. */
  cleaned?: { removed: string[]; archived: string };
  problem?: 'refused' | 'failed';
  lines: CleanLine[];
}

export interface CleanRunsOptions {
  sailDir: string;
  config: ProjectConfig;
  workspace: WorkspacePort;
  /** The code host, asked for only when a run's branch is on the remote. */
  codeHost: () => Promise<CodeHost | { refused: string }>;
  /** The ticket source, asked for only for a ticket run. */
  ticketSource: () => Promise<TicketSource | { refused: string }>;
  env: Readonly<Record<string, string | undefined>>;
  runIds: string[];
  /** What to do with the queue item that names a run. Unset: a run an item names is refused. */
  settle?: 'requeue' | 'drop';
  locate: WatcherLocator;
  /** Whether the watcher took a command file. */
  taken: (file: string) => Promise<boolean>;
  showPath: (file: string) => string;
  /** Each line as it is produced. */
  onLine?: (runId: string, line: CleanLine) => void;
}

/** The ticket source and code host of a repository, each resolved on first use. */
export function lazyPorts(
  options: Pick<CleanRunsOptions, 'sailDir' | 'config' | 'env'>,
): Pick<CleanRunsOptions, 'codeHost' | 'ticketSource'> {
  const lazy = <T>(port: 'codeHost' | 'ticketSource'): (() => Promise<T | { refused: string }>) => {
    let held: Promise<T | { refused: string }> | undefined;
    return () => {
      held ??= (async () => {
        const resolved = await resolveAdapters({
          sailDir: options.sailDir,
          config: options.config,
          builtins: BUILTINS,
          env: options.env,
          ports: [port],
        });
        if ('issues' in resolved) return { refused: resolved.issues.map((issue) => formatIssue(issue)).join('; ') };
        return resolved.ports[port] as T;
      })();
      return held;
    };
  };
  return { codeHost: lazy<CodeHost>('codeHost'), ticketSource: lazy<TicketSource>('ticketSource') };
}

/** The queue item a clean settles after it, and the command that settles it. */
interface Settle {
  item: QueueItem;
  workflow: string;
  watching: Watching;
  command: WatcherCommand;
  key: string;
}

export async function cleanRuns(options: CleanRunsOptions): Promise<CleanedRun[]> {
  const { sailDir, config, workspace, codeHost, ticketSource, env, runIds, locate } = options;
  const settleAs = options.settle;
  const runs = runsDir(sailDir);
  const home = env.HOME ?? homedir();
  const op = settleAs === 'drop' ? 'drop' : 'requeue';

  const isTicketRun = (runId: string): boolean => {
    try {
      return readRunHeader(join(runs, runId)).source.kind === 'ticket';
    } catch {
      return false;
    }
  };
  const removeLabel = async (ticketKey: string, label: string): Promise<string | undefined> => {
    const resolved = await ticketSource();
    const failure = `the label ${label} was not removed from ${ticketKey}`;
    if ('refused' in resolved) return `${failure}: ${resolved.refused}`;
    try {
      await resolved.removeLabel(ticketKey, label);
      return undefined;
    } catch (error) {
      if (!(error instanceof PortError)) throw error;
      return `${failure}: ${error.message}`;
    }
  };
  let found: ReturnType<WatcherLocator> | undefined;
  const watching = async (workflow: string): Promise<Watching | { refused: string }> => {
    found ??= locate();
    return watcherOf(sailDir, workflow, await found);
  };

  const results: CleanedRun[] = [];
  for (const runId of runIds) {
    const result: CleanedRun = { runId, lines: [] };
    results.push(result);
    const line = (kind: CleanLine['kind'], text: string): void => {
      const each = { kind, text };
      result.lines.push(each);
      options.onLine?.(runId, each);
    };
    const say = (text: string): void => line('said', text);
    const warn = (text: string): void => line('warned', text);
    const refuse = (text: string): void => {
      warn(text);
      result.problem = 'refused';
    };
    const failed = (): void => {
      if (result.problem !== 'refused') result.problem = 'failed';
    };

    let source: TicketSource | undefined;
    if (isTicketRun(runId)) {
      const resolved = await ticketSource();
      if ('refused' in resolved) {
        refuse(`run ${runId}: its ticket can't be reset: ${resolved.refused}`);
        continue;
      }
      source = resolved;
    }

    const naming = queueItemsNaming(runs, runId);
    const named = 'refused' in naming ? undefined : naming[0];
    let settle: Settle | undefined;
    if (named !== undefined) {
      const { item, workflow } = named;
      if (settleAs === undefined) {
        refuse(
          `queue item ${item.dedupKey} of ${workflow} (${item.state}) names run ${runId}: clean it with --requeue or --drop, or \`sail queue requeue|drop\``,
        );
        continue;
      }
      const watcher = await watching(workflow);
      if ('refused' in watcher) {
        refuse(`run ${runId}: ${watcher.refused}`);
        continue;
      }
      const checked = await commandFor(op, {
        runs,
        sailDir,
        config,
        workflow,
        label: watcher.label,
        ref: item.dedupKey,
      });
      if ('refused' in checked) {
        refuse(`run ${runId}: ${checked.refused}`);
        continue;
      }
      settle = { item, workflow, watching: watcher, command: checked.command, key: checked.key ?? item.dedupKey };
    }

    const settling = settle;
    const cleaned = await cleanRun({
      sailDir,
      runId,
      workspace,
      queueItems: (id) => {
        const items = queueItemsNaming(runs, id);
        if ('refused' in items || settling === undefined) return items;
        return items.filter(
          (each) => !(each.workflow === settling.workflow && each.item.dedupKey === settling.item.dedupKey),
        );
      },
      codeHost,
      env,
    });
    if ('refused' in cleaned) {
      refuse(cleaned.refused);
      continue;
    }
    if ('failed' in cleaned) {
      for (const failure of cleaned.failed.failures) warn(`${runId}: ${failure}`);
      warn(`${runId}: its run directory stays at .sail-runs/${runId}; clean it again`);
      failed();
      continue;
    }
    result.cleaned = { removed: cleaned.cleaned.removed, archived: cleaned.cleaned.archived };
    say(`${cleanedMessage(runId, cleaned.cleaned, home)}`);

    let ready = true;
    if (source !== undefined) {
      const reset = await resetTicket({ ticketSource: source, source: cleaned.cleaned.source, runId, runsDir: runs });
      if ('reset' in reset) say(`reset ${reset.reset.ticketKey} to ${reset.reset.state.name}`);
      else if ('failed' in reset) {
        const key = cleaned.cleaned.source.kind === 'ticket' ? cleaned.cleaned.source.ticketKey : runId;
        warn(`${runId}: its ticket ${key} was not reset: ${reset.failed}`);
        failed();
        ready = false;
      }
    }
    if (settling === undefined) continue;
    const { item, workflow, watching: watcher } = settling;
    const unsettled = (): void =>
      warn(
        `${runId}: queue item ${item.dedupKey} of ${workflow} still names it: settle it with \`sail queue ${op} ${workflow} ${item.dedupKey}\``,
      );
    if (!ready) {
      unsettled();
      continue;
    }

    if (op === 'drop' && item.source.kind === 'ticket') {
      const problem = await removeLabel(item.source.ticketKey, watcher.label);
      if (problem !== undefined) {
        warn(`${runId}: ${problem}`);
        unsettled();
        failed();
        continue;
      }
    }
    const mark = streamMark(runs, workflow);
    const file = dropCommand(runs, settling.command);
    if (!(await options.taken(file))) {
      line(
        'waiting',
        `the watcher of '${workflow}' (pid ${watcher.pid}) ${NOT_TAKEN}: it waits in ${options.showPath(file)}`,
      );
      continue;
    }
    const outcome = outcomeOf(runs, workflow, op, settling.key, mark);
    if ('refused' in outcome) refuse(outcome.refused);
    else if (outcome.applied === undefined) say(`${settling.key} dropped`);
    else say(`requeued ${itemLine(outcome.applied)}`);
  }
  return results;
}
