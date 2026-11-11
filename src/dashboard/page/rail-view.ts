// The rail, in three blocks. `running` lists every live run of every repository, newest first, and `queued` every
// watched workflow with work waiting, and every queue that can't be read, with its problem, each row opening its queue in the centre. Under them, the `repositories` tree:
// each repository with its workflows, every one folded until the person opens it. A watched workflow's header carries a
// queue badge that opens its queue. An open workflow shows a history line, whose `failed` and `done` parts each open
// that status's finished runs, so a long tail of them never buries live work. Whatever is folded, the open run's row
// and the open queue's workflow stay in sight under it, so the selection is never hidden. A workflow's header also
// carries its watch state as a word, the live watcher's, which its queue view's pill reads too, and its Watch or Unwatch, which is never disabled, since a watch with no live watcher starts one; and an opened repository a row with Watch all and, while its watch set isn't empty,
// Unwatch all; an Unwatch armed by a first click reads `click again`. The answer to the last change shows under the
// repository's header. A run's row is a `div` holding two sibling buttons: its own, which opens the run, and, but on
// a completed run, a ⋯ of its own that opens the run and, under the row, a menu of what it offers: Resume, Restart,
// Stop and Clean.
import type { RunActions } from '../actions';
import { ago, cost, duration } from './format';
import { html, type SafeHtml } from './html';
import { newestFirst, type RailRepo, type RailRun, type RailWorkflow, workflowOf } from './index-model';
import { queueId } from './queue-view';
import { runControls } from './run-view';
import { pillOf, type UiState } from './ui-state';

/** Whether `run` of `repo` is the open run: not while a queue holds the centre. */
const isOpen = (repo: string, run: RailRun, ui: UiState) =>
  ui.queue === undefined && ui.repo === repo && ui.runId === run.runId;

/** Live means neither failed nor completed: running, suspended, blocked or unknown. */
const isLive = (run: RailRun) => run.status !== 'failed' && run.status !== 'completed';

/** The ID a run is listed by: its pull request, else its ticket key, else its run id. */
const runLabel = (run: RailRun) => (run.pr === undefined ? (run.ticketKey ?? run.runId) : `PR #${run.pr}`);

/** The full title, led by the run id for a pull-request run. */
const tooltipOf = (run: RailRun): string | undefined =>
  run.pr === undefined ? run.title : run.title === undefined ? run.runId : `${run.runId} · ${run.title}`;

/** Whether `run`'s menu is open: only the open run's can be. */
const isMenuOpen = (repo: string, run: RailRun, ui: UiState) => isOpen(repo, run, ui) && ui.runMenu === run.runId;

/** A row's ⋯: on any run but a completed one, which offers nothing. */
function more(repo: string, run: RailRun, ui: UiState): SafeHtml | '' {
  if (run.status === 'completed') return '';
  return html`<button class="r-more${isMenuOpen(repo, run, ui) ? ' open' : ''}" type="button" data-action="run-menu" data-repo="${repo}" data-run="${run.runId}" aria-label="actions for ${run.runId}" aria-expanded="${isMenuOpen(repo, run, ui) ? 'true' : 'false'}" title="actions for ${run.runId}">⋯</button>`;
}

/** The open menu under `run`'s row: what the run offers, once its actions are read. */
function runMenu(repo: string, run: RailRun, ui: UiState, offers: RunActions | undefined): SafeHtml | '' {
  if (!isMenuOpen(repo, run, ui)) return '';
  const controls = runControls(offers, ui);
  if (controls !== undefined) return html`<div class="r-menu">${controls}</div>`;
  const why = offers === undefined ? 'reading what the run offers…' : (offers.why ?? 'the run offers nothing');
  return html`<div class="r-menu"><span class="act-why">${why}</span></div>`;
}

