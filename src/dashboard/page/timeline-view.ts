// The timeline: one call's events in order, drawn in the centre when its stage card is opened. Thinking and messages
// are blocks of text. A tool call is one row with its input and, once it ends, its duration and how it ended; opened, it
// shows its whole input, the start of its result and any denial. Steps and tries are separators, and a script's
// command is a row with its exit; opened, it shows the end of the call's stdout and stderr, which the shell reads. Everything
// else comes from the card, so a running call's timeline grows with its events. An opened box carries a data-scroll key,
// by which the host keeps its scroll across a redraw.
// Above the entries, a chip for each kind the call has, with its count, shows or hides that kind; separators always stay.
import { clock, cost, duration } from './format';
import { html, type SafeHtml, text } from './html';
import type { Loaded } from './inspector-view';
import { elapsedMs, type StageCard, type TimelineEntry, type TimelineScript, type TimelineTool } from './run-model';
import { FILTERS, pillOf, type TimelineFilter, type UiState } from './ui-state';

/** A call's stdout and stderr, as the shell read them for its timeline. */
export interface CallOutput {
  stdout?: Loaded<string>;
  stderr?: Loaded<string>;
}

/** How many of a stream's last lines an opened script shows. */
export const OUTPUT_LINES = 200;

/** The id a script command's row is opened by: its place among the call's commands. */
export const scriptId = (index: number) => `script:${index}`;

/** The longest a tool's input runs on its row. */
const SUMMARY_LENGTH = 160;

/** The input fields that say most about a tool call, in the order they are looked for. */
const TELLING = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt'];

const cut = (shown: string) => (shown.length > SUMMARY_LENGTH ? `${shown.slice(0, SUMMARY_LENGTH)}…` : shown);

/** A tool call's input on one line: its most telling text field, else its JSON. */
export function inputSummary(input: unknown): string {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const fields = input as Record<string, unknown>;
    for (const name of TELLING) {
      const value = fields[name];
      if (typeof value === 'string' && value !== '') return cut(value.split('\n')[0] ?? '');
    }
  }
  return input === undefined ? '' : cut(text(input));
}

const MARKS: Record<TimelineTool['status'], string> = { running: '…', completed: '✓', failed: '✗', denied: '⊘' };

function tool(entry: TimelineTool, ui: UiState): SafeHtml {
  const open = ui.opened.includes(entry.callId);
  const body = open
    ? html`<div class="tout"><div class="grp-t">input</div><pre class="code" data-scroll="input:${entry.callId}">${JSON.stringify(entry.input, null, 2) ?? ''}</pre>${
        entry.denial === undefined
          ? ''
          : html`<div class="mini deny"><div class="mini-h">denied · ${entry.denial.rule}</div><div class="mini-b">${entry.denial.reason}</div></div>`
      }${
        entry.result === undefined
          ? ''
          : html`<div class="grp-t">result</div><pre class="code${entry.status === 'failed' ? ' bad' : ''}" data-scroll="result:${entry.callId}">${entry.result}</pre>`
      }</div>`
    : '';
  return html`<div class="tcall t-${entry.status}${open ? ' open' : ''}"><button class="trow" data-action="toggle-tool" data-call="${entry.callId}"><span class="tname">${entry.tool}</span><span class="tdet">${inputSummary(entry.input)}</span><span class="tmeta">${
    entry.durationMs === undefined ? '' : duration(entry.durationMs)
  }<span class="mark">${MARKS[entry.status]}</span></span></button>${body}</div>`;
}

const scriptStatus = (entry: TimelineScript) =>
  entry.durationMs === undefined ? 'running' : entry.outcome === 'passed' ? 'completed' : 'failed';

/** The kind of entry `entry` is: a failed or denied tool call and a failed script are errors. A separator is none. */
export function filterOf(entry: TimelineEntry): TimelineFilter | undefined {
  switch (entry.kind) {
    case 'thinking':
      return 'thinking';
    case 'message':
      return 'messages';
    case 'tool':
      return entry.status === 'failed' || entry.status === 'denied' ? 'errors' : 'tools';
    case 'script':
      return scriptStatus(entry) === 'failed' ? 'errors' : 'scripts';
    default:
      return undefined;
  }
}

