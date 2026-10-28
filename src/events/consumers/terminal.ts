// The terminal consumer: the event stream as the terminal view, at a verbosity.
//
// A port of the prototype's terminal consumer. It keeps the verbosity gating, the colour rule (now `Io.tty`: colour and
// the live line only in an interactive terminal) and the idea of a script's output tail. It drops the boxes, the ruled
// stage headers and the clock times: every line starts with its key, in a terminal as in a pipe. It writes through the
// `write` it is given, never `process.stdout`, and its clock and timer are injected.
//
// Every event updates the state at every verbosity, so the final block is right at quiet too. What prints is gated by
// one table that mirrors the plan's level table: an event type prints its own lines from the verbosity it names.
//
// A group's calls print their lines as they come, interleaved, between a header and a closing line keyed `all`: lines
// are never held back, so `sail show --follow` prints what the run printed. While a group runs, the live line counts
// its running calls instead of naming one of them.
//
// The run's own budget events print from normal, a warning in yellow and an exceeded budget in red, and so does a raise
// (`budget-view.ts`). A step's, which carry their call's key, print only at trace. The final block has a `cost` row once
// the run has used anything, against its budget as raised. A seeded run's reused calls count apart there, as in the
// summary.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { JournalEntry } from '../../engine/journal';
import type { Consumer, EventType, SailEvent } from '../types';
import { budgetText, createBudgetView, raisedText } from './budget-view';
import { clean, createScreen, type Every, type Line, type Segment, type Style, type Tty } from './screen';

export const VERBOSITIES = ['quiet', 'normal', 'verbose', 'trace'] as const;
export type Verbosity = (typeof VERBOSITIES)[number];

const LEVEL: Record<Verbosity, number> = { quiet: 0, normal: 1, verbose: 2, trace: 3 };

/**
 * The lowest verbosity at which each type prints its own lines. Errors print at every level, apart from a timeout. Any
 * other type, a timeout included, prints only trace's generic line.
 */
const SHOWN_FROM: Partial<Record<EventType, Verbosity>> = {
  'run:start': 'quiet',
  'run:keep_awake': 'verbose',
  'intake:start': 'normal',
  'stage:start': 'normal',
  'step:start': 'normal',
  'script:exec': 'verbose',
  'input:materialised': 'verbose',
  'script:exit': 'normal',
  'output:validated': 'normal',
  'output:invalid': 'normal',
  // At verbose and above, a file's verdict is followed by its checks.
  'file:validated': 'normal',
  'file:produced': 'verbose',
  // At quiet, an end prints only when its outcome is `error`. Its tail: at normal for a script that didn't pass, at
  // verbose for every script.
  'intake:end': 'normal',
  'stage:end': 'normal',
  'step:end': 'normal',
  'step:queued': 'normal',
  'loop:iteration': 'normal',
  'loop:exit': 'normal',
  'all:start': 'normal',
  'all:end': 'normal',
  'workflow:route': 'verbose',
  'journal:append': 'trace',
  'budget:raised': 'normal',
  'run:end': 'quiet',
};

/** An error that prints at every level. A timeout's message is always in its call's errors, so it has no line below trace. */
const isReported = (type: EventType): boolean => type.startsWith('error:') && type !== 'error:timeout';

type Outcome = JournalEntry['outcome'];

/** The final block's outcome counts, in this order. */
const OUTCOMES: readonly Outcome[] = ['passed', 'done', 'failed', 'blocked', 'error'];

const END_MARKS: Record<Outcome, readonly [string, Style]> = {
  passed: ['✓', 'green'],
  done: ['✓', 'green'],
  failed: ['✗', 'yellow'],
  blocked: ['⊘', 'yellow'],
  error: ['✗', 'red'],
};

const STATUS_STYLE = { completed: 'green', failed: 'red', suspended: 'yellow' } as const;

/** The key column's width before a `run:start` names the roster. */
const DEFAULT_WIDTH = 12;

const TAIL_LINES = 10;
/** A tail reads no more than the last 64 KiB of a log. */
const TAIL_WINDOW = 64 * 1024;
const LOGS = ['stdout.log', 'stderr.log'] as const;

/** A duration as the terminal view prints it: `850ms`, `2.5s`, `1m 11s`, `2h 2m`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/** A size as the terminal view prints it: `622 B`, `1.0 KB`, `2.5 MB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = Math.round((bytes / 1024) * 10);
  if (kb < 10240) return `${(kb / 10).toFixed(1)} KB`;
  return `${(Math.round((bytes / 1048576) * 10) / 10).toFixed(1)} MB`;
}

/** `text`'s lines, cleaned and without trailing whitespace, the blank ones after the first left out. */
/** A start line's model, then the named harness it ran on: ` · <model> on <harness>`. */
function modelOn(event: { model?: string; harness?: string }): string {
  if (event.model === undefined) return '';
  return ` · ${event.model}${event.harness === undefined ? '' : ` on ${event.harness}`}`;
}

