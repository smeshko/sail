// What each view `data-action` does, as one function of the store apiece, and `dispatch()`, the delegated click's rule.
// An action of the registry (`action-registry.ts`) is carried out by the actor (`act.ts`), which drops any confirmation
// but its own. An item's menu and a run's menu shut by the rules below. No
// action opens a socket: what needs one goes through `streams.ts`, and what posts goes through the actor.

import { actionOf } from './action-registry';
import { VIEWS, type ViewName } from './list-model';
import { syncUrl } from './location';
import { closeFile, openedOutputKeys, openFile, readLog, readOutput, selectCard } from './reads';
import { FILTER_KEY, LIST_KEY, THEME_KEY } from './saved';
import type { Store } from './store';
import { closeDetail, reopenQueue, selectRun } from './streams';
import { dismissToast, toast, undoToast } from './toast';
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
  store.mark('list', 'main', 'inspector', 'status');
}

export function closeAttention(store: Store) {
  const { ui } = store;
  if (!ui.attention) return;
  ui.attention = false;
  store.mark('attention');
}

/** Shuts the folded sidebar, when it is open. */
export function shutSidebar(store: Store) {
  if (!store.ui.sidebar) return;
  store.ui.sidebar = false;
  store.host.setSidebar(false);
}

export const actions: Record<string, Action> = {
  'select-run': (store, data) => {
    if (data.repo === undefined || data.run === undefined) return;
    leaveQueue(store);
    selectRun(store, data.repo, data.run);
  },
  'select-queue': (store, data) => {
    if (data.queue === undefined) return;
    reopenQueue(store, data.queue);
    store.ui.queue = data.queue;
    store.mark('list', 'main', 'inspector', 'status');
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
    // The filter field gives up what was typed in it, so it reads as empty as the filter now is.
    store.fresh.add('list');
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
  'item-menu': (store, data) => {
    if (store.ui.itemMenu === data.item || data.item === undefined) delete store.ui.itemMenu;
    else store.ui.itemMenu = data.item;
    store.mark('main');
  },
  // A run's ⋯ opens it and its menu under its row; on the open menu's run, it shuts the menu.
  'run-menu': (store, data) => {
    const { repo, run: runId } = data;
    if (repo === undefined || runId === undefined) return;
    const at = data.at === 'header' ? 'header' : 'row';
    // A dialog open for a run closes with nothing sent when its menu is toggled or another run's opened.
    if (store.actor.dialogFor()?.kind === 'run') store.actor.cancel();
    if (
      store.ui.runMenu?.runId === runId &&
      store.ui.runMenu.at === at &&
      store.ui.queue === undefined &&
      store.run?.repo === repo &&
      store.run.runId === runId
    ) {
      delete store.ui.runMenu;
      store.mark('list', 'main');
      return;
    }
    actions['select-run']?.(store, data);
    store.ui.runMenu = { runId, at };
    store.mark('list', 'main');
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
  'toggle-inspector': (store) => {
    store.ui.pinned = !store.ui.pinned;
    store.mark('inspector');
  },
  // The inspector's own close button, for a pointer under 1100px where it lies over the centre: it unpins it and
  // deselects its card, as `i` and Esc do.
  'close-inspector': (store) => {
    store.ui.pinned = false;
    if (store.ui.key !== undefined) selectCard(store, undefined);
    store.mark('inspector');
  },
  'toggle-sidebar': (store) => {
    store.ui.sidebar = !store.ui.sidebar;
    store.host.setSidebar(store.ui.sidebar);
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
  // Copies the page's URL, and says in a toast whether the clipboard took it.
  'copy-link': (store) => {
    const { host } = store;
    void host.copy(host.href()).then((copied) => {
      if (store.stopped) return;
      if (copied) toast(store, 'ok', 'copy link', 'link copied');
      else toast(store, 'bad', 'copy link', 'the link could not be copied');
    });
  },
  copy: (store, data) => {
    const { text } = data;
    if (text === undefined) return;
    void store.host.copy(text).then((copied) => {
      if (store.stopped) return;
      if (copied) toast(store, 'ok', 'copy', `copied ${text}`);
      else toast(store, 'bad', 'copy', 'the clipboard refused it');
    });
  },
  'dialog-confirm': (store) => store.actor.confirm(),
  'dialog-cancel': (store) => store.actor.cancel(),
  // A field of the dialog changed: its lines follow it.
  'dialog-change': (store) => store.actor.changed(),
  'dismiss-toast': (store, data) => dismissToast(store, Number(data.toast)),
  'undo-toast': (store, data) => undoToast(store, Number(data.toast)),
};

export function dispatch(store: Store, action: string, data: Record<string, string>) {
  const { ui } = store;
  const def = actionOf(action);
  // A registry action is carried out by the actor. An item's menu shuts on any click but its ⋯, which toggles it, an
  // item's confirmed action, whose dialog opens over it, and the dialog's own buttons. A run's menu shuts on any click
  // but a run action, a run's ⋯, which handles its own, and the dialog's buttons.
  const acts = def !== undefined;
  const runAction = def?.appliesTo.includes('run') ?? false;
  const confirming = def?.appliesTo.includes('item') === true && def.tier === 'confirmed';
  const dialogClick = action === 'dialog-confirm' || action === 'dialog-cancel' || action === 'dialog-change';
  const shuts = ui.itemMenu !== undefined && action !== 'item-menu' && !confirming && !dialogClick;
  const shutsRun = ui.runMenu !== undefined && !runAction && action !== 'run-menu' && !dialogClick;
  // The folded sidebar shuts on any action but its own button. A view or a repository chosen in it closes the open run
  // or queue, which hides the list under 800px, so the choice shows.
  if (ui.sidebar && (action === 'select-view' || action === 'filter-repo')) closeDetail(store);
  if (action !== 'toggle-sidebar') shutSidebar(store);
  if (shuts) delete ui.itemMenu;
  if (shutsRun) delete ui.runMenu;
  if (shuts || shutsRun) store.mark('main', 'list');
  if (acts) store.actor.act(action, data);
  else actions[action]?.(store, data);
  syncUrl(store, true);
}