/** A chip for each kind of entry in `entries`, with its count, and `all` while one of them is hidden. */
function filters(entries: readonly TimelineEntry[], ui: UiState): SafeHtml {
  const counts = new Map<TimelineFilter, number>();
  for (const entry of entries) {
    const kind = filterOf(entry);
    if (kind !== undefined) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const present = FILTERS.filter((kind) => counts.has(kind));
  if (present.length === 0) return html``;
  const hiding = present.some((kind) => ui.hidden.includes(kind));
  return html`<div class="tl-f">${present.map(
    (kind) =>
      html`<button class="tog f-${kind}${ui.hidden.includes(kind) ? '' : ' on'}" data-action="toggle-filter" data-filter="${kind}">${kind} <span class="n">${counts.get(kind) ?? 0}</span></button>`,
  )}${hiding ? html`<button class="tog" data-action="show-all">all</button>` : ''}</div>`;
}

/** The last `OUTPUT_LINES` lines of `log`, and how many it had before them. */
function tail(log: string): { shown: string; cut: number } {
  const lines = log.replace(/\n$/, '').split('\n');
  const cut = Math.max(0, lines.length - OUTPUT_LINES);
  return { shown: lines.slice(cut).join('\n'), cut };
}

function stream(name: string, id: string, loaded: Loaded<string> | undefined): SafeHtml {
  if (loaded === undefined || loaded.state === 'loading')
    return html`<div class="grp-t">${name}</div><div class="code">loading…</div>`;
  if (loaded.state === 'missing' || loaded.value === '') return html``;
  const { shown, cut } = tail(loaded.value);
  return html`<div class="grp-t">${name}${cut === 0 ? '' : ` · last ${OUTPUT_LINES} lines`}</div><pre class="code" data-scroll="${name}:${id}">${shown}</pre>`;
}

function outputOf(id: string, output: CallOutput | undefined): SafeHtml {
  const streams = html`${stream('stdout', id, output?.stdout)}${stream('stderr', id, output?.stderr)}`;
  return html`<div class="tout">${streams.value === '' ? html`<div class="code">the call printed nothing</div>` : streams}</div>`;
}

function script(entry: TimelineScript, id: string, ui: UiState, output: CallOutput | undefined): SafeHtml {
  const open = ui.opened.includes(id);
  const ended =
    entry.durationMs === undefined
      ? html`<span class="mark">…</span>`
      : html`${duration(entry.durationMs)}<span class="mark">${
          entry.signal ?? (entry.code === undefined ? '' : `exit ${entry.code}`)
        }</span>`;
  return html`<div class="tcall t-${scriptStatus(entry)}${open ? ' open' : ''}"><button class="trow" data-action="toggle-tool" data-call="${id}"><span class="tname">$</span><span class="tdet">${entry.command}</span><span class="tmeta">${ended}</span></button>${
    open ? outputOf(id, output) : ''
  }</div>`;
}

function entryOf(
  entry: TimelineEntry,
  ui: UiState,
  scripts: Map<TimelineEntry, string>,
  output?: CallOutput,
): SafeHtml {
  const at = html`<span class="ts">${clock(entry.ts, ui.tz)}</span>`;
  switch (entry.kind) {
    case 'thinking':
      return html`<div class="ev tht">${at}<div class="col"><p>${entry.text}</p></div></div>`;
    case 'message':
      return html`<div class="ev msg">${at}<div class="col"><p>${entry.text}</p></div></div>`;
    case 'tool':
      return html`<div class="ev">${at}<div class="col">${tool(entry, ui)}</div></div>`;
    case 'script':
      return html`<div class="ev">${at}<div class="col">${script(entry, scripts.get(entry) ?? '', ui, output)}</div></div>`;
    case 'step':
      return html`<div class="tl-sep"><span>step ${entry.index}/${entry.of} · ${entry.step}</span></div>`;
    case 'try':
      return html`<div class="tl-sep"><span>try ${entry.try}</span></div>`;
    case 'queued':
      return html`<div class="tl-sep"><span>queued for exclusive ${entry.exclusive} · held by ${entry.holder}</span></div>`;
  }
}

/**
 * The timeline of `card`. `now` is ms since the epoch, for a running call's duration, and `output` the call's stdout
 * and stderr for an opened script.
 */
export function renderTimeline(card: StageCard, ui: UiState, now: number, output?: CallOutput): SafeHtml {
  const running = card.state === 'running';
  const state = running ? 'running' : (card.outcome ?? 'settled');
  const denials = card.denials.length;
  // A running call's cost is known only once its session ends.
  const facts = `${duration(elapsedMs(card, now))}${running ? '' : ` · ${cost(card.costUsd)}`} · ${card.toolCalls} tool call${
    card.toolCalls === 1 ? '' : 's'
  }${denials === 0 ? '' : ` · ${denials} denied`}`;
  const entries = card.timeline;
  const scripts = new Map(
    entries.filter((entry) => entry.kind === 'script').map((entry, index) => [entry, scriptId(index)] as const),
  );
  const shown = entries.filter((entry) => {
    const kind = filterOf(entry);
    return kind === undefined || !ui.hidden.includes(kind);
  });
  const hidesAll =
    entries.some((entry) => filterOf(entry) !== undefined) && shown.every((entry) => filterOf(entry) === undefined);
  return html`<div class="tl-top"><div class="d-h tl-h"><button class="btn" data-action="close-timeline" title="back to the cards (Esc)">‹ cards</button><span class="d-title">${card.key}</span><span class="pill ${pillOf(state)}">${state}</span><span class="c-agent">${card.kind}${
    card.model === undefined ? '' : html` <span class="c-model">${card.model}</span>`
  }</span><span class="d-agent">${facts}</span><button class="btn" data-action="step-card" data-by="-1" title="previous call ([)">‹</button><button class="btn" data-action="step-card" data-by="1" title="next call (])">›</button>${
    running ? html`<button class="tog${ui.follow ? ' on' : ''}" data-action="toggle-follow">follow</button>` : ''
  }</div>
${filters(entries, ui)}</div><div class="tl">${
    entries.length === 0
      ? html`<div class="qempty">${running ? 'nothing yet: the timeline fills as the call works' : 'this call recorded no timeline'}</div>`
      : hidesAll
        ? html`<div class="qempty">the filter hides every entry</div>`
        : shown.map((entry) => entryOf(entry, ui, scripts, output))
  }${
    running
      ? html`<div class="streaming"><i></i>${card.key} is working…</div>`
      : html`<div class="logend"><span class="pill ${pillOf(state)}">${state}</span><span>${facts}</span></div>`
  }</div>`;
}
