// The inspector: one call, on up to four tabs. Overview has its facts, output and errors; files, what it produced and how
// each was validated, each name opening the file in the drawer; permissions, the step's permissions and budget from the
// roster and each denial with the command it refused; log, its session or its stdout and stderr, and for a multi-step
// call a bar of its steps above them, each step's streams read by its step key. A script call has no
// permissions tab, and a call with no files no files tab. Everything comes from the run's own files: the card from its
// events, the roster from `run:start`, and the call's `result.json` and logs over REST.
import { clock, cost, duration } from './format';
import { html, type SafeHtml, text } from './html';
import type { CardStep, Roster, StageCard } from './run-model';
import { type InspectorTab, pillOf, TABS, type UiState } from './ui-state';

/** A read the shell made for the inspector: still going, not there, or what came back. */
export type Loaded<T> = { state: 'loading' } | { state: 'missing'; message?: string } | { state: 'loaded'; value: T };

type Fields = Record<string, unknown>;

const obj = (value: unknown): Fields | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : undefined;
const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => (typeof item === 'string' ? item : text(item))) : [];

/** The log streams a call or step of `kind` writes. A multi-step call writes none: its steps do. */
export function streamsOf(kind: string): string[] {
  if (kind === 'agent') return ['session'];
  if (kind === 'script') return ['stdout', 'stderr'];
  return [];
}

const pre = (value: unknown) => html`<pre class="code">${JSON.stringify(value, null, 2)}</pre>`;

function kv(rows: readonly [string, unknown][]): SafeHtml {
  return html`<dl class="kv">${rows.map(([label, value]) => html`<dt>${label}</dt><dd>${text(value)}</dd>`)}</dl>`;
}

function overview(card: StageCard, result: Fields | undefined): SafeHtml {
  const other = Object.entries(card.other);
  const consumed = Object.entries(obj(result?.consumed) ?? {});
  const errors = card.errors ?? (Array.isArray(result?.errors) ? result.errors.map((error) => obj(error) ?? {}) : []);
  return html`<div class="grp"><div class="stats">
<div class="stat"><b>${card.state === 'running' ? 'running' : (card.outcome ?? '—')}</b><span>outcome</span></div>
<div class="stat"><b>${card.tries}</b><span>tries</span></div>
<div class="stat"><b>${duration(card.durationMs)}</b><span>duration</span></div>
</div></div>
<div class="grp"><div class="grp-t">call</div>${kv([
    ['stage', card.stage],
    ['kind', card.kind],
    ['model', card.model ?? '—'],
    // A running call's cost is known only once its session ends.
    ...(card.state === 'running' ? [] : [['cost', cost(card.costUsd)] as [string, unknown]]),
    ['turns', card.turns ?? '—'],
    ['tool calls', card.toolCalls],
  ])}</div>
${
  errors.length === 0
    ? ''
    : html`<div class="grp"><div class="grp-t">errors</div>${errors.map(
        (error) => html`<div class="code bad"><b>${text(error.reason ?? '')}</b> ${text(error.message ?? '')}</div>`,
      )}</div>`
}
${result === undefined || result.output === undefined ? '' : html`<div class="grp"><div class="grp-t">output</div>${pre(result.output)}</div>`}
${result?.derived === undefined ? '' : html`<div class="grp"><div class="grp-t">derived</div>${pre(result.derived)}</div>`}
${
  consumed.length === 0
    ? ''
    : html`<div class="grp"><div class="grp-t">consumed</div>${kv(consumed.map(([binding, from]) => [binding, from ?? '—']))}</div>`
}
${
  other.length === 0
    ? ''
    : html`<div class="grp"><div class="grp-t">other events</div><ul class="polylist">${other.map(([type, n]) => html`<li>${type} × ${n}</li>`)}</ul></div>`
}`;
}

/** The call's files: its `result.json`'s, else those its events named. */
function filesOf(card: StageCard, result: Fields | undefined): Fields[] {
  const fromResult = Object.entries(obj(result?.files) ?? {}).map(([name, file]) => ({ name, ...(obj(file) ?? {}) }));
  return fromResult.length > 0 ? fromResult : card.files.map((file) => ({ ...file }));
}

/** The tabs the call has: a script has no permissions, and a call with no files no files tab. */
export function tabsOf(card: StageCard, result: Fields | undefined): InspectorTab[] {
  return TABS.filter(
    (tab) =>
      !(tab === 'permissions' && card.kind === 'script') && !(tab === 'files' && filesOf(card, result).length === 0),
  );
}

function files(card: StageCard, result: Fields | undefined): SafeHtml {
  const shown = filesOf(card, result);
  return html`<div class="grp"><div class="grp-t">files · ${shown.length}</div>${shown.map((file: Fields) => {
    const name = text(file.name);
    const validated = card.files.find((entry) => entry.name === name);
    const sha = typeof file.sha256 === 'string' ? file.sha256 : undefined;
    const path = typeof file.path === 'string' ? file.path : undefined;
    const title =
      path === undefined
        ? html`<b>${name}</b>`
        : html`<button class="art-open" data-action="open-file" data-name="${name}" data-path="${path}" title="read ${name}"><b>${name}</b></button>`;
    return html`<div class="art"><span class="ic">▤</span><span>${title}<span class="d">${text(file.path ?? '')}${
      typeof file.bytes === 'number' ? ` · ${file.bytes} bytes` : ''
    }${sha === undefined ? '' : html` · <span class="sha" title="${sha}">${sha.slice(0, 12)}</span>`}</span></span>${
      validated?.ok === undefined
        ? ''
        : html`<span class="pill ${validated.ok ? 'p-pass' : 'p-fail'}">${validated.ok ? 'valid' : 'invalid'}</span>`
    }</div>${
      (validated?.checks ?? []).length === 0
        ? ''
        : html`<ul class="polylist">${(validated?.checks ?? []).map((check) => html`<li>${check}</li>`)}</ul>`
    }`;
  })}</div>`;
}

