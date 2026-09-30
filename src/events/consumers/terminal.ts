// The terminal consumer: the event stream as the terminal view, at a verbosity.
//
// A port of the prototype's terminal consumer. It keeps the verbosity gating, the colour rule (now `Io.tty`: colour and
// the live line only in an interactive terminal) and the idea of a script's output tail. It drops the boxes, the ruled
// stage headers and the clock times: every line starts with its key, in a terminal as in a pipe. It writes through the
// `write` it is given, never `process.stdout`, and its clock and timer are injected.
//
// Every event updates the state at every verbosity, so the final block is right at quiet too. What prints is gated by
// one table that mirrors the plan's level table: an event type prints its own lines from the verbosity it names.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { JournalEntry } from '../../engine/journal';
import type { Consumer, EventType, SailEvent } from '../types';
import { createScreen, type Every, type Line, type Segment, type Style, type Tty } from './screen';

export const VERBOSITIES = ['quiet', 'normal', 'verbose', 'trace'] as const;
export type Verbosity = (typeof VERBOSITIES)[number];

const LEVEL: Record<Verbosity, number> = { quiet: 0, normal: 1, verbose: 2, trace: 3 };

/** The lowest verbosity at which each type prints its own lines. Errors print at every level, apart from a timeout. */
const SHOWN_FROM: Partial<Record<EventType, Verbosity>> = {
  'run:start': 'quiet',
  'run:end': 'quiet',
  'intake:start': 'normal',
  'stage:start': 'normal',
  'step:start': 'normal',
  // At quiet, an end prints only when its outcome is `error`.
  'intake:end': 'normal',
  'stage:end': 'normal',
  'step:end': 'normal',
  'script:exit': 'normal',
  'output:validated': 'normal',
  'output:invalid': 'normal',
  'file:validated': 'normal',
  'loop:iteration': 'normal',
  'loop:exit': 'normal',
};

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
export function formatSize(_bytes: number): string {
  return '';
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
    const from = Math.max(0, size - TAIL_WINDOW);
    const buffer = Buffer.alloc(size - from);
    readSync(fd, buffer, 0, buffer.length, from);
    const lines = buffer.toString('utf8').split('\n');
    // A line the window cut off at its start is dropped.
    if (from > 0) lines.shift();
    return { lines: lines.map((line) => line.trimEnd()).filter((line) => line.trim() !== ''), cut: from > 0 };
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
  const kinds = new Map<string, string>();
  const keysByResult = new Map<string, string>();
  const calls: Outcome[] = [];
  const loops = new Map<string, { iteration: number; max: number }>();
  let replays = 0;
  /** The calls and steps running now, innermost last: the live line names the last. */
  let running: { key: string; since: number }[] = [];

  const liveText = (): string => {
    const top = running.at(-1);
    return top === undefined ? '' : `${top.key} running · ${liveElapsed(now() - top.since)}`;
  };

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

  /** `message`'s first line through `first`, and each later line as a detail line indented two more. */
  const message = (key: string | undefined, text: string, first: (line: string) => Line): Line[] => {
    const [line = '', ...more] = text.split('\n').map((each) => each.trimEnd());
    return [first(line), ...more.map((each) => detail(key, `  ${each}`))];
  };

  const source = (from: string): string =>
    from === 'workflow' ? 'the workflow' : (keysByResult.get(from.replace(/#.*$/s, '')) ?? from);

  function shows(event: SailEvent): boolean {
    if (isEnd(event) && event.outcome === 'error') return true;
    if (event.type.startsWith('error:') && event.type !== 'error:timeout') return true;
    const from = SHOWN_FROM[event.type];
    return from !== undefined && level >= LEVEL[from];
  }

  /** Keeps what later lines and the final block need, and the live line. */
  function update(event: SailEvent): void {
    const at = Date.parse(event.ts);
    firstAt ??= at;
    switch (event.type) {
      case 'run:start': {
        startedAt ??= at;
        const { intake, stages } = event.roster;
        const keys = [
          'intake#1',
          ...(intake.steps ?? []).map((step) => `intake#1/${step.step}`),
          ...Object.entries(stages).flatMap(([stage, entry]) => [
            `${stage}#1`,
            ...(entry.steps ?? []).map((step) => `${stage}#1/${step.step}`),
          ]),
        ];
        width = Math.max(...keys.map((key) => key.length));
        return;
      }
      case 'intake:start':
      case 'stage:start':
      case 'step:start':
        kinds.set(event.key, event.kind);
        running.push({ key: event.key, since: now() });
        screen.live(liveText);
        return;
      case 'intake:end':
      case 'stage:end':
      case 'step:end':
        keysByResult.set(event.resultPath, event.key);
        running = running.filter((each) => each.key !== event.key);
        screen.live(running.length === 0 ? undefined : liveText);
        return;
      case 'journal:append':
        if (!event.key.includes('/')) calls.push(event.outcome);
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
        screen.live(undefined);
        return;
      case 'error:crash':
        running = [];
        screen.live(undefined);
        return;
    }
  }

  /** An end line, its errors, and the output tail of a script that didn't pass. */
  function endLines(event: EndEvent): Line[] {
    const [mark, style] = END_MARKS[event.outcome];
    const duration = event.type === 'stage:end' ? ` · ${formatDuration(event.durationMs)}` : '';
    const lines: Line[] = [[column(event.key), '  ', [style, `${mark} ${event.outcome}`], duration]];
    for (const error of event.type === 'stage:end' ? (event.errors ?? []) : []) {
      lines.push(...message(event.key, `${error.reason}: ${error.message}`, (line) => detail(event.key, line)));
    }
    const tailed = event.outcome === 'failed' || event.outcome === 'error';
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
      rows.push(['stop', event.message === undefined ? event.stopReason : `${event.stopReason}: ${event.message}`]);
    }
    const counts = OUTCOMES.flatMap((outcome) => {
      const n = calls.filter((each) => each === outcome).length;
      return n === 0 ? [] : [`${n} ${outcome}`];
    });
    rows.push(['calls', counts.length === 0 ? '0' : `${calls.length} · ${counts.join(', ')}`]);
    if (loops.size > 0) {
      rows.push(['loops', [...loops].map(([name, loop]) => `${name} ${loop.iteration}/${loop.max}`).join(', ')]);
    }
    rows.push(['replays', String(replays)], ['run', `${options.shownRunsDir}/${event.runId}`]);
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
        return [[`sail · ${event.workflow.name} v${event.workflow.version} · ${event.runId}`]];
      case 'run:end':
        return finalBlock(event);
      case 'intake:start':
        return [head(event.key, ['cyan', '▶'], 'intake ', ['bold', event.intake], ` · ${event.kind}`)];
      case 'stage:start': {
        const what = event.kind === 'stage' ? `${event.steps?.length ?? 0} steps` : event.kind;
        const model = event.model === undefined ? '' : ` · ${event.model}`;
        const again = event.try > 1 ? ` · try ${event.try}` : '';
        return [head(event.key, ['cyan', '▶'], ['bold', event.stage], ` · ${what}${model}${again}`)];
      }
      case 'step:start': {
        const model = event.model === undefined ? '' : ` · ${event.model}`;
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
      case 'output:validated':
        return [detail(event.key, 'output valid')];
      case 'output:invalid':
        return [detail(event.key, 'output invalid')];
      case 'file:validated':
        return [detail(event.key, `file ${event.name} ${event.ok ? 'valid' : 'invalid'}`)];
      case 'loop:iteration': {
        const feedback = event.feedback === undefined ? '' : ` · feedback from ${source(event.feedback.from)}`;
        return [head(event.loop, '↻', `iteration ${event.iteration}/${event.max}${feedback}`)];
      }
      case 'loop:exit':
        return event.reason === 'break'
          ? [head(event.loop, '↻', `break after ${event.iterations}/${event.max}`)]
          : [head(event.loop, ['red', '✗ exceeded'], `${event.iterations}/${event.max}`)];
      case 'error:crash':
        return message(event.key, event.message, (line) => head(event.key, ['red', '✗'], `crash: ${line}`));
      case 'error:consumer': {
        const failed = `consumer ${event.consumer} failed on ${event.failed.type} #${event.failed.seq}`;
        return message(undefined, event.message, (line) => head(undefined, ['red', '✗'], `${failed}: ${line}`));
      }
      default:
        return otherError(event);
    }
  }

  /** Any other `error:*`: its message when it carries one, or else its payload. */
  function otherError(event: SailEvent): Line[] {
    const key = 'key' in event && typeof event.key === 'string' ? event.key : undefined;
    if ('message' in event && typeof event.message === 'string') {
      return message(key, event.message, (line) => head(key, ['red', '✗'], `${event.type}: ${line}`));
    }
    return [head(key, ['red', '✗'], `${event.type} ${payload(event)}`)];
  }

  return {
    name: 'terminal',
    onEvent(event) {
      update(event);
      if (shows(event)) for (const line of lines(event)) screen.print(line);
    },
    close() {
      running = [];
      screen.close();
    },
  };
}
