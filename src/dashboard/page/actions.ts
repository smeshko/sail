// What each `data-action` does, as one function of the store apiece, and `dispatch()`, the delegated click's rule: a click
// on anything but a run action disarms an armed Resume, Restart, Stop or Clean, on anything but a drop disarms an armed
// drop, and on anything but `watch-set` an armed unwatch; an item's menu and a run's menu shut by the same rule. No
// action opens a socket: what needs one goes through `streams.ts`, and what posts goes through `requests.ts`.

import { VIEWS, type ViewName } from './list-model';
import { closeFile, openedOutputKeys, openFile, readLog, readOutput, selectCard } from './reads';
import { endRun, queueOp, startRun, watchSet } from './requests';
import { FILTER_KEY, LIST_KEY, saveCleared, storedCleared, THEME_KEY } from './saved';
import type { Store } from './store';
import { closeDetail, reopenQueue, selectRun } from './streams';
import { FILTERS, type InspectorTab, TABS, THEMES, type TimelineFilter } from './ui-state';

export type Action = (store: Store, data: Record<string, string>) => void;

/** Selects the card `by` places from the selected one. */
export function step(store: Store, by: number) {
  const { ui } = store;
  const cards = store.run?.model.cards ?? [];
  const at = cards.findIndex((entry) => entry.key === ui.key);
  const next = cards[at < 0 ? 0 : at + by];
  if (next !== undefined) selectCard(store, next.key);
}

export function leaveQueue(store: Store) {
  const { ui } = store;
  if (ui.queue === undefined) return;
  delete ui.queue;
  store.mark('list', 'main');
}

export function closeAttention(store: Store) {
  const { ui } = store;
  if (!ui.attention) return;
  ui.attention = false;
  store.mark('attention');
}