function textLines(text: string): string[] {
  const [first = '', ...more] = text.split('\n').map((line) => clean(line).trimEnd());
  return [first, ...more.filter((line) => line !== '')];
}

/** How long the live line's call has run, in whole seconds: `12s`, `1m 12s`. */
function liveElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export interface TerminalOptions {
  verbosity: Verbosity;
  write(text: string): void;
  /** Present in an interactive terminal: colour and the live line. */
  tty?: Tty;
  /** Absolute: a tail is read from `<runsDir>/<runId>/<dirname(resultPath)>/`. */
  runsDir: string;
  /** The final block's `run` row. */
  shownRunsDir: string;
  /** The run's earlier events, on a resume: they print nothing. */
  prior?: readonly SailEvent[];
  now?: () => number;
  every?: Every;
}

export interface TerminalConsumer extends Consumer {
  close(): void;
}

type EndEvent = Extract<SailEvent, { type: 'intake:end' | 'stage:end' | 'step:end' }>;
type RunEnd = Extract<SailEvent, { type: 'run:end' }>;

/** A budget event of the run's own, which carries no key: a step's carries its call's. */
const isRunBudget = (event: SailEvent): event is Extract<SailEvent, { type: 'budget:warning' | 'budget:exceeded' }> =>
  (event.type === 'budget:warning' || event.type === 'budget:exceeded') && event.key === undefined;

const isEnd = (event: SailEvent): event is EndEvent =>
  event.type === 'intake:end' || event.type === 'stage:end' || event.type === 'step:end';

/** An event without its envelope and key, as a line prints it. */
function payload(event: SailEvent): string {
  const { seq: _seq, ts: _ts, type: _type, runId: _runId, key: _key, ...rest } = event as SailEvent & { key?: unknown };
  return JSON.stringify(rest);
}

