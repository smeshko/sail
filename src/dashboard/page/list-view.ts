// The list: the one component every view draws its rows on, in the centre. A head names the view with its count, which
// reads `n of m` while the filter field narrows it, and carries the field itself, on one line; History's head carries a
// second line of a status and a workflow control, which narrow it the same way, and `clean all failed` while a listed
// repository offers it, a line that, while History rows are selected, holds their count and a clean and a clear button
// instead; a selected row is drawn `picked`, with a tick. Under it, folding groups: Active's `waiting on you` and `running`, History's days, and
// in Queues one per repository, and the Inbox's one group each of runs, parked items and problems, whose rows lead with
// what they are about, then what happened and its detail, open their run (at its last call in error) or queue, the view
// staying Inbox, and carry a ✕ that dismisses them. A run's row is a `div` holding two sibling buttons: its own, which
// opens the run and shows on one line its status, id, title, stalled mark, duration and stop reason (amber, and red on
// a failed run), with a problem under it, two lines at most, its paths relative to the clone, and a ⋯ of its own that
// opens the run and a menu of what it offers: Resume, Restart, Stop and Clean. The menu is drawn inside its row and
// floats over the rows under it, pushing none down. A queue's row is a `div` holding its open button and, beside it,
// poll, watch and unwatch from the registry. The button names the live watcher's watch state, what waits, runs, failed
// and is parked (a zero count left out), when the queue was last polled, and a pause and a hold; a queue that can't be
// read shows its problem in place of its counts. A Queues group's header row, one line however long its repository's
// name, also carries the Watch all and Unwatch all the repository offers, drawn from the registry, and its problem; each
// runs at once, its answer is a toast, and while its request is out the buttons read the word under way, as a run's row
// reads it in place of its status. A folded group draws its header alone.
import type { RunActions } from '../actions';
import type { RepoOffers } from '../offers';
import { ACTIONS, actionOf, type OfferSource, type Subject } from './action-registry';
import { actionControl, subjectAttrs } from './action-view';
import { type AttentionItem, identity } from './attention';
import { ago, duration, fromClone } from './format';
import { html, type SafeHtml } from './html';
import type { ListRepo, ListRun } from './index-model';
import { withKey } from './keymap';
import {
  type AttentionRow,
  attentionSubject,
  groupsOf,
  historyWorkflows,
  type ListGroup,
  type ListRow,
  type QueueRow,
  type RunRow,
  selectedRows,
  shownGroups,
  type ViewName,
} from './list-model';
import { heldText, pausedText, queueId } from './queue-view';
import { runControls } from './run-view';
import { pillOf, type UiState } from './ui-state';

/** What each view is headed with. */
export const VIEW_LABELS: Record<ViewName, string> = {
  inbox: 'Inbox',
  active: 'Active',
  queues: 'Queues',
  history: 'History',
};

/** Whether `run` of `repo` is the open run: not while a queue holds the centre. */
export const isOpen = (repo: string, run: ListRun, ui: UiState) => isOpenRun(repo, run.runId, ui);

const isOpenRun = (repo: string, runId: string, ui: UiState) =>
  ui.queue === undefined && ui.repo === repo && ui.runId === runId;

/** The ID a run is listed by: its pull request, else its ticket key, else its run id. */
export const runLabel = (run: ListRun) => (run.pr === undefined ? (run.ticketKey ?? run.runId) : `PR #${run.pr}`);

/** The full title, led by the run id for a pull-request run. */
export const tooltipOf = (run: ListRun): string | undefined =>
  run.pr === undefined ? run.title : run.title === undefined ? run.runId : `${run.runId} · ${run.title}`;

/** Whether `run`'s menu is open: only the open run's can be. */
const isMenuOpen = (repo: string, run: ListRun, ui: UiState) =>
  isOpen(repo, run, ui) && ui.runMenu?.runId === run.runId && ui.runMenu.at === 'row';

/** A row's ⋯: on every run, a completed one included, which offers Restart. */
export function more(repo: string, run: ListRun, ui: UiState): SafeHtml | '' {
  return html`<button class="r-more${isMenuOpen(repo, run, ui) ? ' open' : ''}" type="button" data-action="run-menu" data-repo="${repo}" data-run="${run.runId}" aria-label="actions for ${run.runId}" aria-expanded="${isMenuOpen(repo, run, ui) ? 'true' : 'false'}" title="actions for ${run.runId}">⋯</button>`;
}

