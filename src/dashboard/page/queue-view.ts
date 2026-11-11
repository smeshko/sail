// The queue view: one watched workflow's queue, opened from its row in the list and drawn in the centre in place of the
// run, with its polling, a box of items for each state that has any, running first, each folding from its heading, and
// its recent events from the queue's own stream, folded until the person opens them, and the error that stream sent.
// The controls ask the watcher and change nothing themselves: the header's poll button and its workflow's Watch or Unwatch, a field to add a ticket, with an add and an add that skips its checks (for a
// workflow that polls tickets), and, at a row's right, ▲ and ▼ on a waiting item to move it before or after its waiting
// neighbour, and a ⋯ on any item but a running one, which opens its menu: requeue, on a parked item or a failed one
// whose run has ended, and drop, which opens the confirmation dialog. One menu is open at a time. The answer to any of
// them, a refusal or that the watcher has not taken it yet, is a toast, and while a request is out the header or the
// item's row reads the word under way. A queue held on the usage limit of a harness key also offers a release of that
// hold, confirmed in the dialog: it needs no watcher. While the workflow isn't watched, or its watcher isn't running,
// which the index says from the live watcher, every one of those controls is drawn disabled and the server's reason
// shows beside the poll button. An item whose run the list shows opens it. A waiting item shows its priority. A held
// item shows when its hold ends and why, and its hold's events name it. An item that waits on its ticket's
// prerequisites names them.
import type { QueueEvent } from '../../events/types';
import type { QueueItemState } from '../../watch/queue-store';
import type { RepoOffers } from '../offers';
import { ACTIONS, actionOf, type OfferSource, type Subject } from './action-registry';
import { actionControl } from './action-view';
import { ago, clock } from './format';
import { html, type SafeHtml, safeHref } from './html';
import { type PanelItem, panelSource, QUEUE_STATES, type QueuePanel } from './index-model';
import { watchButtons } from './list-view';
import type { UiState } from './ui-state';

/** What the shell has heard on a queue's stream: its last events. */
export interface QueueStream {
  recent: readonly QueueEvent[];
  /** The error its stream sent, which stops its reconnects. */
  error?: string;
  /** What the workflow polls, from its last `queue:polled` event. */
  polls?: 'ticket' | 'pr' | undefined;
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
    case 'queue:held': {
      const hold = `${fields.until === undefined ? 'held' : `until ${text(fields.until)}`}: ${text(fields.reason)}`;
      return typeof fields.dedupKey === 'string' ? `${fields.dedupKey} ${hold}` : hold;
    }
    case 'queue:released':
      return typeof fields.dedupKey === 'string' ? `${fields.dedupKey} released` : 'dispatch released';
    case 'queue:waiting':
      return `${text(fields.dedupKey)} waiting on ${Array.isArray(fields.on) ? fields.on.map(text).join(', ') : ''}`;
    case 'queue:moved': {
      const place = typeof fields.before === 'string' ? `before ${fields.before}` : `after ${text(fields.after)}`;
      return `${text(fields.dedupKey)} moved ${place}: ${text(fields.reason)}`;
    }
    default:
      return '';
  }
}

const itemSubject = (panel: QueuePanel, item: PanelItem): Subject => ({
  kind: 'item',
  repo: panel.repo,
  workflow: panel.workflow,
  item: item.dedupKey,
});

/** Whether the queue offers its own action `id`: poll or add. */
const queueOffered = (panel: QueuePanel, id: string) =>
  actionOf(id)?.available({ kind: 'workflow', repo: panel.repo, workflow: panel.workflow }, panelSource(panel))
    .offered === true;

/** Whether the queue offers `id` for `item`. */
const offered = (panel: QueuePanel, item: PanelItem, id: string) =>
  actionOf(id)?.available(itemSubject(panel, item), panelSource(panel)).offered === true;

/** Whether the queue offers `item` a drop. */
export const offeredDrop = (panel: QueuePanel, item: PanelItem) => offered(panel, item, 'drop-item');

