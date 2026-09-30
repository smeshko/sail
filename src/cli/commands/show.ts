// `sail show <run> [--events|--follow|--rebuild] [-q|-v|-vv]`: shows a run of the repository sail is run from, found by
// its id or a prefix only it starts with. It folds the run's events in memory rather than reading `summary.json`, so it
// shows a run that has none and is never staler than its events. `--rebuild` is the one flag that writes: it rewrites
// `summary.json` from the events first. It reads only `.sail-runs/`, never `project.yaml`, and exits 0 whenever it
// could show the run, a failed one too.
//
// `--events` prints the run's events through the terminal view `sail run` printed them with, at the verbosity `-q` and
// `-v` ask for, so it prints what the run printed. `--follow` does the same, then prints each event appended until the
// run ends or Ctrl-C stops it, so `--events --follow` is `--follow`.
import { resolveRun } from '../../engine/runs';
import { findSailDir } from '../../engine/sail-dir';
import { readEventsFrom } from '../../events/consumers/ndjson';
import { rebuildSummary } from '../../events/consumers/summary';
import type { Verbosity } from '../../events/consumers/terminal';
import { followEvents } from '../../events/follow';
import { type Summary, summarize } from '../../events/summary';
import type { SailEvent } from '../../events/types';
import { EXIT_OK, type ExitCode } from '../exit-codes';
import { count, formatDuration, formatUsd, table } from '../format';
import type { Io, Parsed } from '../index';
import { at, interruptibly, refuseAs, terminalFor, verbosityOf } from './run-workflow';

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

/**
 * The run's events through the terminal view: those written so far, or with `follow` each one appended too, until the
 * run ends or Ctrl-C stops it. A line that can't be read refuses.
 */
async function printEvents(
  io: Io,
  sailDir: string,
  runDir: string,
  verbosity: Verbosity,
  follow: boolean,
): Promise<{ refused: string } | undefined> {
  const terminal = terminalFor(io, sailDir, verbosity);
  const onEvent = (event: SailEvent) => terminal.onEvent(event);
  try {
    if (follow) {
      const ended = await interruptibly(io, (signal) => followEvents(runDir, { onEvent, signal }));
      return typeof ended === 'string' ? undefined : ended;
    }
    const read = readEventsFrom(runDir);
    if ('refused' in read) return read;
    for (const event of read.events) onEvent(event);
    return undefined;
  } finally {
    // However it ends, so neither the live line nor its timer outlives the command.
    terminal.close();
  }
}

export async function show(args: Parsed, io: Io): Promise<ExitCode> {
  const refuse = refuseAs(io, COMMAND);
  const [name] = args.positionals;
  if (name === undefined) return refuse('usage: sail show <run> [--events|--follow|--rebuild] [-q|-v|-vv]');
  const { events: replay, follow, rebuild, quiet, verbose } = args.values;
  const streamed = replay === true || follow === true;
  if (rebuild === true && streamed) {
    return refuse(`--rebuild shows the table, so it can't be given with --${replay === true ? 'events' : 'follow'}`);
  }
  // The table has no verbosity.
  if (!streamed && (quiet !== undefined || verbose !== undefined)) {
    return refuse('-q and -v apply to --events and --follow');
  }
  const verbosity = verbosityOf(args, io, COMMAND);
  if (typeof verbosity === 'number') return verbosity;
  const found = findSailDir(io.cwd);
  if ('refused' in found) return refuse(found.refused);
  const run = resolveRun(found.dir, name);
  if ('refused' in run) return refuse(run.refused);

  if (streamed) {
    const printed = await printEvents(io, found.dir, run.dir, verbosity, follow === true);
    return printed === undefined ? EXIT_OK : refuse(printed.refused);
  }
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
