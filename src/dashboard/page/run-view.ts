// The run view: the run's header, its totals against its budget, one stage card per call grouped by loop iteration, a
// group's cards side by side under a header of their own, the roster stages not called yet, the pull request it opened,
// the Resume or Restart a run offers, and the CLI commands to copy. The cards come from the run model, fed by the run's events. The totals come from the
// summary in the index when there is one, and from the cards otherwise.
import type { Summary } from '../../events/summary';
import type { RestartOffer, ResumeOffer, RunActions } from '../actions';
import { runCommands } from './commands';
import { cost, duration, percent, tokens } from './format';
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
<div class="facts"><div><b>${duration(elapsedMs(entry, now))}</b><span class="lbl">duration</span></div>${
    entry.state === 'running' ? '' : html`<div><b>${cost(entry.costUsd)}</b><span class="lbl">cost</span></div>`
  }<div><b>${entry.toolCalls}</b><span class="lbl">tool calls</span></div></div>
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

/**
 * The cards in order, grouped: a run of cards in the same loop iteration under one header, and a group's cards under
 * one of their own, which names the iteration too when the group ran in one.
 */
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
    const within = iteration === undefined ? '' : `${iteration.loop}#${iteration.iteration}`;
    const group = entry.group === undefined ? undefined : model.groups[entry.group];
    const id = group === undefined ? within : `${within}/all#${entry.group}`;
    if (id !== current) {
      flush();
      current = id;
      const loop =
        iteration === undefined ? '' : `${iteration.loop} · iteration ${iteration.iteration} of ${iteration.max}`;
      if (group === undefined) header = loop === '' ? '' : html`<div class="grp-t">${loop}</div>`;
      else {
        const running = model.cards.filter((each) => each.group === entry.group && each.state === 'running').length;
        const open = group.ended ? '' : ` · ${running} running`;
        const all = `run.all · ${group.keys.length} calls${open}`;
        header = html`<div class="grp-t">${loop === '' ? all : `${loop} · ${all}`}</div>`;
      }
    }
    members.push(card(entry, place, ui, now));
  });
  flush();
  return out;
}

/** The summary once the run has ended: until then it is the one written after the last call, behind the cards. */
const finalOf = (model: RunModel, summary: Summary | null | undefined) =>
  model.end === undefined ? undefined : (summary ?? undefined);

/** Duration, cost and calls of the run: from the summary once it has ended, else from the cards. */
function totals(model: RunModel, summary: Summary | null | undefined, now: number): SafeHtml {
  const final = finalOf(model, summary);
  const started = model.startedAt === undefined ? Number.NaN : Date.parse(model.startedAt);
  const ms = final?.durationMs ?? (Number.isNaN(started) ? undefined : Math.max(0, now - started));
  const spent = final?.totals.usage.costUsd ?? model.cards.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0);
  const maxUsd = summary?.totals.budget?.maxUsd ?? model.budget?.maxUsd;
  const maxMinutes = model.budget?.maxMinutes;
  const used = final?.totals.budget?.usedPct;
  const settled = model.cards.filter((entry) => entry.state === 'settled').length;
  return html`<div class="stats totals">
<div class="stat"><b>${duration(ms)}</b><span>${maxMinutes === undefined ? 'duration' : `of ${maxMinutes}m`}</span></div>
<div class="stat"><b>${cost(spent)}</b><span>${maxUsd === undefined ? 'cost' : `of ${cost(maxUsd)} (${used === undefined ? percent(spent, maxUsd) : `${used}%`})`}</span></div>
<div class="stat"><b>${settled}/${model.cards.length}</b><span>calls settled</span></div>
</div>`;
}

/** What a resume has spent against its budget, in the unit a raise is in. */
function spentOf(offer: ResumeOffer): string {
  const { budget } = offer;
  if (offer.raise === 'minutes') {
    const of = budget.maxMinutes === undefined ? '' : ` of ${budget.maxMinutes} min`;
    return `spent ${offer.spentMinutes === undefined ? '?' : `${offer.spentMinutes} min`}${of}`;
  }
  return `spent ${cost(offer.spentUsd)}${budget.maxUsd === undefined ? '' : ` of ${cost(budget.maxUsd)}`}`;
}

/** The budget a restart gives the new run. */
function budgetOf(offer: RestartOffer): string {
  const { maxUsd, maxMinutes } = offer.budget;
  if (maxUsd !== undefined) return `budget ${cost(maxUsd)}`;
  return maxMinutes === undefined ? 'no budget' : `budget ${maxMinutes} min`;
}

function resumeControl(offer: ResumeOffer, ui: UiState): SafeHtml {
  if (!offer.enabled) {
    return html`<span class="act"><button class="btn" disabled>resume</button><span class="act-why">${offer.why}</span></span>`;
  }
  const raise =
    offer.raise === undefined
      ? ''
      : html`<label class="lbl">raise ${offer.raise === 'usd' ? '$' : 'min'} <input class="num" type="number" name="raise" min="0.01" step="any" value="${ui.raise ?? ''}"></label>`;
  const label = ui.armed === 'resume' ? `confirm resume · ${spentOf(offer)}` : 'resume';
  return html`<span class="act">${raise}<button class="btn${ui.armed === 'resume' ? ' armed' : ''}" data-action="resume-run">${label}</button></span>`;
}

