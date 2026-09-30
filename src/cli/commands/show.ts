// `sail show <run> [--events|--follow|--rebuild]`: shows a run of the repository sail is run from, found by its id or
// a prefix only it starts with. It folds the run's events in memory rather than reading `summary.json`, so it shows a
// run that has none and is never staler than its events. `--rebuild` is the one flag that writes: it rewrites
// `summary.json` from the events first. It reads only `.sail-runs/`, never `project.yaml`, and exits 0 whenever it
// could show the run, a failed one too.
import { resolveRun } from '../../engine/runs';
import { findSailDir } from '../../engine/sail-dir';
import { readEventsFrom } from '../../events/consumers/ndjson';
import { rebuildSummary } from '../../events/consumers/summary';
import { type Summary, summarize } from '../../events/summary';
import type { SailEvent } from '../../events/types';
import { EXIT_OK, type ExitCode } from '../exit-codes';
import { count, formatDuration, formatUsd, table } from '../format';
import type { Io, Parsed } from '../index';
import { at, refuseAs } from './run-workflow';

const COMMAND = 'sail show';

/** Why the run stopped, from its last `run:end`: `sail.summary.v1` has no field for it. */
function stopMessage(events: readonly SailEvent[]): string | undefined {
  const last = events.findLast((event) => event.type === 'run:end');
  return last?.type === 'run:end' ? last.message : undefined;
}

const costOf = (usd: number | undefined) => (usd === undefined ? '' : formatUsd(usd));

/** A row per call, and one per step under its call, indented. `next` is where the workflow went from the call. */
function callRows(summary: Summary): string[][] {
  const next = (key: string) => summary.routes?.findLast((route) => route.at === key)?.took ?? '';
  return summary.calls.flatMap((call) => [
    [call.key, call.kind ?? '', call.outcome, formatDuration(call.durationMs), costOf(call.costUsd), next(call.key)],
    ...(call.steps ?? []).map((step) => [
      `  ${step.key}`,
      step.kind,
      step.outcome,
      formatDuration(step.durationMs),
      costOf(step.costUsd),
      '',
    ]),
  ]);
}

/** The run as `sail show` prints it: a title, the calls, then how the run stopped, its loops, totals and cost. */
function render(summary: Summary, message: string | undefined): string[] {
  const { stopReason, totals } = summary;
  const title = [summary.runId, summary.workflow, summary.status, stopReason, formatDuration(summary.durationMs ?? 0)]
    .filter((part) => part !== undefined)
    .join(' · ');
  const rows = callRows(summary);
  const calls =
    rows.length === 0 ? ['no calls yet'] : table([['key', 'kind', 'outcome', 'duration', 'cost', 'next'], ...rows]);
  const loops = Object.entries(summary.loops ?? {}).map(([name, loop]) => `${name} ${loop.iterations}/${loop.max}`);
  const { budget } = totals;
  const facts = [
    ...(stopReason === undefined ? [] : [['stop', message === undefined ? stopReason : `${stopReason}: ${message}`]]),
    ...(loops.length === 0 ? [] : [['loops', loops.join(', ')]]),
    [
      'totals',
      [
        count(totals.stageCalls, 'call'),
        count(totals.steps, 'step'),
        count(totals.toolCalls, 'tool call'),
        count(totals.denials, 'denial'),
        count(totals.replays, 'replay'),
      ].join(' · '),
    ],
    [
      'cost',
      `${formatUsd(totals.usage.costUsd)}${budget === undefined ? '' : ` of ${formatUsd(budget.maxUsd)} (${budget.usedPct}%)`}`,
    ],
  ];
  return [title, '', ...calls, '', ...table(facts)];
}

export function show(args: Parsed, io: Io): ExitCode {
  const refuse = refuseAs(io, COMMAND);
  const [name] = args.positionals;
  if (name === undefined) return refuse('usage: sail show <run> [--events|--follow|--rebuild]');
  const { events: replay, follow, rebuild } = args.values;
  if (rebuild === true && (replay === true || follow === true)) {
    return refuse(`--rebuild shows the table, so it can't be given with --${replay === true ? 'events' : 'follow'}`);
  }
  if (replay === true || follow === true) return refuse('--events and --follow come with the terminal renderer');
  const found = findSailDir(io.cwd);
  if ('refused' in found) return refuse(found.refused);
  const run = resolveRun(found.dir, name);
  if ('refused' in run) return refuse(run.refused);

  if (rebuild === true) {
    const rebuilt = rebuildSummary(run.dir);
    if ('refused' in rebuilt) return refuse(rebuilt.refused);
    io.stdout(`rebuilt ${at(io, rebuilt.path)}\n`);
  }
  const read = readEventsFrom(run.dir);
  if ('refused' in read) return refuse(read.refused);
  const summary = summarize(read.events);
  if (summary === undefined) return refuse(`run ${run.runId}'s events hold no run:start`);
  for (const line of render(summary, stopMessage(read.events))) io.stdout(`${line}\n`);
  return EXIT_OK;
}