/** The open menu over the rows under `run`'s row: what the run offers, once its actions are read. */
export function runMenu(repo: string, run: ListRun, ui: UiState, offers: RunActions | undefined): SafeHtml | '' {
  if (!isMenuOpen(repo, run, ui)) return '';
  const controls = runControls(offers, ui);
  if (controls !== undefined) return html`<div class="r-menu">${controls}</div>`;
  const why = offers === undefined ? 'reading what the run offers…' : (offers.why ?? 'the run offers nothing');
  return html`<div class="r-menu"><span class="act-why">${why}</span></div>`;
}

/**
 * The repository's watch or unwatch button each offered, drawn from the registry, for all its workflows at once, or, given
 * a workflow, for that one alone, as a queue's row draws them. While a request for it is out, the word under way takes
 * their place. A queue view draws its workflow's own in its view header.
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

/** A problem under its row: its paths relative to the clone, two lines at most, the whole of it in its tooltip. */
const problemLine = (problem: string): SafeHtml =>
  html`<span class="r-problem" title="${problem}">${fromClone(problem)}</span>`;

function runRow(row: RunRow, ui: UiState, offers: RunActions | undefined): SafeHtml {
  const { repo, run } = row;
  const picked = ui.listSelected.includes(row.id);
  const tip = tooltipOf(run);
  return html`<div class="run lrow${isOpen(repo, run, ui) ? ' sel' : ''}${picked ? ' picked' : ''}${cur(row.id, ui)}" data-row="${row.id}"${picked ? html` aria-selected="true"` : ''}${subjectAttrs({ kind: 'run', repo, runId: run.runId })}><button class="r-open"${
    tip === undefined ? '' : html` title="${tip}"`
  } data-action="select-run" data-repo="${repo}" data-run="${run.runId}"><span class="r-line">${
    picked ? html`<span class="r-tick" aria-hidden="true">✓</span>` : ''
  }${statusMark(repo, run, ui)}<span class="r-id">${runLabel(run)}</span><span class="r-title">${run.title}</span>${
    run.status === 'running' && run.stalled !== undefined
      ? html`<span class="stalled">stalled ${run.stalled}</span>`
      : ''
  }<span class="r-el">${duration(run.durationMs)}</span>${
    run.stopReason === undefined
      ? ''
      : html`<span class="why${run.status === 'failed' ? ' fail' : ''}">${run.stopReason}</span>`
  }</span>${run.problem === undefined ? '' : problemLine(run.problem)}</button>${more(repo, run, ui)}${runMenu(repo, run, ui, offers)}</div>`;
}

/** The ` · ` free chips of a queue's row: its pause and its hold, in the words its queue view uses. */
function queueChips(row: QueueRow, ui: UiState): SafeHtml {
  const { paused, held } = row;
  return html`${paused === undefined ? '' : html`<span class="warnchip">${pausedText(paused)}</span>`}${
    held === undefined ? '' : html`<span class="warnchip">${heldText(held, ui.tz)}</span>`
  }`;
}

/** A queue row's poll, then its workflow's watch or unwatch: each drawn from the registry, the poll only when offered. */
function queueActions(row: QueueRow, ui: UiState, repoOffers: RepoOffers | undefined): SafeHtml {
  const subject: Subject = { kind: 'workflow', repo: row.repo, workflow: row.workflow };
  const def = actionOf('poll-queue');
  const source: OfferSource = { index: [{ name: row.repo, queues: [{ workflow: row.workflow, offers: row.offers }] }] };
  const available = def?.available(subject, source);
  const underway = ui.underway[`queue:${row.repo}/${row.workflow}`];
  const poll =
    def === undefined || available === undefined || !available.offered
      ? ''
      : underway !== undefined
        ? html`<span class="busy">${underway}</span>`
        : available.enabled
          ? actionControl(def, subject, ui.act, source, { class: 'wf-act', data: true, title: 'poll now' })
          : html`<button class="wf-act" disabled title="${available.why}">poll</button>`;
  return html`${poll}${watchButtons(row.repo, repoOffers, ui, row.workflow)}`;
}

function queueRow(row: QueueRow, ui: UiState, now: number, repoOffers: RepoOffers | undefined): SafeHtml {
  const id = queueId(row.repo, row.workflow);
  const sel = `${ui.queue === id ? ' sel' : ''}${cur(row.id, ui)}`;
  const name = html`<span class="qd"></span><span class="nm">${row.repo} › ${row.workflow}</span>${watchWord(row.watch)}`;
  // A queue that can't be read has nothing to count: its problem wraps inside its row in place of the counts.
  const body =
    row.problem !== undefined
      ? html`${name}<span class="n">unreadable</span>${problemLine(row.problem)}`
      : html`${name}<span class="n">${row.waiting} waiting</span>${(['running', 'failed', 'parked'] as const).map(
          (state) => (row[state] === undefined ? '' : html`<span class="q-c ${state}">${row[state]} ${state}</span>`),
        )}<span class="q-polled">${row.lastPolledAt === undefined ? 'never polled' : `polled ${ago(row.lastPolledAt, now)}`}</span>${queueChips(row, ui)}`;
  return html`<div class="q-row${row.problem === undefined ? '' : ' bad'}${sel}" data-row="${row.id}"${subjectAttrs({ kind: 'workflow', repo: row.repo, workflow: row.workflow })}><button class="q-open" data-action="select-queue" data-queue="${id}">${body}</button>${queueActions(row, ui, repoOffers)}</div>`;
}

