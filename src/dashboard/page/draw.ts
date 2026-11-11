// The page's draw loop: what each region is drawn from, the flush that draws the regions marked dirty and writes only
// those whose markup changed, and the one-second tick that draws the running times again while anything runs. A region
// that can't be drawn says so, and the others are still drawn.
import { renderDrawer } from './drawer-view';
import { renderEmpty } from './empty-view';
import { syncOpen } from './focus';
import { REGIONS, type Region } from './host';
import { html } from './html';
import { listRepos, statusOf } from './index-model';
import { renderInspector } from './inspector-view';
import { renderSheet } from './keys-view';
import { filterRows, groupsOf, shownGroups, viewCounts } from './list-model';
import { renderList } from './list-view';
import { highlighted, modelOf } from './menu';
import { renderMenu } from './menu-view';
import { hasItemActions, offeredDrop, renderQueue } from './queue-view';
import { renderRun, renderStatus } from './run-view';
import { renderSidebar } from './sidebar-view';
import {
  centreCard,
  centreRun,
  inspectorOpen,
  keyedPane,
  listed,
  opened,
  openQueue,
  problemOf,
  type Store,
  selected,
  summaryOf,
} from './store';
import { renderTimeline } from './timeline-view';
import { renderToasts } from './toast-view';

/** How often a running time is drawn again. */
export const TICK_MS = 1000;

/** What each region is drawn from, field-keeping and open-dialog rules included. */
export function regions(store: Store): Record<Region, () => string> {
  const { ui, host } = store;
  return {
    sidebar: () => {
      if (store.index === undefined) return '';
      const repos = listRepos(store.index, host.now());
      return renderSidebar(repos, viewCounts(repos, ui.repoFilter, listed(store)), ui).value;
    },
    list: () => {
      if (store.index === undefined) return html`<div class="qempty">connecting…</div>`.value;
      const items = listed(store);
      const repos = listRepos(store.index, host.now());
      // All clear hides the Inbox's rows as they are drawn: its shown rows, under the repository filter and the filter field.
      store.drawn =
        ui.view === 'inbox'
          ? filterRows(
              groupsOf('inbox', repos, ui.repoFilter, { now: host.now(), tz: ui.tz }, items),
              ui.listFilter,
            ).flatMap((group) =>
              group.rows.flatMap((row) => (row.kind === 'attention' ? [row.id.slice('inbox:'.length)] : [])),
            )
          : [];
      return renderList(ui.view, repos, ui, host.now(), store.offers, items).value;
    },
    link: () =>
      html`<button class="btn" type="button" data-action="copy-link" aria-label="copy link" title="copy link">⧉</button>`
        .value,
    main: () => {
      const panel = openQueue(store);
      if (panel !== undefined) {
        // What was typed in the add field survives the draw, but not an add that took.
        store.actor.keep('queue', { kind: 'workflow', repo: panel.repo, workflow: panel.workflow });
        // A drop dialog whose item can't be dropped now (it runs, or is gone) closes with nothing sent, and its menu shuts.
        // So do both while the workflow isn't watched, and so does a dialog of the workflow's own (an add skipping its
        // checks): the controls are disabled then.
        const unwatched = panel.watch.state !== 'watched';
        const asked = store.actor.dialogFor();
        if (asked?.kind === 'workflow' && asked.repo === panel.repo && asked.workflow === panel.workflow && unwatched)
          store.actor.cancel();
        if (asked?.kind === 'item' && asked.repo === panel.repo && asked.workflow === panel.workflow) {
          const target = panel.items.find((each) => each.dedupKey === asked.item);
          if (unwatched || target === undefined || !offeredDrop(panel, target)) store.actor.cancel();
        }
        // A release dialog, the one a queue's banner opens, closes with nothing sent once its queue is held on a key no more.
        if (
          asked?.kind === 'workflow' &&
          asked.repo === panel.repo &&
          asked.workflow === panel.workflow &&
          panel.queue?.held?.harnessKey === undefined
        ) {
          store.actor.cancel();
        }
        const menuItem = panel.items.find((item) => item.dedupKey === ui.itemMenu);
        if (unwatched || menuItem === undefined || !hasItemActions(panel, menuItem)) delete ui.itemMenu;
        return renderQueue(panel, store.queues.get(ui.queue ?? '')?.stream, ui, host.now()).value;
      }
      if (store.run === undefined)
        return renderEmpty(
          ui.view,
          // What the list shows, its filters applied, so the counts are the rows beside them.
          store.index === undefined
            ? undefined
            : shownGroups(ui.view, listRepos(store.index, host.now()), ui, host.now(), listed(store)),
          ui,
          store.index?.length,
        ).value;
      const error = store.run.error === undefined ? '' : html`<div class="code bad">${store.run.error}</div>`;
      const card = opened(store);
      const view =
        card === undefined
          ? renderRun(store.run.model, summaryOf(store, store.run), ui, host.now(), store.offers, problemOf(store))
          : renderTimeline(card, ui, host.now(), store.outputs);
      return html`${error}${view}`.value;
    },
    inspector: () =>
      renderInspector(centreCard(store), centreRun(store)?.model.roster, store.result, store.log, ui).value,
    status: () => {
      const run = centreRun(store);
      return run === undefined ? '' : renderStatus(run.model, summaryOf(store, run)).value;
    },
    drawer: () => renderDrawer(ui, store.doc).value,
    menu: () => {
      const { menu } = ui;
      // The shortcut sheet is drawn in the menu's place while no menu is open.
      if (menu === undefined) return ui.sheet ? renderSheet().value : '';
      const model = modelOf(store, menu);
      return renderMenu({ ...menu, at: highlighted(model, menu.at, menu.row) }, model).value;
    },
    toasts: () => renderToasts(ui.toasts).value,
  };
}

