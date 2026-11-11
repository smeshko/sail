// The list: the one component every view draws its rows on, in the centre. A head names the view with its count, which
// reads `n of m` while the filter field narrows it, and carries the field itself. Under it,
// folding groups: Active's `waiting on you` and `running`, History's `failed` and `done`, and in Queues one per
// repository. A run's row is a `div` holding two sibling buttons: its own, which opens the run and shows on one line
// its status, id, title, repository › workflow, stalled mark, duration, cost and stop reason, with a problem wrapping
// inside it, and, but on a completed run, a ⋯ of its own that opens the run and, under the row, a menu of what it
// offers: Resume, Restart, Stop and Clean. A queue's row opens its queue and names its watch state, the live watcher's;
// a queue that can't be read shows its problem in place of its waiting count. A Queues group's header row also carries
// the Watch all and Unwatch all the repository offers, drawn from the registry, and its problem; each runs at once, its
// answer is a toast, and while its request is out the buttons read the word under way, as a run's row reads it in place
// of its status. A folded group draws its header alone.
import type { RunActions } from '../actions';
import type { RepoOffers } from '../offers';
import { ACTIONS, type OfferSource, type Subject } from './action-registry';
import { actionControl } from './action-view';
import { ago, cost, duration } from './format';
import { html, type SafeHtml } from './html';
import { type ListRepo, type ListRun, workflowOf } from './index-model';
import {
  filterRows,
  groupsOf,
  type ListGroup,
  type ListRow,
  type QueueRow,
  type RunRow,
  type ViewName,
} from './list-model';
import { queueId } from './queue-view';
import { runControls } from './run-view';
import { pillOf, type UiState } from './ui-state';

/** What each view is headed with. */
export const VIEW_LABELS: Record<ViewName, string> = { active: 'Active', queues: 'Queues', history: 'History' };

/** Whether `run` of `repo` is the open run: not while a queue holds the centre. */
export const isOpen = (repo: string, run: ListRun, ui: UiState) =>
  ui.queue === undefined && ui.repo === repo && ui.runId === run.runId;

/** The ID a run is listed by: its pull request, else its ticket key, else its run id. */
export const runLabel = (run: ListRun) => (run.pr === undefined ? (run.ticketKey ?? run.runId) : `PR #${run.pr}`);

/** The full title, led by the run id for a pull-request run. */
export const tooltipOf = (run: ListRun): string | undefined =>
  run.pr === undefined ? run.title : run.title === undefined ? run.runId : `${run.runId} · ${run.title}`;

/** Whether `run`'s menu is open: only the open run's can be. */
const isMenuOpen = (repo: string, run: ListRun, ui: UiState) => isOpen(repo, run, ui) && ui.runMenu === run.runId;

/** A row's ⋯: on any run but a completed one, which offers nothing. */
export function more(repo: string, run: ListRun, ui: UiState): SafeHtml | '' {
  if (run.status === 'completed') return '';
  return html`<button class="r-more${isMenuOpen(repo, run, ui) ? ' open' : ''}" type="button" data-action="run-menu" data-repo="${repo}" data-run="${run.runId}" aria-label="actions for ${run.runId}" aria-expanded="${isMenuOpen(repo, run, ui) ? 'true' : 'false'}" title="actions for ${run.runId}">⋯</button>`;
}

/** The open menu under `run`'s row: what the run offers, once its actions are read. */
export function runMenu(repo: string, run: ListRun, ui: UiState, offers: RunActions | undefined): SafeHtml | '' {
  if (!isMenuOpen(repo, run, ui)) return '';
  const controls = runControls(offers, ui);
  if (controls !== undefined) return html`<div class="r-menu">${controls}</div>`;
  const why = offers === undefined ? 'reading what the run offers…' : (offers.why ?? 'the run offers nothing');
  return html`<div class="r-menu"><span class="act-why">${why}</span></div>`;
}

/**
 * The watch or unwatch button each offered, drawn from the registry, for a workflow, or for the whole repository when
 * `workflow` is left out. While a request for it is out, the word under way takes their place.
 */
export function watchButtons(repo: string, offers: RepoOffers | undefined, ui: UiState, workflow?: string): SafeHtml {
  const subject: Subject = workflow === undefined ? { kind: 'repo', repo } : { kind: 'workflow', repo, workflow };
  const source: OfferSource = { index: [{ name: repo, queues: [], offers }] };
  const underway = ui.underway[workflow === undefined ? `watch:${repo}` : `watch:${repo}/${workflow}`];
  if (underway !== undefined) return html`<span class="busy">${underway}</span>`;
  return html`${ACTIONS.filter((def) => def.place === 'repo' && def.appliesTo.includes(subject.kind)).map((def) =>
    actionControl(def, subject, ui.act, source, { class: 'wf-act', data: true }),
  )}`;
}

/** A queue's watch state as a word: the live watcher's, the same one its queue view's pill reads. */
function watchWord(watch: QueueRow['watch']): SafeHtml | '' {
  if (watch === undefined) return '';
  if (watch.state === 'watched') return html`<span class="wf-watch on">watched</span>`;
  const kind = watch.state === 'not watched' ? 'off' : 'down';
  return html`<span class="wf-watch ${kind}" title="${watch.why ?? ''}">${watch.state}</span>`;
}

/** A run's status dot, or the word under way while a request for the run is out. */
function statusMark(repo: string, run: ListRun, ui: UiState): SafeHtml {
  const underway = ui.underway[`run:${repo}/${run.runId}`];
  return underway === undefined
    ? html`<span class="st ${pillOf(run.status)}"></span>`
    : html`<span class="busy">${underway}</span>`;
}

const cur = (id: string, ui: UiState) => (ui.listCursor === id ? ' cur' : '');