/** An Inbox row: what needs attention, opening its run (at its call in error) or its queue, the view staying Inbox. */
function attentionRow(row: AttentionRow, ui: UiState): SafeHtml {
  const { item } = row;
  const { opens } = item;
  const queue = item.workflow === undefined ? undefined : queueId(row.repo, item.workflow);
  const sel = opens === undefined ? queue !== undefined && ui.queue === queue : isOpenRun(opens.repo, opens.runId, ui);
  // It leads with what it is about, quiet as a list row's ID, then what happened, then the detail, each cut short.
  const body = html`<span class="r-line"><span class="r-id">${item.about}</span><b class="r-title">${item.title}</b>${
    item.detail === '' || item.kind === 'problem'
      ? ''
      : html`<span class="r-detail" title="${item.detail}">${item.detail}</span>`
  }</span>${item.kind === 'problem' ? problemLine(item.detail) : ''}`;
  const open =
    opens !== undefined
      ? html`<button class="r-open" data-action="open" data-repo="${opens.repo}" data-run="${opens.runId}"${
          opens.key === undefined ? '' : html` data-key="${opens.key}"`
        }>${body}</button>`
      : queue !== undefined
        ? html`<button class="r-open" data-action="select-queue" data-queue="${queue}">${body}</button>`
        : html`<div class="r-open">${body}</div>`;
  return html`<div class="lrow in-row in-${item.kind}${sel ? ' sel' : ''}${cur(row.id, ui)}" data-row="${row.id}"${subjectAttrs(attentionSubject(row))}>${open}<button class="r-dismiss" type="button" data-action="dismiss-attention" data-item="${identity(item)}" aria-label="dismiss" title="${withKey('dismiss', actionOf('dismiss-attention')?.key)}">✕</button></div>`;
}

const rowOf = (
  row: ListRow,
  ui: UiState,
  now: number,
  offers: RunActions | undefined,
  repoOffers: RepoOffers | undefined,
): SafeHtml =>
  row.kind === 'attention'
    ? attentionRow(row, ui)
    : row.kind === 'run'
      ? runRow(row, ui, offers)
      : queueRow(row, ui, now, repoOffers);

/** A Queues group's header row: the repository, its watch buttons and its problem. */
function repoHeader(group: ListGroup, repo: ListRepo, open: boolean, ui: UiState): SafeHtml {
  return html`<div class="lgrp-row${cur(group.id, ui)}"${subjectAttrs({ kind: 'repo', repo: repo.name })}><button class="lgh${open ? ' open' : ''}"${
    repo.remote === null ? '' : html` title="${repo.remote}"`
  } data-action="toggle-list-group" data-group="${group.id}" aria-expanded="${open ? 'true' : 'false'}"><span class="lcaret">›</span><span class="nm" title="${group.label}">${group.label}</span><span class="c">${group.rows.length}</span></button>${watchButtons(repo.name, repo.offers, ui)}</div>${
    repo.problem === undefined ? '' : html`<div class="lgrp-p">${repo.problem}</div>`
  }`;
}

function groupBlock(group: ListGroup, ui: UiState, now: number, offers: RunActions | undefined): SafeHtml {
  const open = !ui.listFolded.includes(group.id);
  const head =
    group.repo === undefined
      ? html`<button class="lgh${open ? ' open' : ''}${cur(group.id, ui)}" data-action="toggle-list-group" data-group="${group.id}" aria-expanded="${open ? 'true' : 'false'}"><span class="lcaret">›</span><span class="nm">${group.label}</span><span class="c">${group.rows.length}</span></button>`
      : repoHeader(group, group.repo, open, ui);
  return html`<div class="lgrp">${head}${open ? group.rows.map((row) => rowOf(row, ui, now, offers, group.repo?.offers)) : ''}</div>`;
}

export const EMPTY: Record<ViewName, string> = {
  inbox: 'nothing needs attention',
  active: 'no live run',
  queues: 'no queue',
  history: 'no finished run',
};

