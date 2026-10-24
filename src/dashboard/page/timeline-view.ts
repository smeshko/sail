// The timeline: one call's events in order, drawn in the centre when its stage card is opened. Thinking and messages
// are blocks of text. A tool call is one row with its input and, once it ends, its duration and how it ended; opened, it
// shows its whole input, the start of its result and any denial. Steps and tries are separators, and a script's
// command is a row with its exit. Everything comes from the card, so a running call's timeline grows with its events.
import { clock, cost, duration } from './format';
import { html, type SafeHtml, text } from './html';
import { elapsedMs, type StageCard, type TimelineEntry, type TimelineScript, type TimelineTool } from './run-model';
import { pillOf, type UiState } from './ui-state';

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
    ? html`<div class="tout"><div class="grp-t">input</div><pre class="code">${JSON.stringify(entry.input, null, 2) ?? ''}</pre>${
        entry.denial === undefined
          ? ''
          : html`<div class="mini deny"><div class="mini-h">denied · ${entry.denial.rule}</div><div class="mini-b">${entry.denial.reason}</div></div>`
      }${
        entry.result === undefined
          ? ''
          : html`<div class="grp-t">result</div><pre class="code${entry.status === 'failed' ? ' bad' : ''}">${entry.result}</pre>`
      }</div>`
    : '';
  return html`<div class="tcall t-${entry.status}${open ? ' open' : ''}"><button class="trow" data-action="toggle-tool" data-call="${entry.callId}"><span class="tname">${entry.tool}</span><span class="tdet">${inputSummary(entry.input)}</span><span class="tmeta">${
    entry.durationMs === undefined ? '' : duration(entry.durationMs)
  }<span class="mark">${MARKS[entry.status]}</span></span></button>${body}</div>`;
}

function script(entry: TimelineScript): SafeHtml {
  const ended =
    entry.durationMs === undefined
      ? html`<span class="mark">…</span>`
      : html`${duration(entry.durationMs)}<span class="mark">${
          entry.signal ?? (entry.code === undefined ? '' : `exit ${entry.code}`)
        }</span>`;
  const status = entry.durationMs === undefined ? 'running' : entry.outcome === 'passed' ? 'completed' : 'failed';
  return html`<div class="tcall t-${status}"><div class="trow"><span class="tname">$</span><span class="tdet">${entry.command}</span><span class="tmeta">${ended}</span></div></div>`;
}

function entryOf(entry: TimelineEntry, ui: UiState): SafeHtml {
  const at = html`<span class="ts">${clock(entry.ts, ui.tz)}</span>`;
  switch (entry.kind) {
    case 'thinking':
      return html`<div class="ev tht">${at}<div class="col"><p>${entry.text}</p></div></div>`;
    case 'message':
      return html`<div class="ev msg">${at}<div class="col"><p>${entry.text}</p></div></div>`;
    case 'tool':
      return html`<div class="ev">${at}<div class="col">${tool(entry, ui)}</div></div>`;
    case 'script':
      return html`<div class="ev">${at}<div class="col">${script(entry)}</div></div>`;
    case 'step':
      return html`<div class="tl-sep"><span>step ${entry.index}/${entry.of} · ${entry.step}</span></div>`;
    case 'try':
      return html`<div class="tl-sep"><span>try ${entry.try}</span></div>`;
  }
}

/** The timeline of `card`. `now` is ms since the epoch, for a running call's duration. */
export function renderTimeline(card: StageCard, ui: UiState, now: number): SafeHtml {
  const running = card.state === 'running';
  const state = running ? 'running' : (card.outcome ?? 'settled');
  const denials = card.denials.length;
  const facts = `${duration(elapsedMs(card, now))} · ${cost(card.costUsd)} · ${card.toolCalls} tool call${
    card.toolCalls === 1 ? '' : 's'
  }${denials === 0 ? '' : ` · ${denials} denied`}`;
  const entries = card.timeline;
  return html`<div class="d-h tl-h"><button class="btn" data-action="close-timeline" title="back to the cards (Esc)">‹ cards</button><span class="d-title">${card.key}</span><span class="pill ${pillOf(state)}">${state}</span><span class="c-agent">${card.kind}${
    card.model === undefined ? '' : html` <span class="c-model">${card.model}</span>`
  }</span><span class="d-agent">${facts}</span><button class="btn" data-action="step-card" data-by="-1" title="previous call ([)">‹</button><button class="btn" data-action="step-card" data-by="1" title="next call (])">›</button>${
    running ? html`<button class="tog${ui.follow ? ' on' : ''}" data-action="toggle-follow">follow</button>` : ''
  }</div>
<div class="tl">${
    entries.length === 0
      ? html`<div class="qempty">${running ? 'nothing yet: the timeline fills as the call works' : 'this call recorded no timeline'}</div>`
      : entries.map((entry) => entryOf(entry, ui))
  }${
    running
      ? html`<div class="streaming"><i></i>${card.key} is working…</div>`
      : html`<div class="logend"><span class="pill ${pillOf(state)}">${state}</span><span>${facts}</span></div>`
  }</div>`;
}
