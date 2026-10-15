// The inspector: one call, on four tabs. Overview has its facts, output and errors; files, what it produced and how
// each was validated; permissions, the step's permissions and budget from the roster and each denial with the command
// it refused; log, its session or its stdout and stderr. Everything comes from the run's own files: the card from its
// events, the roster from `run:start`, and the call's `result.json` and logs over REST.
import { clock, cost, duration } from './format';
import { html, type SafeHtml, text } from './html';
import type { Roster, StageCard } from './run-model';
import { pillOf, TABS, type UiState } from './ui-state';

/** A read the shell made for the inspector: still going, not there, or what came back. */
export type Loaded<T> = { state: 'loading' } | { state: 'missing'; message?: string } | { state: 'loaded'; value: T };

type Fields = Record<string, unknown>;

const obj = (value: unknown): Fields | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : undefined;
const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => (typeof item === 'string' ? item : text(item))) : [];

/** The log streams a call of `kind` writes. */
export function streamsOf(kind: string): string[] {
  if (kind === 'agent') return ['session'];
  if (kind === 'script') return ['stdout', 'stderr'];
  if (kind === 'stage') return ['session', 'stdout', 'stderr'];
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
    ['cost', cost(card.costUsd)],
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

function files(card: StageCard, result: Fields | undefined): SafeHtml {
  const fromResult = Object.entries(obj(result?.files) ?? {}).map(([name, file]) => ({ name, ...(obj(file) ?? {}) }));
  const shown = fromResult.length > 0 ? fromResult : card.files;
  if (shown.length === 0) return html`<div class="code">this call produced no files</div>`;
  return html`<div class="grp"><div class="grp-t">files · ${shown.length}</div>${shown.map((file: Fields) => {
    const name = text(file.name);
    const validated = card.files.find((entry) => entry.name === name);
    const sha = typeof file.sha256 === 'string' ? file.sha256 : undefined;
    return html`<div class="art"><span class="ic">▤</span><span><b>${name}</b><span class="d">${text(file.path ?? '')}${
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

function log(card: StageCard, loaded: Loaded<string> | undefined, ui: UiState): SafeHtml {
  const streams = streamsOf(card.kind);
  if (streams.length === 0) return html`<div class="code">no log for this call</div>`;
  const chosen = ui.stream !== undefined && streams.includes(ui.stream) ? ui.stream : streams[0];
  const body =
    loaded === undefined || loaded.state === 'loading'
      ? html`<div class="code">loading…</div>`
      : loaded.state === 'missing'
        ? html`<div class="code">no log for this call</div>`
        : html`<pre class="code log">${loaded.value}</pre>`;
  return html`<div class="logbar">${streams.map(
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
  const tab = ui.tab;
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
<div class="tabs">${TABS.map((name) => html`<button class="tab${name === tab ? ' on' : ''}" data-action="tab" data-tab="${name}">${name}</button>`)}</div>
<div class="ins-b">${tab === 'log' ? '' : note}${body}</div>`;
}