/** The registry's actions a row's ⋯ menu holds, in order: those done to an item that the row supplies no value for. */
const menuActions = (subject: Subject, source: OfferSource) =>
  ACTIONS.filter(
    (def) => def.appliesTo.includes('item') && def.params(subject, source).every((param) => param.given === undefined),
  );

/** Whether the queue offers the item anything its ⋯ menu holds: requeue or drop. */
export const hasItemActions = (panel: QueuePanel, item: PanelItem) => {
  const subject = itemSubject(panel, item);
  const source = panelSource(panel);
  return menuActions(subject, source).some((def) => def.available(subject, source).offered);
};

/**
 * A row's ⋯ and, once opened, its menu, drawn from the registry by what the queue offers: requeue on a parked item, or a
 * failed one whose run has ended; drop on any item that isn't running, which opens the dialog. A running item
 * offers neither, so it has no ⋯.
 */
function itemMenu(panel: QueuePanel, item: PanelItem, ui: UiState, why: string | undefined): SafeHtml | '' {
  if (!hasItemActions(panel, item)) return '';
  if (why !== undefined) {
    return html`<span class="qmore"><button class="btn mv more" disabled aria-label="actions for ${item.dedupKey}" title="${why}">⋯</button></span>`;
  }
  const open = ui.itemMenu === item.dedupKey;
  const toggle = html`<button class="btn mv more${open ? ' open' : ''}" data-action="item-menu" data-item="${item.dedupKey}" aria-label="actions for ${item.dedupKey}" aria-expanded="${open ? 'true' : 'false'}" title="actions for ${item.dedupKey}">⋯</button>`;
  if (!open) return html`<span class="qmore">${toggle}</span>`;
  const subject = itemSubject(panel, item);
  const source = panelSource(panel);
  const buttons = menuActions(subject, source).map((def) => {
    const title = `${def.label(subject)} ${item.dedupKey}`;
    return actionControl(def, subject, ui.act, source, { data: true, title });
  });
  return html`<span class="qmore">${toggle}<span class="qmenu">${buttons}</span></span>`;
}

/**
 * The release of the usage-limit hold on `key`, drawn after the held chip: a `release` button, which opens the
 * confirmation dialog. The hold is the machine's, so it needs no watcher.
 */
function releaseControl(panel: QueuePanel, key: string, ui: UiState): SafeHtml | '' {
  const def = actionOf('release-hold');
  if (def === undefined) return '';
  const subject: Subject = { kind: 'workflow', repo: panel.repo, workflow: panel.workflow };
  return actionControl(def, subject, ui.act, panelSource(panel), {
    data: true,
    attrs: { harness: key },
    title: `release the usage-limit hold on ${key}`,
  });
}

/** The field to add a ticket by its key, as typed so far, and the two buttons that add it, the second skipping its checks. */
function addForm(panel: QueuePanel, ui: UiState, why: string | undefined): SafeHtml {
  const typed = ui.act.drafts['add-ticket'];
  if (why !== undefined) {
    return html`<div class="qadd"><input class="txt" type="text" name="add-ticket" placeholder="ticket key" value="${typed?.ticket ?? ''}" disabled title="${why}"><button class="btn" disabled title="${why}">add</button><button class="btn" disabled title="${why}">add, skipping its checks</button></div>`;
  }
  return html`<div class="qadd"><input class="txt" type="text" name="add-ticket" placeholder="ticket key" value="${typed?.ticket ?? ''}"><button class="btn" data-action="add-ticket" data-repo="${panel.repo}" data-workflow="${panel.workflow}" title="add the ticket to the queue">add</button><button class="btn" data-action="add-ticket-force" data-repo="${panel.repo}" data-workflow="${panel.workflow}" title="add the ticket without checking its label or state">add, skipping its checks</button></div>`;
}