function restartControl(offer: RestartOffer, ui: UiState): SafeHtml {
  if (!offer.enabled) {
    return html`<span class="act"><button class="btn" disabled>restart</button><span class="act-why">${offer.why}</span></span>`;
  }
  const chosen = offer.stages.some((each) => each.stage === ui.restartStage) ? ui.restartStage : offer.stage;
  const label = ui.armed === 'restart' ? `confirm restart from ${chosen} · ${budgetOf(offer)}` : 'restart';
  return html`<span class="act"><label class="lbl">from <select name="stage">${offer.stages.map(
    (each) =>
      html`<option value="${each.stage}" title="${each.runsAgain}"${each.stage === chosen ? ' selected' : ''}>${each.stage}</option>`,
  )}</select></label><button class="btn${ui.armed === 'restart' ? ' armed' : ''}" data-action="restart-run">${label}</button></span>`;
}

/** Resume or Restart, whichever the run offers, with the notice of the last start. */
function actionBar(actions: RunActions | undefined, ui: UiState): SafeHtml {
  if (actions === undefined || (actions.resume === undefined && actions.restart === undefined)) return html``;
  return html`<div class="grp"><div class="grp-t">start again</div><div class="acts">${
    actions.resume === undefined ? '' : resumeControl(actions.resume, ui)
  }${actions.restart === undefined ? '' : restartControl(actions.restart, ui)}${
    ui.runNotice === undefined ? '' : html`<span class="warnchip">${ui.runNotice}</span>`
  }</div></div>
`;
}

/** The run view. `now` is ms since the epoch, for the running cards' durations. */
export function renderRun(
  model: RunModel,
  summary: Summary | null | undefined,
  ui: UiState,
  now: number,
  actions?: RunActions,
): SafeHtml {
  const runId = model.runId ?? summary?.runId ?? ui.runId ?? '';
  const status = model.end?.status ?? (model.runId === undefined ? summary?.status : 'running');
  const stopReason = model.end?.stopReason ?? summary?.stopReason;
  const ticket = model.ticket ?? summary?.ticket;
  // A summary's result is the workflow's own, free-form: its PR is read only when it is an object (review R2-1).
  const pr = model.pr ?? fieldsOf(fieldsOf(summary?.result)?.pr);
  return html`<div class="d-h run-h">${
    ticket === undefined ? '' : html`<span class="d-title">${ticket.ticketKey}</span> ${link(ticket.url, ticket.title)}`
  }<span class="pill ${pillOf(status)}">${status ?? 'unknown'}</span>${
    stopReason === undefined ? '' : html`<span class="warnchip">${stopReason}</span>`
  }<span class="d-agent">${runId}${model.workflow === undefined ? '' : html` · ${model.workflow}`}${
    model.fromRun === undefined ? '' : html` · seeded from ${model.fromRun}`
  }</span></div>
${model.end?.message === undefined ? '' : html`<div class="d-msg">${model.end.message}</div>`}
<div class="run-b">
${totals(model, summary, now)}
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
${actionBar(actions, ui)}${runId === '' ? '' : html`<div class="grp"><div class="grp-t">commands</div>${commandList(runCommands(runId, status))}</div>`}
${
  model.unreadable === 0
    ? ''
    : html`<div class="code bad">${plural(model.unreadable, 'event')} of this run could not be read</div>`
}
</div>`;
}

/** The run's tokens: the summary's totals once the run has ended, else what its cards' sessions reported, live ones included. */
function tokensOf(
  model: RunModel,
  summary: Summary | null | undefined,
): { input: number; output: number; cached: number } {
  const usage = finalOf(model, summary)?.totals.usage;
  if (usage !== undefined) {
    return { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0, cached: usage.cacheReadTokens ?? 0 };
  }
  const sum = (pick: (card: StageCard) => number | undefined) =>
    model.cards.reduce((total, card) => total + (pick(card) ?? 0), 0);
  return {
    input: sum((card) => card.tokens?.input),
    output: sum((card) => card.tokens?.output),
    cached: sum((card) => card.tokens?.cacheRead),
  };
}

/** The status bar: calls settled of all, tool calls, denials, tokens, cost, and whether the run is live. */
export function renderStatus(model: RunModel, summary: Summary | null | undefined): SafeHtml {
  const settled = model.cards.filter((entry) => entry.state === 'settled').length;
  const tools = model.cards.reduce((sum, entry) => sum + entry.toolCalls, 0);
  const denials = model.cards.reduce((sum, entry) => sum + entry.denials.length, 0);
  const spent =
    finalOf(model, summary)?.totals.usage.costUsd ?? model.cards.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0);
  const used = tokensOf(model, summary);
  return html`<span>calls <b>${settled}/${model.cards.length}</b></span><span>tools <b>${tools}</b></span><span class="${
    denials > 0 ? 'w' : ''
  }">denied <b>${denials}</b></span><span title="tokens in, out and read from the cache">tokens <b>${tokens(used.input)}</b> in · <b>${tokens(used.output)}</b> out · <b>${tokens(used.cached)}</b> cached</span><span>cost <b>${cost(spent)}</b></span><span class="spacer"></span><span>${
    model.end === undefined ? '● live' : `ended ${model.end.status}`
  }</span>`;
}