const option = (value: string, label: string, chosen: boolean) =>
  html`<option value="${value}"${chosen ? html` selected` : ''}>${label}</option>`;

/** History's two controls: status and workflow. The workflow chosen stays an option when no run has it now. */
function historyControls(repos: readonly ListRepo[], ui: UiState): SafeHtml {
  const workflows = historyWorkflows(repos, ui.repoFilter);
  const chosen = ui.historyWorkflow;
  if (chosen !== undefined && !workflows.includes(chosen)) workflows.push(chosen);
  return html`<select class="list-s" name="list-status" aria-label="filter by status">${option('', 'any status', ui.historyStatus === undefined)}${option('failed', 'failed', ui.historyStatus === 'failed')}${option('completed', 'done', ui.historyStatus === 'completed')}</select><select class="list-s" name="list-workflow" aria-label="filter by workflow">${option('', 'any workflow', chosen === undefined)}${workflows.map((name) => option(name, name, name === chosen))}</select>`;
}

/**
 * History's `clean all failed`, in its head: the repository's while the sidebar filters on one, else every listed
 * repository's. Drawn only when a listed repository offers it; while its request is out the word under way takes the
 * button's place.
 */
function cleanFailed(repos: readonly ListRepo[], ui: UiState): SafeHtml | '' {
  const subject: Subject = ui.repoFilter === undefined ? { kind: 'none' } : { kind: 'repo', repo: ui.repoFilter };
  const def = actionOf('clean-failed');
  if (def === undefined) return '';
  const source: OfferSource = { index: repos.map((repo) => ({ name: repo.name, queues: [], offers: repo.offers })) };
  const underway = ui.underway[subject.kind === 'repo' ? `clean:${subject.repo}` : 'clean:*'];
  if (underway !== undefined) return html`<span class="busy">${underway}</span>`;
  return actionControl(def, subject, ui.act, source, { class: 'btn', data: true });
}

/** What the head says of the selection: its count and a button that clears it, drawn only while a row is selected. */
const selectionHead = (count: number, checking: string | undefined): SafeHtml =>
  count === 0
    ? html``
    : html`<span class="lh-sel">${count} selected</span>${
        checking === undefined
          ? html`<button class="btn" data-action="clean-selected">clean</button>`
          : html`<span class="busy">${checking}</span>`
      }<button class="btn" data-action="clear-selection">clear</button>`;

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
  inbox: readonly AttentionItem[] = [],
): SafeHtml {
  const all = groupsOf(view, repos, ui.repoFilter, { now, tz: ui.tz }, inbox);
  const shown = shownGroups(view, repos, ui, now, inbox);
  const narrowed =
    ui.listFilter.trim() !== '' ||
    (view === 'history' && (ui.historyStatus !== undefined || ui.historyWorkflow !== undefined));
  const count = narrowed ? `${total(shown)} of ${total(all)}` : String(total(all));
  const clear =
    view === 'inbox' && total(shown) > 0
      ? html`<button class="btn" type="button" data-action="clear-attention" title="${withKey('dismiss all', actionOf('clear-attention')?.key)}">all clear</button>`
      : '';
  // One row of the view's name, count and filter field; History's controls on a second, which the Selection's count and
  // buttons take while rows are selected, so the head never grows a third. The count in the first says what the
  // filters narrow meanwhile.
  const picked = view === 'history' ? selectedRows(shown, ui.listSelected).length : 0;
  const controls =
    view !== 'history'
      ? ''
      : picked > 0
        ? html`<div class="lh-row lh-ctl">${selectionHead(picked, ui.underway.selection)}</div>`
        : html`<div class="lh-row lh-ctl">${historyControls(repos, ui)}<span class="lh-end">${cleanFailed(repos, ui)}</span></div>`;
  const head = html`<div class="list-h"><div class="lh-row"><span class="lh-t">${VIEW_LABELS[view]}</span><span class="c">${count}</span>${clear}<input class="list-f" name="list-filter" type="search" value="${ui.listFilter}" placeholder="filter (/)" aria-label="filter the list" autocomplete="off" spellcheck="false"></div>${controls}</div>`;
  const empty =
    repos.length === 0
      ? 'no repository is registered yet: run sail watch in one'
      : narrowed && shown.length === 0
        ? 'nothing matches'
        : EMPTY[view];
  const empties = view === 'queues' ? shown.length === 0 : total(shown) === 0;
  return html`${head}${empties ? html`<div class="qempty">${empty}</div>` : ''}${shown.map((group) => groupBlock(group, ui, now, offers))}`;
}