function liveRow(repo: string, run: RailRun, ui: UiState, offers: RunActions | undefined): SafeHtml {
  const tip = tooltipOf(run);
  const facts = [duration(run.durationMs), cost(run.costUsd)].join(' · ');
  return html`<div class="run live-run${isOpen(repo, run, ui) ? ' sel' : ''}"><button class="r-open"${
    tip === undefined ? '' : html` title="${tip}"`
  } data-action="select-run" data-repo="${repo}" data-run="${run.runId}">
<span class="r-main"><span class="r-line"><span class="st ${pillOf(run.status)}"></span><span class="r-id">${runLabel(run)}</span>${
    run.title === undefined ? '' : html` <span class="r-title">${run.title}</span>`
  }</span><span class="r-sub">${repo} › ${workflowOf(run)}${
    run.status === 'running' && run.stalled !== undefined
      ? html` · <span class="stalled">stalled ${run.stalled}</span>`
      : ''
  } · ${facts}${
    run.stopReason === undefined ? '' : html` · <span class="why">${run.stopReason}</span>`
  }</span>${run.problem === undefined ? '' : html`<span class="r-problem">${run.problem}</span>`}</span></button>${more(repo, run, ui)}</div>${runMenu(repo, run, ui, offers)}`;
}

function runningBlock(repos: readonly RailRepo[], ui: UiState, offers: RunActions | undefined): SafeHtml {
  const live = newestFirst(
    repos.flatMap((repo) => repo.runs.filter(isLive).map((run) => ({ ...run, repo: repo.name }))),
  );
  if (live.length === 0) return html``;
  return html`<div class="rail-h"><span>running</span><span class="c">${live.length}</span></div>
${live.map(({ repo, ...run }) => liveRow(repo, run, ui, offers))}`;
}

function queuedBlock(repos: readonly RailRepo[], ui: UiState, now: number): SafeHtml {
  const rows = repos.flatMap((repo) =>
    repo.workflows.flatMap((workflow) =>
      workflow.queue !== undefined && ((workflow.queue.waiting ?? 0) > 0 || workflow.queue.problem !== undefined)
        ? [{ repo: repo.name, workflow: workflow.name, queue: workflow.queue }]
        : [],
    ),
  );
  if (rows.length === 0) return html``;
  const total = rows.reduce((sum, row) => sum + (row.queue.waiting ?? 0), 0);
  return html`<div class="rail-h"><span>queued</span><span class="c">${total}</span></div>
${rows.map(({ repo, workflow, queue }) => {
  const id = queueId(repo, workflow);
  if (queue.problem !== undefined) {
    return html`<button class="q-row bad${ui.queue === id ? ' sel' : ''}" data-action="select-queue" data-queue="${id}"><span class="qd"></span><span class="nm">${repo} › ${workflow}</span><span class="n">unreadable</span><span class="r-problem">${queue.problem}</span></button>`;
  }
  return html`<button class="q-row${ui.queue === id ? ' sel' : ''}"${
    queue.lastPolledAt === undefined ? '' : html` title="polled ${ago(queue.lastPolledAt, now)}"`
  } data-action="select-queue" data-queue="${id}"><span class="qd"></span><span class="nm">${repo} › ${workflow}</span><span class="n">${queue.waiting} waiting</span></button>`;
})}`;
}

/** The sections finished runs fold into behind the history line, in the order they are listed. */
const SECTIONS = [
  { name: 'failed', label: (n: number) => `✗ ${n} failed`, holds: (run: RailRun) => run.status === 'failed' },
  { name: 'completed', label: (n: number) => `✓ ${n} done ›`, holds: (run: RailRun) => run.status === 'completed' },
] as const;

const finished = (run: RailRun) => SECTIONS.some((each) => each.holds(run));

function historyRow(repo: string, run: RailRun, ui: UiState, offers: RunActions | undefined): SafeHtml {
  const tip = cost(run.costUsd);
  return html`<div class="run hist-run${isOpen(repo, run, ui) ? ' sel' : ''}"><button class="r-open" title="${tip}" data-action="select-run" data-repo="${repo}" data-run="${run.runId}">
<span class="st ${pillOf(run.status)}"></span><span class="r-id">${runLabel(run)}</span>${
    run.title === undefined ? '' : html` <span class="r-title">${run.title}</span>`
  }<span class="r-el">${duration(run.durationMs)}</span></button>${more(repo, run, ui)}</div>${runMenu(repo, run, ui, offers)}`;
}

