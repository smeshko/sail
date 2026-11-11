// The centre's empty state: what the dashboard shows where a run or queue would be while none is open. A headline, one
// line of what the view holds (its counts, or its empty words when it has no row) and the keys that move and open.
import { html, raw, type SafeHtml } from './html';
import type { ListGroup, ListRow, ViewName } from './list-model';
import { EMPTY } from './list-view';

const KEYS = raw('<kbd>J</kbd> <kbd>K</kbd> move · <kbd>Enter</kbd> open · <kbd>Cmd+K</kbd> commands');

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

/** The centre with nothing open: `groups` is the view under the repository filter, undefined before the first index. */
export function renderEmpty(view: ViewName, groups: readonly ListGroup[] | undefined): SafeHtml {
  const headline = view === 'queues' ? 'No queue selected' : 'No run selected';
  const holds =
    groups === undefined
      ? undefined
      : groups.some((group) => group.rows.length > 0)
        ? countsOf(view, groups)
        : EMPTY[view];
  return html`<div class="empty"><div class="empty-t">${headline}</div>${
    holds === undefined ? '' : html`<div class="empty-c">${holds}</div>`
  }<div class="empty-k">${KEYS}</div></div>`;
}