/** A waiting row's ▲ or ▼: `target` is the waiting neighbour the item moves before or after. */
function moveButton(
  panel: QueuePanel,
  item: PanelItem,
  dir: 'up' | 'down',
  target: PanelItem,
  why: string | undefined,
): SafeHtml {
  if (why !== undefined) {
    return html`<button class="btn mv" disabled aria-label="move ${dir === 'up' ? 'up, before' : 'down, after'} ${target.dedupKey}" title="${why}">${dir === 'up' ? '▲' : '▼'}</button>`;
  }
  return html`<button class="btn mv" data-action="move-item" data-dir="${dir}" data-repo="${panel.repo}" data-workflow="${panel.workflow}" data-key="${item.dedupKey}" data-target="${target.dedupKey}" aria-label="move ${dir === 'up' ? 'up, before' : 'down, after'} ${target.dedupKey}" title="move ${dir === 'up' ? 'up, before' : 'down, after'} ${target.dedupKey}">${dir === 'up' ? '▲' : '▼'}</button>`;
}

function moveButtons(panel: QueuePanel, item: PanelItem, why: string | undefined): SafeHtml | '' {
  if (!offered(panel, item, 'move-item')) return '';
  const waiting = panel.items.filter((each) => each.state === 'queued');
  const at = waiting.indexOf(item);
  const above = waiting[at - 1];
  const below = waiting[at + 1];
  // A missing ▲ or ▼ keeps its place, so the arrows line up down the box.
  const gap = html`<span class="mv-gap"></span>`;
  return html`${above === undefined ? gap : moveButton(panel, item, 'up', above, why)}${below === undefined ? gap : moveButton(panel, item, 'down', below, why)}`;
}

function itemRow(panel: QueuePanel, item: PanelItem, ui: UiState, why: string | undefined): SafeHtml {
  const href = safeHref(item.url);
  const title =
    href === undefined
      ? html`<span class="c-t">${item.title}</span>`
      : html`<a class="c-t" href="${href}" rel="noreferrer" target="_blank">${item.title}</a>`;
  const run =
    item.runId === undefined
      ? ''
      : item.runListed
        ? html`<button class="run-link" data-action="select-run" data-repo="${panel.repo}" data-run="${item.runId}" title="open ${item.runId}">${item.runId} ›</button>`
        : html`<span class="c-run">${item.runId}</span>`;
  const underway = ui.underway[`item:${panel.repo}/${panel.workflow}/${item.dedupKey}`];
  return html`<div class="qrow2${item.state === 'done' ? ' done' : ''}"><span class="c-dot"><i class="${item.state}"></i></span><span class="c-ref">${item.dedupKey}</span><span class="c-main">${title}<span class="c-sub">${underway === undefined ? item.state : html`<span class="busy">${underway}</span>`} · ${plural(item.attempts, 'attempt')}${
    item.priority === undefined || item.priority === 'none' ? '' : ` · priority ${item.priority}`
  }${item.moved === true ? ' · moved' : ''}${
    item.retryAt === undefined ? '' : html` · retry at ${clock(item.retryAt, ui.tz)}`
  }${
    item.held === undefined
      ? ''
      : html` · held until ${clock(item.held.until, ui.tz)} · <span class="why">${item.held.reason}</span>`
  }${item.waitingOn === undefined ? '' : html` · waiting on ${item.waitingOn.join(', ')}`}${item.reason === undefined ? '' : html` · <span class="why">${item.reason}</span>`}</span></span><span class="c-side">${run}${moveButtons(panel, item, why)}${itemMenu(panel, item, ui, why)}</span></div>`;
}

/** What each state is called in the view: what it means to the person, rather than the queue file's word. */
const LABELS: Record<QueueItemState, string> = {
  queued: 'waiting',
  dispatched: 'running',
  failed: 'failed',
  parked: 'parked',
  done: 'done',
};

/** The queue's recent events, folded under a toggle until opened. */
function recentEvents(stream: QueueStream | undefined, ui: UiState): SafeHtml {
  const recent = stream?.recent ?? [];
  const toggle = html`<button class="qrecent-h${ui.queueEvents ? ' open' : ''}" data-action="toggle-queue-events" aria-expanded="${ui.queueEvents ? 'true' : 'false'}"><span class="caret">›</span>recent queue events<span class="n">${recent.length}</span></button>`;
  if (!ui.queueEvents) return toggle;
  return html`${toggle}<div class="qrecent">${recent.map(
    (event) =>
      html`<div class="ev"><span class="ts">${clock(event.ts, ui.tz)}</span><span class="tname">${event.type}</span><span class="tdet">${queueEventLine(event)}</span></div>`,
  )}</div>`;
}