function historyLine(
  repo: string,
  group: string,
  runs: RailRun[],
  ui: UiState,
  offers: RunActions | undefined,
): SafeHtml {
  const parts = SECTIONS.map((which) => ({ which, held: runs.filter(which.holds) })).filter(
    ({ held }) => held.length > 0,
  );
  if (parts.length === 0) return html``;
  const toggles = parts.map(({ which, held }) => {
    const id = `${group}:${which.name}`;
    return html`<button class="hist-t${ui.open.includes(id) ? ' open' : ''}" data-action="toggle-section" data-section="${id}" aria-expanded="${ui.open.includes(id) ? 'true' : 'false'}">${which.label(held.length)}</button>`;
  });
  const rows = parts.flatMap(({ which, held }) =>
    (ui.open.includes(`${group}:${which.name}`) ? held : held.filter((run) => isOpen(repo, run, ui))).map((run) =>
      historyRow(repo, run, ui, offers),
    ),
  );
  return html`<div class="hist">${toggles}</div>
${rows}`;
}

/** What a folded workflow still shows: the open finished run's row. A live open run is in the running block. */
function openRun(repo: string, workflow: RailWorkflow, ui: UiState, offers: RunActions | undefined): SafeHtml {
  return html`${workflow.runs.filter((run) => finished(run) && isOpen(repo, run, ui)).map((run) => historyRow(repo, run, ui, offers))}`;
}

function counts(runs: readonly RailRun[]): SafeHtml {
  const live = runs.filter(isLive).length;
  const failed = runs.filter((run) => run.status === 'failed').length;
  return html`<span class="counts">${live === 0 ? '' : html`<span class="r">▶ ${live}</span>`}${
    failed === 0 ? '' : html`<span class="f">✗ ${failed}</span>`
  }${runs.length === 0 ? '' : html`<span>${runs.length}</span>`}</span>`;
}

function badge(group: string, queue: NonNullable<RailWorkflow['queue']>, ui: UiState, now: number): SafeHtml {
  const sel = ui.queue === group ? ' sel' : '';
  if (queue.problem !== undefined) {
    return html`<button class="qbadge bad${sel}" title="${queue.problem}" data-action="select-queue" data-queue="${group}">queue unreadable</button>`;
  }
  const waiting = queue.waiting ?? 0;
  const tip = queue.lastPolledAt === undefined ? '' : html` title="polled ${ago(queue.lastPolledAt, now)}"`;
  return html`<button class="qbadge ${waiting > 0 ? 'warn' : 'idle'}${sel}"${tip} data-action="select-queue" data-queue="${group}">${
    waiting > 0 ? `${waiting} queued` : 'queue'
  }</button>`;
}

/** A watch or unwatch button for a workflow, or for the whole repository when `workflow` is left out. An armed unwatch asks for its second click. */
function watchButton(repo: string, op: 'watch' | 'unwatch', ui: UiState, workflow?: string): SafeHtml {
  const all = workflow === undefined;
  const armed = op === 'unwatch' && ui.armedWatch === (all ? repo : queueId(repo, workflow));
  const word = all ? `${op} all` : op;
  return html`<button class="wf-act${armed ? ' armed' : ''}" data-action="watch-set" data-repo="${repo}" data-op="${op}"${
    all ? '' : html` data-workflow="${workflow}"`
  }>${armed ? `${word}? click again` : word}</button>`;
}

/** The workflow's watch state as a word: the live watcher's, the same one its queue view's pill reads. */
function watchWord(watch: RailWorkflow['watch']): SafeHtml | '' {
  if (watch === undefined) return '';
  if (watch.state === 'watched') return html`<span class="wf-watch on">watched</span>`;
  const kind = watch.state === 'not watched' ? 'off' : 'down';
  return html`<span class="wf-watch ${kind}" title="${watch.why ?? ''}">${watch.state}</span>`;
}

