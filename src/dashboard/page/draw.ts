// The page's draw loop: what each region is drawn from, the flush that draws the regions marked dirty and writes only
// those whose markup changed, and the one-second tick that draws the running times again while anything runs. A region
// that can't be drawn says so, and the others are still drawn.
import { renderDrawer } from './drawer-view';
import { REGIONS, type Region } from './host';
import { html } from './html';
import { listRepos, statusOf } from './index-model';
import { renderInspector } from './inspector-view';
import { filterRows, groupsOf, viewCounts } from './list-model';
import { renderList } from './list-view';
import { hasItemActions, offeredDrop, renderQueue } from './queue-view';
import { renderRun, renderStatus } from './run-view';
import { renderSidebar } from './sidebar-view';
import { listed, opened, openQueue, type Store, selected, summaryOf } from './store';
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
      // A raise typed and a stage chosen in the open run's menu survive the draw, but not a switch of run.
      store.actor.keep('run');
      const items = listed(store);
      const repos = listRepos(store.index, host.now());
      // All clear hides the Inbox's rows as they are drawn: its shown rows, under the repository filter and the filter field.
      store.drawn =
        ui.view === 'inbox'
          ? filterRows(groupsOf('inbox', repos, ui.repoFilter, items), ui.listFilter).flatMap((group) =>
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
        // So do both while the workflow isn't watched: the controls are disabled then.
        const unwatched = panel.watch.state !== 'watched';
        const asked = store.actor.dialogFor();
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
        const repoOffers = store.index?.find((repo) => repo.name === panel.repo)?.offers;
        return renderQueue(panel, store.queues.get(ui.queue ?? '')?.stream, ui, host.now(), repoOffers).value;
      }
      if (store.run === undefined) return html`<div class="qempty">no run selected</div>`.value;
      const error = store.run.error === undefined ? '' : html`<div class="code bad">${store.run.error}</div>`;
      const card = opened(store);
      const view =
        card === undefined
          ? renderRun(store.run.model, summaryOf(store, store.run), ui, host.now())
          : renderTimeline(card, ui, host.now(), store.outputs);
      return html`${error}${view}`.value;
    },
    inspector: () => renderInspector(selected(store), store.run?.model.roster, store.result, store.log, ui).value,
    status: () => (store.run === undefined ? '' : renderStatus(store.run.model, summaryOf(store, store.run)).value),
    drawer: () => renderDrawer(ui, store.doc).value,
    toasts: () => renderToasts(ui.toasts).value,
  };
}

/** Draws each dirty region in `REGIONS` order, and writes only those whose markup is not what it was. */
export function flush(store: Store): void {
  const { ui, host } = store;
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
    // Only a cursor move scrolls the list: a redraw such as the tick leaves where the person scrolled it (review R8).
    if (region === 'list' && store.revealList) {
      store.revealList = false;
      host.reveal('list');
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