const RULES = ['read', 'write', 'commands', 'tools', 'network'] as const;

function permissions(card: StageCard, roster: Roster | undefined, ui: UiState): SafeHtml {
  const entry = card.kind === 'builtin' ? roster?.intake : roster?.stages[card.stage];
  const allowed = obj(entry?.permissions) ?? {};
  const budget = obj(entry?.budget);
  const tz = ui.tz;
  return html`${RULES.map((rule) => {
    const items = list(rule === 'network' ? (allowed.network ?? entry?.network) : allowed[rule]);
    return html`<div class="grp"><div class="grp-t">${rule}</div><ul class="polylist">${
      items.length === 0 ? html`<li>none</li>` : items.map((item) => html`<li>${item}</li>`)
    }</ul></div>`;
  })}
${budget === undefined ? '' : html`<div class="grp"><div class="grp-t">budget</div>${kv(Object.entries(budget))}</div>`}
<div class="grp"><div class="grp-t">denials · ${card.denials.length}</div>${
    card.denials.length === 0
      ? html`<div class="code">No denials</div>`
      : card.denials.map(
          (
            denial,
          ) => html`<div class="mini deny"><div class="mini-h">denied · ${clock(denial.ts, tz)}</div><div class="mini-b"><dl class="kv">
<dt>tool</dt><dd>${denial.tool}</dd>
<dt>command</dt><dd><code>${denial.command ?? '—'}</code></dd>
<dt>rule</dt><dd>${denial.rule}</dd>
<dt>allowed</dt><dd><ul class="polylist">${list(denial.permissions[denial.rule]).map((item) => html`<li>${item}</li>`)}</ul></dd>
<dt>reason</dt><dd>${denial.reason}</dd>
</dl></div></div>`,
        )
  }</div>`;
}

/** What the log tab reads: the key, the streams and, for a multi-step call, the chosen step. */
export function logTarget(card: StageCard, ui: UiState): { key: string; streams: string[]; step?: CardStep } {
  if (card.kind !== 'stage') return { key: card.key, streams: streamsOf(card.kind) };
  const step = card.steps.find((entry) => entry.step === ui.step) ?? card.steps.at(-1);
  if (step === undefined) return { key: card.key, streams: [] };
  return { key: `${card.key}/${step.step}`, streams: streamsOf(step.kind), step };
}

function log(card: StageCard, loaded: Loaded<string> | undefined, ui: UiState): SafeHtml {
  const { streams, step } = logTarget(card, ui);
  if (streams.length === 0) return html`<div class="code">no log for this call</div>`;
  const chosen = ui.stream !== undefined && streams.includes(ui.stream) ? ui.stream : streams[0];
  const body =
    loaded === undefined || loaded.state === 'loading'
      ? html`<div class="code">loading…</div>`
      : loaded.state === 'missing'
        ? html`<div class="code">no log for this call</div>`
        : html`<pre class="code log">${loaded.value}</pre>`;
  const stepBar =
    card.kind === 'stage'
      ? html`<div class="logbar">${card.steps.map(
          (entry) =>
            html`<button class="tog${entry === step ? ' on' : ''}" data-action="log-step" data-step="${entry.step}">${entry.index} · ${entry.step}</button>`,
        )}</div>`
      : '';
  return html`${stepBar}<div class="logbar">${streams.map(
    (stream) =>
      html`<button class="tog${stream === chosen ? ' on' : ''}" data-action="stream" data-stream="${stream}">${stream}</button>`,
  )}${
    card.state === 'running'
      ? html`<button class="tog${ui.follow ? ' on' : ''}" data-action="toggle-follow">follow</button>`
      : ''
  }</div>${body}`;
}

/**
 * The inspector for `card`, on `ui.tab`. `result` is the call's `result.json` as the shell read it, and `logText` its
 * log. A result not read yet, or not there, leaves the card's own facts, and says so.
 */
export function renderInspector(
  card: StageCard | undefined,
  roster: Roster | undefined,
  result: Loaded<unknown> | undefined,
  logText: Loaded<string> | undefined,
  ui: UiState,
): SafeHtml {
  if (card === undefined) {
    return html`<div class="ins-h"><span>inspector</span></div><div class="ins-b"><div class="code">select a stage card</div></div>`;
  }
  const value = result?.state === 'loaded' ? obj(result.value) : undefined;
  const note =
    result === undefined || result.state === 'loading'
      ? html`<div class="hint">reading this call's result.json…</div>`
      : result.state === 'missing'
        ? html`<div class="hint">this call has no result.json yet: shown from its events</div>`
        : '';
  const tabs = tabsOf(card, value);
  // A tab the call lacks shows its overview.
  const tab = tabs.includes(ui.tab) ? ui.tab : 'overview';
  const body =
    tab === 'overview'
      ? overview(card, value)
      : tab === 'files'
        ? files(card, value)
        : tab === 'permissions'
          ? permissions(card, roster, ui)
          : log(card, logText, ui);
  return html`<div class="ins-h"><span>${card.key}</span><span class="pill ${pillOf(card.state === 'running' ? 'running' : card.outcome)}">${
    card.state === 'running' ? 'running' : (card.outcome ?? '—')
  }</span></div>
<div class="tabs">${tabs.map((name) => html`<button class="tab${name === tab ? ' on' : ''}" data-action="tab" data-tab="${name}">${name}</button>`)}</div>
<div class="ins-b">${tab === 'log' ? '' : note}${body}</div>`;
}
