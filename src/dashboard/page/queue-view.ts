// The queue view: one watched workflow's queue, opened from its row in the rail and drawn in the centre in place of the
// run, with its polling, its items by state, and its recent events from the queue's own stream. A parked item shows
// the commands that requeue or drop it, to copy, and an item whose run the rail lists opens it: the dashboard changes
// nothing itself.
import type { QueueEvent } from '../../events/types';
import { parkedCommands } from './commands';
import { ago, clock } from './format';
import { html, type SafeHtml, safeHref } from './html';
import { type PanelItem, QUEUE_STATES, type QueuePanel, type WatchState } from './index-model';
import type { UiState } from './ui-state';

/** What the shell has heard on a queue's stream: its last events and its watch state. */
export interface QueueStream {
  recent: readonly QueueEvent[];
  watch: WatchState;
}

/** The key a queue's stream is kept under: `<repo>/<workflow>`. */
export const queueId = (repo: string, workflow: string) => `${repo}/${workflow}`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): string => (typeof value === 'number' ? String(value) : '?');

/** One line about a queue event. An unknown type shows its type alone. */
export function queueEventLine(event: QueueEvent): string {
  const fields = event as unknown as Record<string, unknown>;
  switch (event.type) {
    case 'watch:added':
      return 'added to the watch set';
    case 'watch:removed':
      return 'removed from the watch set';
    case 'queue:polled':
      return `found ${count(fields.found)}, added ${count(fields.added)}, label ${text(fields.label)}`;
    case 'queue:item_added':
      return `${text(fields.dedupKey)} ${text(fields.title)}`;
    case 'queue:parked':
      return `${text(fields.dedupKey)} after ${count(fields.attempts)} attempts: ${text(fields.reason)}`;
    case 'queue:error':
      return `${text(fields.port)} ${text(fields.adapter)}: ${text(fields.message)}${fields.paused === true ? ' (paused)' : ''}`;
    default:
      return '';
  }
}

function commands(panel: QueuePanel, item: PanelItem): SafeHtml {
  return html`<span class="cmds">${parkedCommands(panel.workflow, item.dedupKey).map(
    ({ label, command }) =>
      html`<span class="cmd"><code>${command}</code><button class="btn" data-action="copy" data-text="${command}" title="${label}">copy</button></span>`,
  )}</span>`;
}

function itemRow(panel: QueuePanel, item: PanelItem, ui: UiState): SafeHtml {
  const href = safeHref(item.url);
  const title =
    href === undefined
      ? html`<span class="c-t">${item.title}</span>`
      : html`<a class="c-t" href="${href}" rel="noreferrer" target="_blank">${item.title}</a>`;
  const run =
    item.runId === undefined
      ? ''
      : item.runListed
        ? html`<button class="btn" data-action="select-run" data-repo="${panel.repo}" data-run="${item.runId}">${item.runId}</button>`
        : html`<span class="c-run">${item.runId}</span>`;
  return html`<div class="qrow2 ${item.state}"><span class="c-dot"><i class="${item.state}"></i></span><span class="c-ref">${item.dedupKey}</span><span class="c-main">${title}<span class="c-sub">${item.state} · ${plural(item.attempts, 'attempt')}${
    item.retryAt === undefined ? '' : html` · retry at ${clock(item.retryAt, ui.tz)}`
  }${item.reason === undefined ? '' : html` · <span class="why">${item.reason}</span>`}</span>${item.state === 'parked' ? commands(panel, item) : ''}</span>${run}</div>`;
}

function panelView(panel: QueuePanel, stream: QueueStream | undefined, ui: UiState, now: number): SafeHtml {
  const watch = stream?.watch ?? 'unknown';
  const polling = panel.queue?.polling;
  const paused = polling?.paused;
  return html`<section class="qpanel">
<div class="srcbar"><span class="h${watch === 'watched' ? '' : ' held'}"></span><span class="nm">${panel.repo} / ${panel.workflow}</span><span class="pill ${watch === 'watched' ? 'p-pass' : 'p-skip'}">${watch}</span>${
    polling === undefined
      ? ''
      : html`<span class="dt">label ${polling.label} · polled ${ago(polling.lastPolledAt, now)} · ${polling.failures} failed polls</span>`
  }${paused === undefined ? '' : html`<span class="warnchip">paused: ${paused.port} ${paused.adapter}: ${paused.message}</span>`}</div>
${panel.problem === undefined ? '' : html`<div class="code bad">${panel.problem}</div>`}
<div class="statebar">${QUEUE_STATES.map((state) => html`<span class="sf"><i class="d ${state}"></i>${state} <span class="n">${panel.counts[state]}</span></span>`)}</div>
<div class="qlist">${panel.items.length === 0 ? html`<div class="qempty">the queue is empty</div>` : panel.items.map((item) => itemRow(panel, item, ui))}</div>
<div class="qrecent">${(stream?.recent ?? []).map(
    (event) =>
      html`<div class="ev"><span class="ts">${clock(event.ts, ui.tz)}</span><span class="tname">${event.type}</span><span class="tdet">${queueEventLine(event)}</span></div>`,
  )}</div>
</section>`;
}

/** The queue view of `panel`, under a header naming its workflow and repository. */
export function renderQueue(panel: QueuePanel, stream: QueueStream | undefined, ui: UiState, now: number): SafeHtml {
  return html`<div class="d-h"><span class="d-title">${panel.workflow} queue</span><span class="d-agent">${panel.repo}</span></div>
${panelView(panel, stream, ui, now)}`;
}
