// The centre's empty state: what the dashboard shows where a run or queue would be while none is open, in the middle of
// the centre. A headline, one line of what the list beside it shows (its counts, or its empty words when it shows no
// row) and the keys that move and open, which are left out while there is no row to move to. On a machine with no
// repository registered it is the first run's state instead: what to do next, with the command to copy.
import { html, type SafeHtml } from './html';
import { keyLabel } from './keymap';
import type { ListGroup, ListRow, ViewName } from './list-model';
import { EMPTY, VIEW_LABELS } from './list-view';
import { commandList } from './run-view';
import type { UiState } from './ui-state';

const kbd = (key: string) => html`<kbd>${keyLabel(key)}</kbd>`;

/** The keys that move and open, drawn as the rest of the page draws them, or only the menu's while no row shows. */
const keys = (rows: boolean): SafeHtml =>
  rows
    ? html`${kbd('j')} ${kbd('k')} move · ${kbd('Enter')} open · ${kbd('Mod+k')} commands`
    : html`${kbd('Mod+k')} commands`;

/** The command that registers a repository: a watch in its clone. */
export const FIRST_COMMAND = 'sail watch';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The view's counts in one line, a part that is zero left out. */
function countsOf(view: ViewName, groups: readonly ListGroup[]): string {
  const rows: ListRow[] = groups.flatMap((group) => group.rows);
  const inGroup = (name: string) => groups.find((group) => group.id === `${view}:${name}`)?.rows.length ?? 0;
  const parts: [number, string][] = [];
  if (view === 'inbox')
    parts.push([inGroup('runs'), 'run'], [inGroup('parked'), 'parked'], [inGroup('problems'), 'problem']);
  else if (view === 'active') parts.push([inGroup('waiting'), 'waiting on you'], [inGroup('running'), 'running']);
  else if (view === 'queues') {
    const waiting = rows.reduce((sum, row) => sum + (row.kind === 'queue' ? row.waiting : 0), 0);
    parts.push([rows.length, 'queue'], [waiting, 'waiting']);
  } else {
    const failed = rows.filter((row) => row.kind === 'run' && row.run.status === 'failed').length;
    parts.push([failed, 'failed'], [rows.length - failed, 'done']);
  }
  return parts
    .filter(([n]) => n > 0)
    .map(([n, word]) => {
      if (view === 'inbox' && word !== 'parked') return plural(n, word);
      if (view === 'queues' && word === 'queue') return plural(n, word);
      return `${n} ${word}`;
    })
    .join(' · ');
}

/** Whether the list's filters narrow what it shows: its field, and History's status and workflow. */
const narrowed = (view: ViewName, ui: Pick<UiState, 'listFilter' | 'historyStatus' | 'historyWorkflow'> | undefined) =>
  ui !== undefined &&
  (ui.listFilter.trim() !== '' ||
    (view === 'history' && (ui.historyStatus !== undefined || ui.historyWorkflow !== undefined)));

/** The first run's state: no repository is registered, so it says what to do next and gives the command to copy. */
function firstRun(copied: UiState['copied']): SafeHtml {
  return html`<div class="empty first"><div class="empty-t">No repository yet</div><div class="empty-c">Run <code>${FIRST_COMMAND}</code> in a repository's clone. It registers the repository, and its runs and queues show here.</div>${commandList(
    [{ label: 'in a clone', command: FIRST_COMMAND }],
    copied,
  )}</div>`;
}

/** The line the empty centre holds under its headline: the view's counts, `nothing matches`, or its empty words. */
export function viewLine(
  view: ViewName,
  groups: readonly ListGroup[] | undefined,
  ui?: Pick<UiState, 'listFilter' | 'historyStatus' | 'historyWorkflow'>,
): string | undefined {
  if (groups === undefined) return undefined;
  if (groups.some((group) => group.rows.length > 0)) return countsOf(view, groups);
  return narrowed(view, ui) ? 'nothing matches' : EMPTY[view];
}

/** The status bar with nothing open: the view's name and the empty centre's line. */
export function renderViewStatus(
  view: ViewName,
  groups: readonly ListGroup[] | undefined,
  ui?: Pick<UiState, 'listFilter' | 'historyStatus' | 'historyWorkflow'>,
): SafeHtml {
  const line = viewLine(view, groups, ui);
  return html`<span>${VIEW_LABELS[view]}</span>${line === undefined ? '' : html`<span>${line}</span>`}`;
}

/**
 * The centre with nothing open: `groups` is what the list shows, its filters applied, undefined before the first index.
 * `repos` is how many repositories the index lists: none is the first run's state.
 */
export function renderEmpty(
  view: ViewName,
  groups: readonly ListGroup[] | undefined,
  ui?: Pick<UiState, 'copied' | 'listFilter' | 'historyStatus' | 'historyWorkflow'>,
  repos?: number,
): SafeHtml {
  if (repos === 0) return firstRun(ui?.copied);
  const headline = view === 'queues' ? 'No queue selected' : 'No run selected';
  const rows = groups?.some((group) => group.rows.length > 0) === true;
  const holds = viewLine(view, groups, ui);
  return html`<div class="empty"><div class="empty-t">${headline}</div>${
    holds === undefined ? '' : html`<div class="empty-c">${holds}</div>`
  }<div class="empty-k">${keys(rows)}</div></div>`;
}