export const actions: Record<string, Action> = {
  'select-run': (store, data) => {
    if (data.repo === undefined || data.run === undefined) return;
    delete store.ui.indexNotice;
    leaveQueue(store);
    selectRun(store, data.repo, data.run);
  },
  'select-queue': (store, data) => {
    if (data.queue === undefined) return;
    reopenQueue(store, data.queue);
    store.ui.queue = data.queue;
    delete store.ui.queueNotice;
    store.mark('list', 'main');
  },
  'select-card': (store, data) => selectCard(store, data.key, undefined, true),
  open: (store, data) => {
    if (data.repo === undefined || data.run === undefined) return;
    closeAttention(store);
    leaveQueue(store);
    selectRun(store, data.repo, data.run);
    const tab = (TABS as readonly string[]).includes(data.tab ?? '') ? (data.tab as InspectorTab) : 'overview';
    if (data.key !== undefined) selectCard(store, data.key, tab, false);
  },
  'close-timeline': (store) => {
    store.ui.timeline = false;
    store.mark('main');
  },
  'open-file': (store, data) => {
    if (data.name !== undefined && data.path !== undefined) openFile(store, data.name, data.path);
  },
  'close-file': (store) => closeFile(store),
  'step-card': (store, data) => step(store, Number(data.by) < 0 ? -1 : 1),
  'toggle-tool': (store, data) => {
    const call = data.call;
    if (call === undefined) return;
    store.ui.opened = store.ui.opened.includes(call)
      ? store.ui.opened.filter((each) => each !== call)
      : [...store.ui.opened, call];
    if (openedOutputKeys(store).some((key) => store.outputs?.[key] === undefined)) readOutput(store);
    store.mark('main');
  },
  'toggle-filter': (store, data) => {
    if (!(FILTERS as readonly string[]).includes(data.filter ?? '')) return;
    const kind = data.filter as TimelineFilter;
    const hidden = store.ui.hidden.includes(kind)
      ? store.ui.hidden.filter((each) => each !== kind)
      : [...store.ui.hidden, kind];
    store.ui.hidden = FILTERS.filter((each) => hidden.includes(each));
    store.host.save(FILTER_KEY, store.ui.hidden.join(','));
    store.mark('main');
  },
  'show-all': (store) => {
    store.ui.hidden = [];
    store.host.save(FILTER_KEY, '');
    store.mark('main');
  },
  tab: (store, data) => {
    if (!(TABS as readonly string[]).includes(data.tab ?? '')) return;
    store.ui.tab = data.tab as InspectorTab;
    if (store.ui.tab === 'log') readLog(store);
    store.mark('inspector');
  },
  stream: (store, data) => {
    if (data.stream === undefined) return;
    store.ui.stream = data.stream;
    store.log = undefined;
    readLog(store);
    store.mark('inspector');
  },
  'log-step': (store, data) => {
    if (data.step === undefined) return;
    store.ui.step = data.step;
    delete store.ui.stream;
    store.log = undefined;
    readLog(store);
    store.mark('inspector');
  },
  'select-view': (store, data) => {
    if (!(VIEWS as readonly string[]).includes(data.view ?? '')) return;
    store.ui.view = data.view as ViewName;
    store.ui.listFilter = '';
    delete store.ui.listCursor;
    store.mark('sidebar', 'list');
  },
  'filter-repo': (store, data) => {
    if (data.repo === undefined) return;
    if (store.ui.repoFilter === data.repo) delete store.ui.repoFilter;
    else store.ui.repoFilter = data.repo;
    store.mark('sidebar', 'list');
  },
  'toggle-list-group': (store, data) => {
    const group = data.group ?? '';
    store.ui.listFolded = store.ui.listFolded.includes(group)
      ? store.ui.listFolded.filter((each) => each !== group)
      : [...store.ui.listFolded, group];
    store.host.save(LIST_KEY, JSON.stringify(store.ui.listFolded));
    store.mark('list');
  },
  'close-detail': (store) => closeDetail(store),
  // What was typed in the list's filter field, which `onInput` delivers under the field's name.
  'list-filter': (store, data) => {
    store.ui.listFilter = data.value ?? '';
    store.mark('list');
  },
  'move-item': (store, data) => {
    const { dir, repo, workflow, key, target } = data;
    if (repo === undefined || workflow === undefined || key === undefined || target === undefined) return;
    const body = dir === 'up' ? { dedupKey: key, before: target } : { dedupKey: key, after: target };
    queueOp(store, repo, workflow, 'move', body);
  },
  'poll-queue': (store, data) => {
    if (data.repo === undefined || data.workflow === undefined) return;
    queueOp(store, data.repo, data.workflow, 'poll', {});
  },
  'add-ticket': (store, data) => {
    const { repo, workflow } = data;
    if (repo === undefined || workflow === undefined) return;
    store.ui.addTicket = store.host.value('add-ticket') ?? store.ui.addTicket;
    const forced = store.host.value('add-force');
    if (forced !== undefined) store.ui.addForce = forced !== '';
    const ticketKey = (store.ui.addTicket ?? '').trim();
    if (ticketKey === '') return;
    queueOp(
      store,
      repo,
      workflow,
      'add',
      store.ui.addForce === true ? { ticketKey, force: true } : { ticketKey },
      () => {
        delete store.ui.addTicket;
        store.addFieldsOwn = false;
        store.fresh.add('main');
      },
    );
  },
  'item-menu': (store, data) => {
    if (store.ui.itemMenu === data.item || data.item === undefined) delete store.ui.itemMenu;
    else store.ui.itemMenu = data.item;
    store.mark('main');
  },
  'requeue-item': (store, data) => {
    if (data.repo === undefined || data.workflow === undefined || data.item === undefined) return;
    queueOp(store, data.repo, data.workflow, 'requeue', { dedupKey: data.item });
  },
  'drop-item': (store, data) => {
    if (data.repo === undefined || data.workflow === undefined || data.item === undefined) return;
    if (store.ui.armedDrop !== data.item) {
      store.ui.armedDrop = data.item;
      store.mark('main');
      return;
    }
    delete store.ui.armedDrop;
    queueOp(store, data.repo, data.workflow, 'drop', { dedupKey: data.item });
  },
  'watch-set': (store, data) => {
    const { repo, op, workflow } = data;
    if (repo === undefined || (op !== 'watch' && op !== 'unwatch')) return;
    const id = workflow === undefined ? repo : `${repo}/${workflow}`;
    if (op === 'unwatch' && store.ui.armedWatch !== id) {
      store.ui.armedWatch = id;
      store.mark('list', 'main');
      return;
    }
    delete store.ui.armedWatch;
    watchSet(store, repo, op, workflow);
  },
  'resume-run': (store) => startRun(store, 'resume'),
  'restart-run': (store) => startRun(store, 'restart'),
  'stop-run': (store) => endRun(store, 'stop'),
  'clean-run': (store) => endRun(store, 'clean'),
  // Ticking Stop now redraws an armed Stop's confirmation, which names what it will do.
  'stop-now': (store) => {
    store.ui.stopNow = store.host.value('now') === 'on';
    store.mark('list');
  },
  // A run's ⋯ opens it and its menu under its row; on the open menu's run, it shuts the menu.
  'run-menu': (store, data) => {
    const { repo, run: runId } = data;
    if (repo === undefined || runId === undefined) return;
    if (
      store.ui.runMenu === runId &&
      store.ui.queue === undefined &&
      store.run?.repo === repo &&
      store.run.runId === runId
    ) {
      delete store.ui.runMenu;
      delete store.ui.armed;
      store.mark('list');
      return;
    }
    actions['select-run']?.(store, data);
    store.ui.runMenu = runId;
    store.mark('list');
  },
  'toggle-queue-events': (store) => {
    store.ui.queueEvents = !store.ui.queueEvents;
    store.mark('main');
  },
  'toggle-queue-section': (store, data) => {
    const section = data.section;
    if (!section) return;
    store.ui.folded = store.ui.folded.includes(section)
      ? store.ui.folded.filter((id) => id !== section)
      : [...store.ui.folded, section];
    store.mark('main');
  },
  'toggle-attention': (store) => {
    store.ui.attention = !store.ui.attention;
    store.mark('attention');
  },
  'clear-attention': (store) => {
    store.cleared = new Set([...storedCleared(store.host), ...store.cleared, ...store.drawn]);
    saveCleared(store.host, store.cleared);
    store.mark('attention');
  },
  'toggle-inspector': (store) => {
    store.ui.inspector = !store.ui.inspector;
    store.host.setInspector(store.ui.inspector);
  },
  'toggle-theme': (store) => {
    store.ui.theme = THEMES[(THEMES.indexOf(store.ui.theme) + 1) % THEMES.length] ?? 'dark';
    store.host.save(THEME_KEY, store.ui.theme);
    store.host.setTheme(store.ui.theme);
  },
  'toggle-follow': (store) => {
    store.ui.follow = !store.ui.follow;
    store.mark('main', 'inspector');
  },
  copy: (store, data) => {
    if (data.text !== undefined) void store.host.copy(data.text);
  },
};