/** Draws each dirty region in `REGIONS` order, and writes only those whose markup is not what it was. */
export function flush(store: Store): void {
  const { ui, host } = store;
  syncOpen(store);
  const draw = regions(store);
  store.flushTimer = undefined;
  const dirty = REGIONS.filter((region) => store.dirty.has(region));
  store.dirty.clear();
  // The run or queue beside the list, or the list alone: the host lays the centre out by it.
  const detail = store.run !== undefined || openQueue(store) !== undefined;
  if (detail !== store.detail) {
    store.detail = detail;
    host.setDetail(detail);
  }
  // The keyed pane, which the page marks while both panes show (ADW-535).
  const pane = keyedPane(store);
  if ((pane ?? 'none') !== store.keyed) {
    store.keyed = pane ?? 'none';
    host.setKeys(pane);
  }
  // The inspector's room: open with a selected card of the run the centre shows, or pinned.
  const inspector = `${inspectorOpen(store)} ${ui.pinned}`;
  if (inspector !== store.inspector) {
    store.inspector = inspector;
    host.setInspector(inspectorOpen(store), ui.pinned);
  }
  // A raise typed and a stage chosen in the open run's view header or row menu survive the draw, but not a switch of run:
  // read once, before either region is written, so the one-shot flag covers both.
  if (dirty.includes('list') || dirty.includes('main')) store.actor.keep('run');
  for (const region of dirty) {
    // A region that can't be drawn says so, and the others are still drawn (review R2-1).
    let markup: string;
    try {
      markup = draw[region]();
    } catch {
      markup = html`<div class="code bad">this part of the page could not be drawn</div>`.value;
    }
    // A region whose markup is what it was is not written, nor is its timeline scrolled, unless the shell has just
    // given up its fields: then it is written so they hold the markup's values.
    const isFresh = store.fresh.delete(region);
    if (!isFresh && store.written.get(region) === markup) continue;
    store.written.set(region, markup);
    host.render(region, markup, isFresh);
    // The menu takes the focus once it is drawn: its field, or the menu itself.
    if (region === 'menu' && store.menuFocus) {
      store.menuFocus = false;
      host.focusMenu();
    }
    // Only a cursor move scrolls the list: a redraw such as the tick leaves where the person scrolled it (review R8).
    if (region === 'list' && store.revealList) {
      store.revealList = false;
      host.reveal('list');
    }
    // The open row, when it changed, is scrolled into sight once the list is drawn; a list left as it was keeps the flag.
    if (region === 'list' && store.revealOpen) {
      store.revealOpen = false;
      host.reveal('list', 'sel');
    }
    // A running call's timeline, followed, shows its newest entry: not while the queue holds the centre.
    if (region === 'main' && ui.follow && openQueue(store) === undefined && opened(store)?.state === 'running')
      host.scrollToEnd(region);
  }
}

/** Makes the draw loop's flush the store's. */
export function startDraw(store: Store): void {
  store.flush = () => flush(store);
}

/** Whether a running time is on screen: the open run's, one of its calls', or a run's in the list. */
export function anyRunning(store: Store): boolean {
  return (
    (store.run !== undefined &&
      store.run.model.end === undefined &&
      store.run.model.cards.some((card) => card.state === 'running')) ||
    (store.index ?? []).some((repo) => repo.runs.some((item) => statusOf(item) === 'running'))
  );
}

/** Draws the running times again each second, for as long as something runs. */
export function tick(store: Store): void {
  if (store.tickTimer !== undefined || store.stopped || !anyRunning(store)) return;
  store.tickTimer = store.host.later(() => {
    store.tickTimer = undefined;
    if (!anyRunning(store)) return;
    store.mark('list', 'main', 'status');
    if (selected(store)?.state === 'running') store.mark('inspector');
    tick(store);
  }, TICK_MS);
}
