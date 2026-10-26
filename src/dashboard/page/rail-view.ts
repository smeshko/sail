// The rail: every registered repository with its runs, newest first. Failed runs fold into a counted `failed` section
// and completed ones into a `completed` section, each open when the person opened it or when it holds the open run, so
// a long tail of finished runs never buries live work and the selection is never hidden.
import { cost, duration } from './format';
import { html, type SafeHtml } from './html';
import type { RailRepo, RailRun } from './index-model';
import { pillOf, type UiState } from './ui-state';

function runRow(repo: string, run: RailRun, ui: UiState): SafeHtml {
  const selected = ui.repo === repo && ui.runId === run.runId;
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

function section(repo: RailRepo, which: (typeof SECTIONS)[number], ui: UiState): SafeHtml {
  const runs = repo.runs.filter(which.holds);
  if (runs.length === 0) return html``;
  const id = `${repo.name}:${which.name}`;
  const open = ui.open.includes(id) || runs.some((run) => ui.repo === repo.name && ui.runId === run.runId);
  return html`<button class="subgrp-h${open ? ' open' : ''}" data-action="toggle-section" data-section="${id}"><span class="caret">›</span><span class="sw ${which.pill}"></span><span>${which.name}</span><span class="n">${runs.length}</span></button>
${open ? runs.map((run) => runRow(repo.name, run, ui)) : ''}`;
}

function repoGroup(repo: RailRepo, ui: UiState): SafeHtml {
  const active = repo.runs.filter((run) => !SECTIONS.some((each) => each.holds(run)));
  return html`<div class="lgrp">
<div class="lgrp-h"><span class="ic">◆</span><span class="nm">${repo.name}</span>${repo.live ? html`<span class="live"></span>` : ''}<span class="n">${repo.runs.length}</span></div>
${repo.remote === null ? '' : html`<div class="lgrp-r">${repo.remote}</div>`}
${repo.problem === undefined ? '' : html`<div class="lgrp-p">${repo.problem}</div>`}
${active.map((run) => runRow(repo.name, run, ui))}
${SECTIONS.map((which) => section(repo, which, ui))}</div>`;
}

/** The rail from the index model. */
export function renderRail(repos: readonly RailRepo[], ui: UiState): SafeHtml {
  const runs = repos.reduce((sum, repo) => sum + repo.runs.length, 0);
  return html`<div class="rail-h"><span>repositories</span><span class="c">${runs} runs</span></div>
${repos.length === 0 ? html`<div class="qempty">no repository is registered yet: run sail watch in one</div>` : ''}${repos.map((repo) => repoGroup(repo, ui))}`;
}
