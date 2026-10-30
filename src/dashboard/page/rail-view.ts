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

function runRow(repo: string, run: RailRun, ui: UiState): SafeHtml {
  const selected = isOpen(repo, run, ui);
  const facts = [duration(run.durationMs), cost(run.costUsd)].join(' · ');
  return html`<button class="run${selected ? ' sel' : ''}" data-action="select-run" data-repo="${repo}" data-run="${run.runId}">
<span class="st ${pillOf(run.status)}"></span><span class="r-main"><span class="r-id">${run.ticketKey ?? run.runId}</span>${
    run.title === undefined ? '' : html` <span class="r-title">${run.title}</span>`
  }<span class="r-sub">${run.status}${run.stopReason === undefined ? '' : html` · <span class="why">${run.stopReason}</span>`} · ${facts}</span>${
    run.problem === undefined ? '' : html`<span class="r-problem">${run.problem}</span>`
  }</span></button>`;
}

/** The sections finished runs fold into, in the order they are listed, with the swatch each is drawn with. */
const SECTIONS = [
  { name: 'failed', pill: 'p-fail', holds: (run: RailRun) => run.status === 'failed' },
  { name: 'completed', pill: 'p-pass', holds: (run: RailRun) => run.status === 'completed' },
] as const;

function section(repo: string, group: string, runs: RailRun[], which: (typeof SECTIONS)[number], ui: UiState) {
  const held = runs.filter(which.holds);
  if (held.length === 0) return html``;
  const id = `${group}:${which.name}`;
  const open = ui.open.includes(id);
  const shown = open ? held : held.filter((run) => isOpen(repo, run, ui));
  return html`<button class="subgrp-h${open ? ' open' : ''}" data-action="toggle-section" data-section="${id}"><span class="caret">›</span><span class="sw ${which.pill}"></span><span>${which.name}</span><span class="n">${held.length}</span></button>
${shown.map((run) => runRow(repo, run, ui))}`;
}

function queueRow(group: string, queue: NonNullable<RailWorkflow['queue']>, ui: UiState, now: number): SafeHtml {
  const polled = queue.lastPolledAt === undefined ? '' : ` · polled ${ago(queue.lastPolledAt, now)}`;
  return html`<button class="wf-q${ui.queue === group ? ' sel' : ''}" data-action="select-queue" data-queue="${group}"><span class="qd"></span><span>queue</span><span class="n">${queue.waiting} waiting${polled}</span></button>`;
}

/** What a folded workflow still shows: the open queue's row and the open run's row, when they are its. */
function selection(repo: string, workflow: RailWorkflow, group: string, ui: UiState, now: number): SafeHtml {
  const queue = workflow.queue !== undefined && ui.queue === group ? queueRow(group, workflow.queue, ui, now) : '';
  return html`${queue}${workflow.runs.filter((run) => isOpen(repo, run, ui)).map((run) => runRow(repo, run, ui))}`;
}

function workflowGroup(repo: string, workflow: RailWorkflow, ui: UiState, now: number): SafeHtml {
  const group = queueId(repo, workflow.name);
  const open = !ui.closed.includes(group);
  const active = workflow.runs.filter((run) => !SECTIONS.some((each) => each.holds(run)));
  const running = workflow.runs.filter((run) => run.status === 'running').length;
  const failed = workflow.runs.filter((run) => run.status === 'failed').length;
  return html`<div class="wf"><button class="wf-h${open ? ' open' : ''}" data-action="toggle-group" data-group="${group}"><span class="caret">›</span><span class="nm">${workflow.name}</span><span class="counts">${
    running === 0 ? '' : html`<span class="r">▶ ${running}</span>`
  }${failed === 0 ? '' : html`<span class="f">✗ ${failed}</span>`}<span>${workflow.runs.length}</span></span></button>
${
  open
    ? html`${workflow.queue === undefined ? '' : queueRow(group, workflow.queue, ui, now)}${active.map((run) => runRow(repo, run, ui))}${SECTIONS.map(
        (which) => section(repo, group, workflow.runs, which, ui),
      )}`
    : selection(repo, workflow, group, ui, now)
}</div>`;
}

function repoGroup(repo: RailRepo, ui: UiState, now: number): SafeHtml {
  const open = !ui.closed.includes(repo.name);
  return html`<div class="lgrp">
<button class="lgrp-h${open ? ' open' : ''}" data-action="toggle-group" data-group="${repo.name}"><span class="caret">›</span><span class="ic">◆</span><span class="nm">${repo.name}</span>${repo.live ? html`<span class="live"></span>` : ''}<span class="n">${repo.runs.length}</span></button>
${
  open
    ? html`${repo.remote === null ? '' : html`<div class="lgrp-r">${repo.remote}</div>`}
${repo.problem === undefined ? '' : html`<div class="lgrp-p">${repo.problem}</div>`}
${repo.workflows.map((workflow) => workflowGroup(repo.name, workflow, ui, now))}`
    : repo.workflows.map((workflow) => selection(repo.name, workflow, queueId(repo.name, workflow.name), ui, now))
}</div>`;
}

/** The rail from the index model. `now` is ms since the epoch, for how long ago a queue was polled. */
export function renderRail(repos: readonly RailRepo[], ui: UiState, now: number): SafeHtml {
  const runs = repos.reduce((sum, repo) => sum + repo.runs.length, 0);
  return html`${runningBlock(repos, ui)}${queuedBlock(repos, ui, now)}<div class="rail-h"><span>repositories</span><span class="c">${runs} runs</span></div>
${repos.length === 0 ? html`<div class="qempty">no repository is registered yet: run sail watch in one</div>` : ''}${repos.map((repo) => repoGroup(repo, ui, now))}`;
}