function runRow(row: RunRow, ui: UiState, offers: RunActions | undefined): SafeHtml {
  const { repo, run } = row;
  const tip = tooltipOf(run);
  return html`<div class="run lrow${isOpen(repo, run, ui) ? ' sel' : ''}${cur(row.id, ui)}" data-row="${row.id}"><button class="r-open"${
    tip === undefined ? '' : html` title="${tip}"`
  } data-action="select-run" data-repo="${repo}" data-run="${run.runId}"><span class="r-line">${statusMark(repo, run, ui)}<span class="r-id">${runLabel(run)}</span><span class="r-title">${run.title}</span><span class="r-wf">${repo} › ${workflowOf(run)}</span>${
    run.status === 'running' && run.stalled !== undefined
      ? html`<span class="stalled">stalled ${run.stalled}</span>`
      : ''
  }<span class="r-el">${duration(run.durationMs)}</span><span class="r-cost">${cost(run.costUsd)}</span>${
    run.stopReason === undefined ? '' : html`<span class="why">${run.stopReason}</span>`
  }</span>${run.problem === undefined ? '' : html`<span class="r-problem">${run.problem}</span>`}</button>${more(repo, run, ui)}</div>${runMenu(repo, run, ui, offers)}`;
}

function queueRow(row: QueueRow, ui: UiState, now: number): SafeHtml {
  const id = queueId(row.repo, row.workflow);
  const sel = `${ui.queue === id ? ' sel' : ''}${cur(row.id, ui)}`;
  // A queue that can't be read has nothing to count: its problem wraps inside its row in place of its waiting count.
  if (row.problem !== undefined) {
    return html`<button class="q-row bad${sel}" data-row="${row.id}" data-action="select-queue" data-queue="${id}"><span class="qd"></span><span class="nm">${row.repo} › ${row.workflow}</span>${watchWord(row.watch)}<span class="n">unreadable</span><span class="r-problem">${row.problem}</span></button>`;
  }
  return html`<button class="q-row${sel}" data-row="${row.id}"${
    row.lastPolledAt === undefined ? '' : html` title="polled ${ago(row.lastPolledAt, now)}"`
  } data-action="select-queue" data-queue="${id}"><span class="qd"></span><span class="nm">${row.repo} › ${row.workflow}</span>${watchWord(row.watch)}<span class="n">${row.waiting} waiting</span></button>`;
}

const rowOf = (row: ListRow, ui: UiState, now: number, offers: RunActions | undefined): SafeHtml =>
  row.kind === 'run' ? runRow(row, ui, offers) : queueRow(row, ui, now);

/** A Queues group's header row: the repository, its watch buttons and its problem. */
function repoHeader(group: ListGroup, repo: ListRepo, open: boolean, ui: UiState): SafeHtml {
  return html`<div class="lgrp-row${cur(group.id, ui)}"><button class="lgh${open ? ' open' : ''}"${
    repo.remote === null ? '' : html` title="${repo.remote}"`
  } data-action="toggle-list-group" data-group="${group.id}" aria-expanded="${open ? 'true' : 'false'}"><span class="lcaret">›</span><span class="nm">${group.label}</span><span class="c">${group.rows.length}</span></button>${watchButtons(repo.name, repo.offers, ui)}</div>${
    repo.problem === undefined ? '' : html`<div class="lgrp-p">${repo.problem}</div>`
  }`;
}

function groupBlock(group: ListGroup, ui: UiState, now: number, offers: RunActions | undefined): SafeHtml {
  const open = !ui.listFolded.includes(group.id);
  const head =
    group.repo === undefined
      ? html`<button class="lgh${open ? ' open' : ''}${cur(group.id, ui)}" data-action="toggle-list-group" data-group="${group.id}" aria-expanded="${open ? 'true' : 'false'}"><span class="lcaret">›</span><span class="nm">${group.label}</span><span class="c">${group.rows.length}</span></button>`
      : repoHeader(group, group.repo, open, ui);
  return html`<div class="lgrp">${head}${open ? group.rows.map((row) => rowOf(row, ui, now, offers)) : ''}</div>`;
}

const EMPTY: Record<ViewName, string> = {
  active: 'no live run',
  queues: 'no queue',
  history: 'no finished run',
};

const total = (groups: readonly ListGroup[]) => groups.reduce((sum, group) => sum + group.rows.length, 0);

/**
 * The list of the open view from the index model. `now` is ms since the epoch, for how long ago a queue was polled.
 * `offers` is what the open run offers, for its ⋯ menu: undefined until its actions are read.
 */
export function renderList(
  view: ViewName,
  repos: readonly ListRepo[],
  ui: UiState,
  now: number,
  offers?: RunActions | undefined,
): SafeHtml {
  const all = groupsOf(view, repos, ui.repoFilter);
  const shown = filterRows(all, ui.listFilter);
  const narrowed = ui.listFilter.trim() !== '';
  const count = narrowed ? `${total(shown)} of ${total(all)}` : String(total(all));
  const head = html`<div class="list-h"><span class="lh-t">${VIEW_LABELS[view]}</span><span class="c">${count}</span><input class="list-f" name="list-filter" type="search" value="${ui.listFilter}" placeholder="filter (/)" aria-label="filter the list" autocomplete="off" spellcheck="false"></div>`;
  const empty =
    repos.length === 0
      ? 'no repository is registered yet: run sail watch in one'
      : narrowed && shown.length === 0
        ? 'nothing matches'
        : EMPTY[view];
  const empties = view === 'queues' ? shown.length === 0 : total(shown) === 0;
  return html`${head}${empties ? html`<div class="qempty">${empty}</div>` : ''}${shown.map((group) => groupBlock(group, ui, now, offers))}`;
}