export function dispatch(store: Store, action: string, data: Record<string, string>) {
  const { ui } = store;
  // A click on anything but a run action disarms it, and on anything but a drop disarms that. An item's menu shuts on
  // any click but its ⋯, which toggles it, and the drop that arms. A run's menu shuts on any click but a run action
  // and a run's ⋯, which handles its own.
  const runAction = ['resume-run', 'restart-run', 'stop-run', 'stop-now', 'clean-run'].includes(action);
  const shuts =
    ui.itemMenu !== undefined && action !== 'item-menu' && !(action === 'drop-item' && ui.armedDrop !== data.item);
  const shutsRun = ui.runMenu !== undefined && !runAction && action !== 'run-menu';
  const disarms =
    (ui.armed !== undefined && !runAction) ||
    (ui.armedDrop !== undefined && action !== 'drop-item') ||
    shuts ||
    shutsRun;
  if (ui.armed !== undefined && !runAction) delete ui.armed;
  if (ui.armedDrop !== undefined && action !== 'drop-item') delete ui.armedDrop;
  if (ui.armedWatch !== undefined && action !== 'watch-set') {
    delete ui.armedWatch;
    store.mark('list', 'main');
  }
  if (shuts) delete ui.itemMenu;
  if (shutsRun) delete ui.runMenu;
  if (disarms) store.mark('main', 'list');
  actions[action]?.(store, data);
}