function panelView(
  panel: QueuePanel,
  stream: QueueStream | undefined,
  ui: UiState,
  now: number,
  repoOffers: RepoOffers | undefined,
): SafeHtml {
  const { state } = panel.watch;
  const why = panel.watch.state === 'watched' ? undefined : panel.watch.why;
  const polling = panel.queue?.polling;
  const paused = polling?.paused;
  const held = panel.queue?.held;
  const underway = ui.underway[`queue:${panel.repo}/${panel.workflow}`];
  return html`<section class="qpanel">
<div class="srcbar"><span class="h${why === undefined ? '' : ' held'}"></span><span class="nm">${panel.repo} / ${panel.workflow}</span>${
    underway === undefined
      ? html`<span class="pill ${why === undefined ? 'p-pass' : 'p-skip'}">${state}</span>`
      : html`<span class="busy">${underway}</span>`
  }${
    polling === undefined
      ? ''
      : html`<span class="dt">label ${polling.label} · polled ${ago(polling.lastPolledAt, now)} · ${polling.failures} failed polls</span>`
  }${paused === undefined ? '' : html`<span class="warnchip">paused: ${paused.port} ${paused.adapter}: ${paused.message}</span>`}${
    held === undefined
      ? ''
      : html`<span class="warnchip">held${held.until === undefined ? '' : html` until ${clock(held.until, ui.tz)}`}: ${held.reason}</span>${held.harnessKey === undefined ? '' : releaseControl(panel, held.harnessKey, ui)}`
  }${
    !queueOffered(panel, 'poll-queue')
      ? ''
      : why === undefined
        ? html`<button class="btn" data-action="poll-queue" data-repo="${panel.repo}" data-workflow="${panel.workflow}" title="poll now">poll</button>`
        : html`<span class="act"><button class="btn" disabled title="${why}">poll</button><span class="act-why">${why}</span></span>`
  }${watchButtons(panel.repo, repoOffers, ui, panel.workflow)}</div>
${stream?.polls === 'ticket' && queueOffered(panel, 'add-ticket') ? addForm(panel, ui, why) : ''}
${panel.problem === undefined ? '' : html`<div class="code bad">${panel.problem}</div>`}
${stream?.error === undefined ? '' : html`<div class="code bad">${stream.error}</div>`}
<div class="statebar">${QUEUE_STATES.map((state) => html`<span class="sf"><i class="d ${state}"></i>${LABELS[state]} <span class="n">${panel.counts[state]}</span></span>`)}</div>
${
  panel.items.length === 0
    ? html`<div class="qempty">the queue is empty</div>`
    : QUEUE_STATES.map((state) => {
        const items = panel.items.filter((item) => item.state === state);
        if (items.length === 0) return '';
        const id = `${queueId(panel.repo, panel.workflow)}:${state}`;
        const open = !ui.folded.includes(id);
        const heading = html`<button class="qsec grp-t${open ? ' open' : ''}" data-action="toggle-queue-section" data-section="${id}" aria-expanded="${open ? 'true' : 'false'}"><span class="caret">›</span>${LABELS[state]} · ${items.length}</button>`;
        if (!open) return heading;
        return html`${heading}<div class="qbox">${items.map((item) => itemRow(panel, item, ui, why))}</div>`;
      })
}
${recentEvents(stream, ui)}
</section>`;
}

/** The queue view of `panel`, under a header naming its workflow and repository. */
export function renderQueue(
  panel: QueuePanel,
  stream: QueueStream | undefined,
  ui: UiState,
  now: number,
  repoOffers?: RepoOffers | undefined,
): SafeHtml {
  return html`<div class="d-h"><span class="d-title">${panel.workflow} queue</span><span class="d-agent">${panel.repo}</span></div>
${panelView(panel, stream, ui, now, repoOffers)}`;
}
