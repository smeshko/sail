// The list's cursor, as the keys drive it: what the list shows, the row under the cursor and its subject, a move of the
// cursor, `w`'s switch of the keyed pane, `Enter`'s open of the row under the cursor, and the Inbox row `e` dismisses.
import type { Subject } from './action-registry';
import { actions } from './actions';
import { openSubject, setFocus } from './focus';
import { listRepos } from './index-model';
import { type AttentionRow, attentionSubject, entries, type ListRow, shownGroups } from './list-model';
import { opens } from './selection';
import { keyedPane, listed, type Store } from './store';

/** What the list shows now: its groups under the repository filter and the filter field. */
export function shown(store: Store) {
  const { ui, host } = store;
  return shownGroups(ui.view, listRepos(store.index ?? [], host.now()), ui, host.now(), listed(store));
}

/** The row with `id` in what the list shows. */
export const rowOf = (store: Store, id: string | undefined): ListRow | undefined =>
  shown(store)
    .flatMap((group) => group.rows)
    .find((row) => row.id === id);

/** The subject of a list row: a run, or a queue's workflow. A group header is none. */
const rowSubject = (row: ListRow | undefined): Subject | undefined =>
  row === undefined
    ? undefined
    : row.kind === 'run'
      ? { kind: 'run', repo: row.repo, runId: row.run.runId }
      : row.kind === 'attention'
        ? attentionSubject(row)
        : { kind: 'workflow', repo: row.repo, workflow: row.workflow };

/** Moves the list's cursor `by` entries, clamped, to the first entry when its own is gone. */
export function moveList(store: Store, by: number) {
  const { ui } = store;
  const ids = entries(shown(store), ui.listFolded);
  const at = ids.indexOf(ui.listCursor ?? '');
  const next = at < 0 ? ids[0] : ids[Math.max(0, Math.min(ids.length - 1, at + by))];
  // Only a move that changes the cursor asks for a reveal: one left set would scroll a later redraw (review R10).
  if (next === undefined || next === ui.listCursor) return;
  ui.listCursor = next;
  // The row under the cursor is the cursor's subject.
  setFocus(ui, 'cursor', rowSubject(rowOf(store, next)));
  store.revealList = true;
  store.mark('list');
}

/**
 * `w`: gives the keys to the other pane while both show. The cursor's subject follows them: the row under the list's
 * cursor, or the open run or queue.
 */
export function switchPane(store: Store) {
  const pane = keyedPane(store);
  if (pane === undefined) return;
  const { ui } = store;
  ui.pane = pane === 'list' ? 'centre' : 'list';
  setFocus(ui, 'cursor', undefined);
  setFocus(ui, 'cursor', ui.pane === 'list' ? rowSubject(rowOf(store, ui.listCursor)) : openSubject(store));
  store.mark();
}

/** Opens the row under the list's cursor, which gives the centre the keys, or folds the group under it. */
export function openCursor(store: Store) {
  const { ui } = store;
  const row = rowOf(store, ui.listCursor);
  // The centre takes the keys even when the row was open already, which draws nothing else.
  if (row !== undefined && opens(row) !== undefined && ui.pane !== 'centre') {
    ui.pane = 'centre';
    store.mark();
  }
  if (row === undefined) {
    if (ui.listCursor !== undefined && entries(shown(store), []).includes(ui.listCursor))
      actions['toggle-list-group']?.(store, { group: ui.listCursor });
  } else if (row.kind === 'attention') {
    const { opens, workflow } = row.item;
    if (opens !== undefined)
      actions.open?.(store, {
        repo: opens.repo,
        run: opens.runId,
        ...(opens.key === undefined ? {} : { key: opens.key }),
      });
    else if (workflow !== undefined) actions['select-queue']?.(store, { queue: `${row.repo}/${workflow}` });
  } else if (row.kind === 'run') actions['select-run']?.(store, { repo: row.repo, run: row.run.runId });
  else actions['select-queue']?.(store, { queue: `${row.repo}/${row.workflow}` });
}

/** The Inbox row `e` dismisses: the one under the list's cursor, else the open run's. */
export function inboxRow(store: Store): AttentionRow | undefined {
  const row = rowOf(store, store.ui.listCursor);
  if (row?.kind === 'attention') return row;
  const open = store.run === undefined || store.ui.queue !== undefined ? undefined : store.run;
  if (open === undefined) return undefined;
  return shown(store)
    .flatMap((group) => group.rows)
    .find(
      (each): each is AttentionRow =>
        each.kind === 'attention' && each.item.opens?.repo === open.repo && each.item.opens.runId === open.runId,
    );
}
