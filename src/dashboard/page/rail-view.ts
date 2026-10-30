// The rail: every registered repository, each with its workflows, each with its runs, newest first. A repository and a
// workflow fold away when the person closes them. A watched workflow's queue is a row of its own, which opens the queue
// in the centre. Failed runs fold into a counted `failed` section and completed ones into a `completed` section, each
// open when the person opened it, so a long tail of finished runs never buries live work. Whatever is folded, the open
// run's row and the open queue's row stay in sight under it, so the selection is never hidden. Above the tree, a
// `running` block lists every live run of every repository and a `queued` block every workflow with work waiting.
import { ago, cost, duration } from './format';
import { html, type SafeHtml } from './html';
import { newestFirst, type RailRepo, type RailRun, type RailWorkflow, workflowOf } from './index-model';
import { queueId } from './queue-view';
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

function liveRow(repo: string, run: RailRun, ui: UiState): SafeHtml {
  const tip = tooltipOf(run);
  const facts = [duration(run.durationMs), cost(run.costUsd)].join(' · ');
  return html`<button class="run live-run${isOpen(repo, run, ui) ? ' sel' : ''}"${
    tip === undefined ? '' : html` title="${tip}"`
  } data-action="select-run" data-repo="${repo}" data-run="${run.runId}">
<span class="r-main"><span class="r-line"><span class="st ${pillOf(run.status)}"></span><span class="r-id">${runLabel(run)}</span>${
    run.title === undefined ? '' : html` <span class="r-title">${run.title}</span>`
  }</span><span class="r-sub">${repo} › ${workflowOf(run)} · ${facts}${
    run.stopReason === undefined ? '' : html` · <span class="why">${run.stopReason}</span>`
  }</span>${run.problem === undefined ? '' : html`<span class="r-problem">${run.problem}</span>`}</span></button>`;
}

function runningBlock(repos: readonly RailRepo[], ui: UiState): SafeHtml {
  const live = newestFirst(
    repos.flatMap((repo) => repo.runs.filter(isLive).map((run) => ({ ...run, repo: repo.name }))),
  );
  if (live.length === 0) return html``;
  return html`<div class="rail-h"><span>running</span><span class="c">${live.length}</span></div>
${live.map(({ repo, ...run }) => liveRow(repo, run, ui))}`;
}