function workflowHeader(
  repo: string,
  workflow: RailWorkflow,
  group: string,
  open: boolean,
  ui: UiState,
  now: number,
): SafeHtml {
  return html`<div class="wf-h"><button class="wf-t${open ? ' open' : ''}" data-action="toggle-group" data-group="${group}" aria-expanded="${open ? 'true' : 'false'}"><span class="caret">›</span><span class="nm">${workflow.name}</span></button>${
    workflow.queue === undefined ? '' : badge(group, workflow.queue, ui, now)
  }${watchWord(workflow.watch)}${workflow.toggle === undefined ? '' : watchButton(repo, workflow.toggle, ui, workflow.name)}${counts(workflow.runs)}</div>`;
}

function workflowGroup(
  repo: string,
  workflow: RailWorkflow,
  ui: UiState,
  now: number,
  offers: RunActions | undefined,
): SafeHtml {
  const group = queueId(repo, workflow.name);
  const open = ui.expanded.includes(group);
  return html`<div class="wf">${workflowHeader(repo, workflow, group, open, ui, now)}
${open ? historyLine(repo, group, workflow.runs, ui, offers) : openRun(repo, workflow, ui, offers)}</div>`;
}

/** What a folded repository still shows: the open queue's workflow, folding as it would, and the open finished run's row. */
function repoSelection(repo: RailRepo, ui: UiState, now: number, offers: RunActions | undefined): SafeHtml {
  return html`${repo.workflows.map((workflow) =>
    workflow.queue !== undefined && ui.queue === queueId(repo.name, workflow.name)
      ? workflowGroup(repo.name, workflow, ui, now, offers)
      : openRun(repo.name, workflow, ui, offers),
  )}`;
}

function repoGroup(repo: RailRepo, ui: UiState, now: number, offers: RunActions | undefined): SafeHtml {
  const open = ui.expanded.includes(repo.name);
  return html`<div class="lgrp">
<button class="lgrp-h${open ? ' open' : ''}"${
    repo.remote === null ? '' : html` title="${repo.remote}"`
  } data-action="toggle-group" data-group="${repo.name}" aria-expanded="${open ? 'true' : 'false'}"><span class="caret">›</span><span class="nm">${repo.name}</span>${counts(repo.runs)}</button>
${repo.problem === undefined ? '' : html`<div class="lgrp-p">${repo.problem}</div>`}${
  ui.watchNotice?.repo === repo.name ? html`<div class="lgrp-p">${ui.watchNotice.text}</div>` : ''
}${
  open
    ? html`<div class="lgrp-acts">${watchButton(repo.name, 'watch', ui)}${
        (repo.watching ?? []).length > 0 ? watchButton(repo.name, 'unwatch', ui) : ''
      }</div>`
    : ''
}
${open ? repo.workflows.map((workflow) => workflowGroup(repo.name, workflow, ui, now, offers)) : repoSelection(repo, ui, now, offers)}</div>`;
}

/**
 * The rail from the index model. `now` is ms since the epoch, for how long ago a queue was polled. `offers` is what the
 * open run offers, for its ⋯ menu: undefined until its actions are read.
 */
export function renderRail(
  repos: readonly RailRepo[],
  ui: UiState,
  now: number,
  offers?: RunActions | undefined,
): SafeHtml {
  const runs = repos.reduce((sum, repo) => sum + repo.runs.length, 0);
  const notice =
    ui.indexNotice === undefined ? '' : html`<div class="act"><span class="warnchip">${ui.indexNotice}</span></div>`;
  return html`${notice}${runningBlock(repos, ui, offers)}${queuedBlock(repos, ui, now)}<div class="rail-h"><span>repositories</span><span class="c">${runs} runs</span></div>
${repos.length === 0 ? html`<div class="qempty">no repository is registered yet: run sail watch in one</div>` : ''}${repos.map((repo) => repoGroup(repo, ui, now, offers))}`;
}