/** The last non-blank lines of a log's last 64 KiB, and whether the window cut its start; undefined when unreadable. */
function readLog(file: string): { lines: string[]; cut: boolean } | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    // The window, and the byte before it: a newline there means the window starts on a whole line.
    const from = Math.max(0, size - TAIL_WINDOW - 1);
    const buffer = Buffer.alloc(size - from);
    readSync(fd, buffer, 0, buffer.length, from);
    const lines = buffer.toString('utf8').split('\n');
    // What comes before the first newline is outside the window, or a line the window cut off at its start.
    if (from > 0) lines.shift();
    // Cleaned first, so a line of only escape codes counts as blank and no line ends in whitespace.
    const kept = lines.map((line) => clean(line).trimEnd()).filter((line) => line.trim() !== '');
    return { lines: kept, cut: from > 0 };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function terminalConsumer(options: TerminalOptions): TerminalConsumer {
  const level = LEVEL[options.verbosity];
  const screen = createScreen({
    write: options.write,
    ...(options.tty === undefined ? {} : { tty: options.tty }),
    ...(options.every === undefined ? {} : { every: options.every }),
  });
  const now = (): number => options.now?.() ?? Date.now();

  let width = DEFAULT_WIDTH;
  /** The first `run:start`'s time, or else the first event's: where the final block's duration starts. */
  let startedAt: number | undefined;
  let firstAt: number | undefined;
  /** `<name> v<version>`, from the `run:start`. */
  let workflow: string | undefined;
  const kinds = new Map<string, string>();
  const keysByResult = new Map<string, string>();
  /** The journaled calls, their steps left out. */
  const calls: { key: string; outcome: Outcome; reused: boolean }[] = [];
  const loops = new Map<string, { iteration: number; max: number }>();
  let replays = 0;
  /** The calls and steps running now, innermost last: the live line names the last. */
  let running: { key: string; since: number }[] = [];
  /** The group running now, from its `all:start` to its `all:end`: the live line counts its calls. */
  let group: { keys: string[]; since: number } | undefined;
  /** Set by `prior` until the first live event, which prints the resume line first. */
  let resuming = false;
  const budgetView = createBudgetView();

  /** The group's running calls of all its calls: `2/3`. */
  const groupCount = ({ keys }: { keys: string[] }): string =>
    `${running.filter((each) => keys.includes(each.key)).length}/${keys.length}`;
  const liveText = (): string => {
    if (group !== undefined) return `all ${groupCount(group)} running · ${liveElapsed(now() - group.since)}`;
    const top = running.at(-1);
    return top === undefined ? '' : `${top.key} running · ${liveElapsed(now() - top.since)}`;
  };
  /** What the live line shows, apart from its clock: undefined when there is none. */
  const liveShape = (): string | undefined => (group === undefined ? running.at(-1)?.key : `all ${groupCount(group)}`);

  const column = (key: string | undefined): Segment => ['dim', (key ?? '').padEnd(width)];
  /** A head line: the key column, then a marker and its text. */
  const head = (key: string | undefined, marker: Segment, ...text: Segment[]): Line => [
    column(key),
    '  ',
    marker,
    ' ',
    ...text,
  ];
  /** A detail line: indented two spaces where a head line has its marker, so the texts line up. */
  const detail = (key: string | undefined, text: string): Line => [column(key), '    ', ['dim', text]];

  /** `text`'s first line through `first`, and each later line as a detail line indented two more. */
  const message = (key: string | undefined, text: string, first: (line: string) => Line): Line[] => {
    const [line = '', ...more] = textLines(text);
    return [first(line), ...more.map((each) => detail(key, `  ${each}`))];
  };

  const source = (from: string): string =>
    from === 'workflow' ? 'the workflow' : (keysByResult.get(from.replace(/#.*$/s, '')) ?? from);

  function shows(event: SailEvent): boolean {
    if (isReported(event.type) || (isEnd(event) && event.outcome === 'error')) return true;
    if (isRunBudget(event)) return level >= LEVEL.normal;
    return level >= LEVEL[SHOWN_FROM[event.type] ?? 'trace'];
  }

  /** Keeps what later lines, the live line and the final block need. It prints nothing, so prior events run it alone. */
  function update(event: SailEvent): void {
    const at = Date.parse(event.ts);
    firstAt ??= at;
    budgetView.update(event);
    switch (event.type) {
      case 'run:start': {
        startedAt ??= at;
        workflow = `${event.workflow.name} v${event.workflow.version}`;
        // The longest key the roster allows: each call's first, and each step of a multi-step one.
        const entries = [['intake', event.roster.intake] as const, ...Object.entries(event.roster.stages)];
        const keys = entries.flatMap(([name, entry]) => [
          `${name}#1`,
          ...(entry.steps ?? []).map((step) => `${name}#1/${step.step}`),
        ]);
        width = Math.max(...keys.map((key) => key.length));
        return;
      }
      case 'intake:start':
      case 'stage:start':
      case 'step:start':
        kinds.set(event.key, event.kind);
        running.push({ key: event.key, since: now() });
        return;
      case 'intake:end':
      case 'stage:end':
      case 'step:end':
        keysByResult.set(event.resultPath, event.key);
        // A call's end ends its steps too.
        running = running.filter((each) => each.key !== event.key && !each.key.startsWith(`${event.key}/`));
        return;
      case 'journal:append':
        if (!event.key.includes('/')) {
          calls.push({ key: event.key, outcome: event.outcome, reused: event.fromRun !== undefined });
        }
        return;
      case 'all:start':
        group = { keys: [...event.keys], since: now() };
        return;
      case 'all:end':
        group = undefined;
        return;
      case 'loop:iteration': {
        const seen = loops.get(event.loop);
        if (seen === undefined || event.iteration > seen.iteration) {
          loops.set(event.loop, { iteration: event.iteration, max: event.max });
        }
        return;
      }
      case 'run:end':
        replays += event.replays;
        running = [];
        group = undefined;
        return;
      case 'error:crash':
        running = [];
        group = undefined;
        return;
    }
  }

  /** The resume's opening line: the run as the prior events left it. */
  function resumeLine(runId: string): Line {
    const last = calls.at(-1);
    const after =
      last === undefined
        ? 'resumed before its first call'
        : `resumed after ${calls.length} call${calls.length === 1 ? '' : 's'}, last ${last.key} ${last.outcome}`;
    return [`sail · ${workflow === undefined ? '' : `${workflow} · `}${runId} · ${after}`];
  }

  /** An end line, its errors, and the output tail of a script that didn't pass. */
  function endLines(event: EndEvent): Line[] {
    const [mark, style] = END_MARKS[event.outcome];
    const duration = event.type === 'stage:end' ? ` · ${formatDuration(event.durationMs)}` : '';
    const lines: Line[] = [[column(event.key), '  ', [style, `${mark} ${event.outcome}`], duration]];
    for (const error of event.type === 'stage:end' || event.type === 'step:end' ? (event.errors ?? []) : []) {
      lines.push(...message(event.key, `${error.reason}: ${error.message}`, (line) => detail(event.key, line)));
    }
    const tailed = level >= LEVEL.verbose || event.outcome === 'failed' || event.outcome === 'error';
    if (level >= LEVEL.normal && tailed && kinds.get(event.key) === 'script') {
      lines.push(...tail(event.key, join(options.runsDir, event.runId, dirname(event.resultPath))));
    }
    return lines;
  }

  /** Each log's last lines, `stdout.log` first, under a label that says when lines were left out. */
  function tail(key: string, dir: string): Line[] {
    return LOGS.flatMap((name) => {
      const log = readLog(join(dir, name));
      if (log === undefined || log.lines.length === 0) return [];
      const shown = log.lines.slice(-TAIL_LINES);
      const label = log.cut || shown.length < log.lines.length ? `${name} · last ${shown.length} lines` : name;
      return [detail(key, label), ...shown.map((line) => detail(key, `│ ${line}`))];
    });
  }

  function finalBlock(event: RunEnd): Line[] {
    const rows: [string, string][] = [];
    if (event.stopReason !== undefined) {
      const stop = event.message === undefined ? event.stopReason : `${event.stopReason}: ${event.message}`;
      // A message's later lines are rows without a label, their values indented two more.
      const [first = '', ...more] = textLines(stop);
      rows.push(['stop', first], ...more.map((line): [string, string] => ['', `  ${line}`]));
    }
    const own = calls.filter((call) => !call.reused);
    const reused = calls.length - own.length;
    const counts = OUTCOMES.flatMap((outcome) => {
      const n = own.filter((call) => call.outcome === outcome).length;
      return n === 0 ? [] : [`${n} ${outcome}`];
    });
    const reusedText = reused > 0 ? ` · ${reused} reused` : '';
    rows.push(['calls', `${own.length === 0 ? '0' : `${own.length} · ${counts.join(', ')}`}${reusedText}`]);
    if (loops.size > 0) {
      rows.push(['loops', [...loops].map(([name, loop]) => `${name} ${loop.iteration}/${loop.max}`).join(', ')]);
    }
    rows.push(['replays', String(replays)]);
    const cost = budgetView.costRow();
    if (cost !== undefined) rows.push(cost);
    rows.push(['run', `${options.shownRunsDir}/${event.runId}`]);
    const at = Date.parse(event.ts);
    const duration = formatDuration(at - (startedAt ?? firstAt ?? at));
    return [
      [],
      [[['bold', STATUS_STYLE[event.status]], event.status], ` · ${duration}`],
      ...rows.map(([label, value]): Line => [`  ${label.padEnd(7)}  ${value}`]),
    ];
  }

  /** The lines `event` prints once `shows()` lets it. */
  function lines(event: SailEvent): Line[] {
    switch (event.type) {
      case 'run:start':
        return [[`sail · ${workflow} · ${event.runId}`]];
      case 'run:keep_awake':
        return [head(undefined, 'keep-awake ·', event.held ? `held by ${event.by}` : `none: ${event.reason}`)];
      case 'run:end':
        return finalBlock(event);
      case 'intake:start':
        return [head(event.key, ['cyan', '▶'], 'intake ', ['bold', event.intake], ` · ${event.kind}`)];
      case 'stage:start': {
        const what = event.kind === 'stage' ? `${event.steps?.length ?? 0} steps` : event.kind;
        const model = modelOn(event);
        const again = event.try > 1 ? ` · try ${event.try}` : '';
        return [head(event.key, ['cyan', '▶'], ['bold', event.stage], ` · ${what}${model}${again}`)];
      }
      case 'step:start': {
        const model = modelOn(event);
        const at = ` · step ${event.index}/${event.of} · ${event.kind}${model}`;
        return [head(event.key, ['cyan', '▶'], ['bold', event.step], at)];
      }
      case 'intake:end':
      case 'stage:end':
      case 'step:end':
        return endLines(event);
      case 'script:exit': {
        const duration = formatDuration(event.durationMs);
        if (event.signal !== undefined) return [detail(event.key, `ended by ${event.signal} · ${duration}`)];
        const outcome = event.outcome === undefined ? '' : ` → ${event.outcome}`;
        return [detail(event.key, `exit ${event.code}${outcome} · ${duration}`)];
      }
      case 'step:queued':
        return [
          detail(
            event.key,
            `queued for exclusive ${event.exclusive} · held by ${event.holder.runId} ${event.holder.key}`,
          ),
        ];
      case 'script:exec':
        return [detail(event.key, `$ ${event.command}${event.cwd === '.' ? '' : ` · in ${event.cwd}`}`)];
      case 'input:materialised':
        return [detail(event.key, `in ${event.binding} ← ${event.from}`)];
      case 'output:validated':
        return [detail(event.key, 'output valid')];
      case 'output:invalid':
        return [detail(event.key, 'output invalid')];
      case 'file:validated': {
        const checks = level >= LEVEL.verbose && event.checks.length > 0 ? ` · ${event.checks.join(', ')}` : '';
        return [detail(event.key, `file ${event.name} ${event.ok ? 'valid' : 'invalid'}${checks}`)];
      }
      case 'file:produced':
        return [detail(event.key, `file ${event.name} · ${formatSize(event.bytes)}`)];
      case 'workflow:route':
        return [head(event.at, '→', `${event.took} · on ${event.value}`)];
      case 'journal:append':
        return [detail(event.key, `journal line ${event.line}`)];
      case 'loop:iteration': {
        const feedback = event.feedback === undefined ? '' : ` · feedback from ${source(event.feedback.from)}`;
        return [head(event.loop, '↻', `iteration ${event.iteration}/${event.max}${feedback}`)];
      }
      case 'all:start': {
        const { keys, running: started } = event;
        const many = started.length === keys.length ? `${keys.length}` : `${started.length} of ${keys.length}`;
        return [head('all', '⇉', `${many} at once: ${started.join(' · ')}`)];
      }
      case 'all:end': {
        const outcomes = Object.values(event.outcomes);
        const counts = OUTCOMES.flatMap((outcome) => {
          const n = outcomes.filter((each) => each === outcome).length;
          return n === 0 ? [] : [`${n} ${outcome}`];
        });
        return [
          head('all', '⇉', [`${event.keys.length} ended`, ...counts, formatDuration(event.durationMs)].join(' · ')),
        ];
      }
      case 'loop:exit':
        return event.reason === 'break'
          ? [head(event.loop, '↻', `break after ${event.iterations}/${event.max}`)]
          : [head(event.loop, ['red', '✗ exceeded'], `${event.iterations}/${event.max}`)];
      case 'budget:warning':
      case 'budget:exceeded':
        if (!isRunBudget(event)) return otherLines(event);
        return [head(undefined, [event.type === 'budget:warning' ? 'yellow' : 'red', '$'], budgetText(event))];
      case 'budget:raised':
        return [head(undefined, '$', raisedText(event))];
      case 'error:crash':
        return message(event.key, `crash: ${event.message}`, (line) => head(event.key, ['red', '✗'], line));
      case 'error:consumer': {
        const failed = `consumer ${event.consumer} failed on ${event.failed.type} #${event.failed.seq}`;
        return message(undefined, `${failed}: ${event.message}`, (line) => head(undefined, ['red', '✗'], line));
      }
      default:
        return otherLines(event);
    }
  }

  /**
   * Any other `error:*`: its message when it carries one, or else its payload. Any other event: trace's generic line, so
   * every event prints at least once there.
   */
  function otherLines(event: SailEvent): Line[] {
    const key = 'key' in event && typeof event.key === 'string' ? event.key : undefined;
    if (!isReported(event.type)) return [head(key, '·', `${event.type} ${payload(event)}`)];
    if ('message' in event && typeof event.message === 'string') {
      return message(key, `${event.type}: ${event.message}`, (line) => head(key, ['red', '✗'], line));
    }
    return [head(key, ['red', '✗'], `${event.type} ${payload(event)}`)];
  }

  // A resume's earlier events set the header, the key column, the feedback sources and the totals, and print nothing.
  // Nothing of theirs is running any more.
  if (options.prior !== undefined) {
    for (const event of options.prior) {
      try {
        update(event);
      } catch {
        // An earlier event the view can't read is left out: the events file is observability, and must never stop a
        // resume the journal allows.
      }
    }
    running = [];
    group = undefined;
    resuming = true;
  }

  return {
    name: 'terminal',
    onEvent(event) {
      if (resuming) {
        resuming = false;
        screen.print(resumeLine(event.runId));
      }
      const was = liveShape();
      update(event);
      // The live line follows the innermost running call, or the group's count, and goes when neither is left.
      const shape = liveShape();
      if (shape !== was) screen.live(shape === undefined ? undefined : liveText);
      if (shows(event)) for (const line of lines(event)) screen.print(line);
    },
    close() {
      running = [];
      group = undefined;
      screen.close();
    },
  };
}
