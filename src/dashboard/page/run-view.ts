// The run view: the run's header, its totals against its budget, its loops and routes, one stage card per call grouped
// by loop iteration, the roster stages not called yet, the pull request it opened, and the CLI commands to copy. The
// cards come from the run model, fed by the run's events. The totals, loops and routes come from the summary in the
// index when there is one, and from the cards otherwise.
import type { Summary } from '../../events/summary';
import { runCommands } from './commands';
import { cost, duration, percent } from './format';
import { html, type SafeHtml, safeHref, text } from './html';
import { elapsedMs, type PendingCard, type RunModel, type StageCard } from './run-model';
import { pillOf, type UiState } from './ui-state';

const fieldsOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** A URL as a link when it is http(s), else as text. */
export function link(url: string | undefined, label: string | SafeHtml): SafeHtml {
  const href = safeHref(url);
  return href === undefined
    ? html`<span class="lnk">${label}</span>`
    : html`<a class="lnk" href="${href}" rel="noreferrer" target="_blank">${label}</a>`;
}

/** The commands to copy, each with its copy button. */
export function commandList(commands: readonly { label: string; command: string }[]): SafeHtml {
  return html`<div class="cmds">${commands.map(
    ({ label, command }) =>
      html`<span class="cmd"><span class="lbl">${label}</span><code>${command}</code><button class="btn" data-action="copy" data-text="${command}">copy</button></span>`,
  )}</div>`;
}

function card(entry: StageCard, place: number, ui: UiState, now: number): SafeHtml {
  const state = entry.state === 'running' ? 'running' : (entry.outcome ?? 'settled');
  const classes = `card${place === ui.cursor ? ' cursor' : ''}${entry.key === ui.key ? ' sel' : ''}`;
  return html`<div class="${classes}" data-action="select-card" data-key="${entry.key}">
<div class="c-top"><span class="c-n">${String(place + 1).padStart(2, '0')}</span><span class="c-name">${entry.key}</span>${
    entry.tries > 1 ? html`<span class="retry">↻${entry.tries}</span>` : ''
  }${entry.denials.length > 0 ? html`<span class="warnchip">⊘ ${entry.denials.length}</span>` : ''}<span class="pill ${pillOf(state)}">${state}</span></div>
<div class="c-agent">${entry.kind}${entry.model === undefined ? '' : html` <span class="c-model">${entry.model}</span>`}</div>
<div class="facts"><div><b>${duration(elapsedMs(entry, now))}</b><span class="lbl">duration</span></div><div><b>${cost(entry.costUsd)}</b><span class="lbl">cost</span></div><div><b>${entry.toolCalls}</b><span class="lbl">tool calls</span></div></div>
${entry.message === undefined ? '' : html`<div class="c-msg">${entry.message}</div>`}
${
  entry.steps.length === 0
    ? ''
    : html`<div class="c-steps">${entry.steps.map((step) => html`<span class="pill ${pillOf(step.outcome ?? 'running')}">${step.step}</span>`)}</div>`
}
<div class="c-foot"><span>${plural(entry.files.length, 'file')}</span><span>${plural(entry.events, 'event')}</span></div>
</div>`;
}

function pendingCard(entry: PendingCard): SafeHtml {
  return html`<div class="card pending"><div class="c-top"><span class="c-name">${entry.stage}</span><span class="pill p-pend">pending</span></div>
<div class="c-agent">${entry.kind}${entry.model === undefined ? '' : html` <span class="c-model">${entry.model}</span>`}</div></div>`;
}

/** The cards in order, grouped: a run of cards in the same loop iteration under one header. */
function groups(model: RunModel, ui: UiState, now: number): SafeHtml[] {
  const out: SafeHtml[] = [];
  let current: string | undefined;
  let members: SafeHtml[] = [];
  let header: SafeHtml | string = '';
  const flush = () => {
    if (members.length > 0) out.push(html`<div class="cgrp">${header}<div class="grid">${members}</div></div>`);
    members = [];
  };
  model.cards.forEach((entry, place) => {
    const { iteration } = entry;
    const id = iteration === undefined ? '' : `${iteration.loop}#${iteration.iteration}`;
    if (id !== current) {
      flush();
      current = id;
      header =
        iteration === undefined
          ? ''
          : html`<div class="grp-t">${iteration.loop} · iteration ${iteration.iteration} of ${iteration.max}</div>`;
    }
    members.push(card(entry, place, ui, now));
  });
  flush();
  return out;
}