function queuedBlock(repos: readonly RailRepo[], ui: UiState, now: number): SafeHtml {
  const rows = repos.flatMap((repo) =>
    repo.workflows.flatMap((workflow) =>
      workflow.queue !== undefined && workflow.queue.waiting > 0
        ? [{ repo: repo.name, workflow: workflow.name, queue: workflow.queue }]
        : [],
    ),
  );
  if (rows.length === 0) return html``;
  const total = rows.reduce((sum, row) => sum + row.queue.waiting, 0);
  return html`<div class="rail-h"><span>queued</span><span class="c">${total}</span></div>
${rows.map(({ repo, workflow, queue }) => {
  const id = queueId(repo, workflow);
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

function historyRow(repo: string, run: RailRun, ui: UiState): SafeHtml {
  const tip = cost(run.costUsd);
  return html`<button class="run hist-run${isOpen(repo, run, ui) ? ' sel' : ''}" title="${tip}" data-action="select-run" data-repo="${repo}" data-run="${run.runId}">
<span class="st ${pillOf(run.status)}"></span><span class="r-id">${runLabel(run)}</span>${
    run.title === undefined ? '' : html` <span class="r-title">${run.title}</span>`
  }<span class="r-el">${duration(run.durationMs)}</span></button>`;
}

function historyLine(repo: string, group: string, runs: RailRun[], ui: UiState): SafeHtml {
  const parts = SECTIONS.map((which) => ({ which, held: runs.filter(which.holds) })).filter(
    ({ held }) => held.length > 0,
  );
  if (parts.length === 0) return html``;
  const toggles = parts.map(({ which, held }) => {
    const id = `${group}:${which.name}`;
    return html`<button class="hist-t${ui.open.includes(id) ? ' open' : ''}" data-action="toggle-section" data-section="${id}">${which.label(held.length)}</button>`;
  });
  const rows = parts.flatMap(({ which, held }) =>
    (ui.open.includes(`${group}:${which.name}`) ? held : held.filter((run) => isOpen(repo, run, ui))).map((run) =>
      historyRow(repo, run, ui),
    ),
  );
  return html`<div class="hist">${toggles}</div>
${rows}`;
}

/** What a folded workflow still shows: the open finished run's row. A live open run is in the running block. */
function openRun(repo: string, workflow: RailWorkflow, ui: UiState): SafeHtml {
  return html`${workflow.runs.filter((run) => finished(run) && isOpen(repo, run, ui)).map((run) => historyRow(repo, run, ui))}`;
}

function counts(runs: readonly RailRun[]): SafeHtml {
  const live = runs.filter(isLive).length;
  const failed = runs.filter((run) => run.status === 'failed').length;
  return html`<span class="counts">${live === 0 ? '' : html`<span class="r">▶ ${live}</span>`}${
    failed === 0 ? '' : html`<span class="f">✗ ${failed}</span>`
  }${runs.length === 0 ? '' : html`<span>${runs.length}</span>`}</span>`;
}

function badge(group: string, queue: NonNullable<RailWorkflow['queue']>, ui: UiState, now: number): SafeHtml {
  const tip = queue.lastPolledAt === undefined ? '' : html` title="polled ${ago(queue.lastPolledAt, now)}"`;
  const sel = ui.queue === group ? ' sel' : '';
  return html`<button class="qbadge ${queue.waiting > 0 ? 'warn' : 'idle'}${sel}"${tip} data-action="select-queue" data-queue="${group}">${
    queue.waiting > 0 ? `${queue.waiting} queued` : 'queue'
  }</button>`;
}

function workflowHeader(workflow: RailWorkflow, group: string, open: boolean, ui: UiState, now: number): SafeHtml {
  return html`<div class="wf-h"><button class="wf-t${open ? ' open' : ''}" data-action="toggle-group" data-group="${group}"><span class="caret">›</span><span class="nm">${workflow.name}</span></button>${
    workflow.queue === undefined ? '' : badge(group, workflow.queue, ui, now)
  }${counts(workflow.runs)}</div>`;
}

function workflowGroup(repo: string, workflow: RailWorkflow, ui: UiState, now: number): SafeHtml {
  const group = queueId(repo, workflow.name);
  const open = ui.expanded.includes(group);
  return html`<div class="wf">${workflowHeader(workflow, group, open, ui, now)}
${open ? historyLine(repo, group, workflow.runs, ui) : openRun(repo, workflow, ui)}</div>`;
}

/** What a folded repository still shows: the open queue's workflow header and the open finished run's row. */
function repoSelection(repo: RailRepo, ui: UiState, now: number): SafeHtml {
  return html`${repo.workflows.map((workflow) => {
    const group = queueId(repo.name, workflow.name);
    const header =
      workflow.queue !== undefined && ui.queue === group
        ? html`<div class="wf">${workflowHeader(workflow, group, false, ui, now)}</div>`
        : '';
    return html`${header}${openRun(repo.name, workflow, ui)}`;
  })}`;
}

function repoGroup(repo: RailRepo, ui: UiState, now: number): SafeHtml {
  const open = ui.expanded.includes(repo.name);
  return html`<div class="lgrp">
<button class="lgrp-h${open ? ' open' : ''}"${
    repo.remote === null ? '' : html` title="${repo.remote}"`
  } data-action="toggle-group" data-group="${repo.name}"><span class="caret">›</span><span class="nm">${repo.name}</span>${counts(repo.runs)}</button>
${repo.problem === undefined ? '' : html`<div class="lgrp-p">${repo.problem}</div>`}
${open ? repo.workflows.map((workflow) => workflowGroup(repo.name, workflow, ui, now)) : repoSelection(repo, ui, now)}</div>`;
}

/** The rail from the index model. `now` is ms since the epoch, for how long ago a queue was polled. */
export function renderRail(repos: readonly RailRepo[], ui: UiState, now: number): SafeHtml {
  const runs = repos.reduce((sum, repo) => sum + repo.runs.length, 0);
  return html`${runningBlock(repos, ui)}${queuedBlock(repos, ui, now)}<div class="rail-h"><span>repositories</span><span class="c">${runs} runs</span></div>
${repos.length === 0 ? html`<div class="qempty">no repository is registered yet: run sail watch in one</div>` : ''}${repos.map((repo) => repoGroup(repo, ui, now))}`;
}