/** Duration, cost and calls of the run: from the summary when there is one, else from the cards. */
function totals(model: RunModel, summary: Summary | null | undefined, now: number): SafeHtml {
  const started = model.startedAt === undefined ? Number.NaN : Date.parse(model.startedAt);
  const ms = summary?.durationMs ?? (Number.isNaN(started) ? undefined : Math.max(0, now - started));
  const spent = summary?.totals.usage.costUsd ?? model.cards.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0);
  const maxUsd = summary?.totals.budget?.maxUsd ?? model.budget?.maxUsd;
  const maxMinutes = model.budget?.maxMinutes;
  const used = summary?.totals.budget?.usedPct;
  const settled = model.cards.filter((entry) => entry.state === 'settled').length;
  return html`<div class="stats totals">
<div class="stat"><b>${duration(ms)}</b><span>${maxMinutes === undefined ? 'duration' : `of ${maxMinutes}m`}</span></div>
<div class="stat"><b>${cost(spent)}</b><span>${maxUsd === undefined ? 'cost' : `of ${cost(maxUsd)} (${used === undefined ? percent(spent, maxUsd) : `${used}%`})`}</span></div>
<div class="stat"><b>${settled}/${model.cards.length}</b><span>calls settled</span></div>
</div>`;
}

/** The run view. `now` is ms since the epoch, for the running cards' durations. */
export function renderRun(model: RunModel, summary: Summary | null | undefined, ui: UiState, now: number): SafeHtml {
  const runId = model.runId ?? summary?.runId ?? ui.runId ?? '';
  const status = model.end?.status ?? (model.runId === undefined ? summary?.status : 'running');
  const stopReason = model.end?.stopReason ?? summary?.stopReason;
  const ticket = model.ticket ?? summary?.ticket;
  // A summary's result is the workflow's own, free-form: its PR is read only when it is an object (review R2-1).
  const pr = model.pr ?? fieldsOf(fieldsOf(summary?.result)?.pr);
  const loops = Object.entries(model.loops);
  return html`<div class="d-h run-h">${
    ticket === undefined ? '' : html`<span class="d-title">${ticket.ticketKey}</span> ${link(ticket.url, ticket.title)}`
  }<span class="pill ${pillOf(status)}">${status ?? 'unknown'}</span>${
    stopReason === undefined ? '' : html`<span class="warnchip">${stopReason}</span>`
  }<span class="d-agent">${runId}${model.workflow === undefined ? '' : html` · ${model.workflow}`}</span></div>
${model.end?.message === undefined ? '' : html`<div class="d-msg">${model.end.message}</div>`}
<div class="run-b">
${totals(model, summary, now)}
${
  loops.length === 0
    ? ''
    : html`<div class="loops">${loops.map(
        ([name, loop]) =>
          html`<span class="loopbadge">${name}: ${loop.iteration}/${loop.max}${loop.exited === undefined ? '' : html` · ${loop.exited}`}</span>`,
      )}</div>`
}
${
  model.routes.length === 0
    ? ''
    : html`<div class="routes">${model.routes.map((route) => html`<span class="route">${route.at} ${route.value} → ${route.took}</span>`)}</div>`
}
${groups(model, ui, now)}
${
  model.pending.length === 0
    ? ''
    : html`<div class="cgrp"><div class="grp-t">not called yet</div><div class="grid">${model.pending.map(pendingCard)}</div></div>`
}
${
  pr === undefined
    ? ''
    : html`<div class="grp"><div class="grp-t">pull request</div>${link(typeof pr.url === 'string' ? pr.url : undefined, `#${text(pr.number)}`)}</div>`
}
${runId === '' ? '' : html`<div class="grp"><div class="grp-t">commands</div>${commandList(runCommands(runId, status))}</div>`}
${
  model.unreadable === 0
    ? ''
    : html`<div class="code bad">${plural(model.unreadable, 'event')} of this run could not be read</div>`
}
</div>`;
}

/** The status bar: calls settled of all, tool calls, denials, cost, and whether the run is live. */
export function renderStatus(model: RunModel, summary: Summary | null | undefined): SafeHtml {
  const settled = model.cards.filter((entry) => entry.state === 'settled').length;
  const tools = model.cards.reduce((sum, entry) => sum + entry.toolCalls, 0);
  const denials = model.cards.reduce((sum, entry) => sum + entry.denials.length, 0);
  const spent = summary?.totals.usage.costUsd ?? model.cards.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0);
  return html`<span>calls <b>${settled}/${model.cards.length}</b></span><span>tools <b>${tools}</b></span><span class="${
    denials > 0 ? 'w' : ''
  }">denied <b>${denials}</b></span><span>cost <b>${cost(spent)}</b></span><span class="spacer"></span><span>${
    model.end === undefined ? '● live' : `ended ${model.end.status}`
  }</span>`;
}
