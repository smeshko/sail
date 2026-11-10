// What each `data-action` does, as one function of the store apiece, and `dispatch()`, the delegated click's rule: a click
// on anything but a run action disarms an armed Resume, Restart, Stop or Clean (a registry action the actor carries out), on anything but a drop disarms an armed
// drop, and on anything but `watch-set` an armed unwatch; an item's menu and a run's menu shut by the same rule. No
// action opens a socket: what needs one goes through `streams.ts`, and what posts goes through `requests.ts`.

import { actionOf } from './action-registry';
import { closeFile, openedOutputKeys, openFile, readLog, readOutput, selectCard } from './reads';
import { watchSet } from './requests';
import { FILTER_KEY, RAIL_KEY, saveCleared, storedCleared, THEME_KEY } from './saved';
import type { Store } from './store';
import { reopenQueue, selectRun } from './streams';
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
  store.mark('rail', 'main');
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
    store.actor.clearResult('rail');
    leaveQueue(store);
    selectRun(store, data.repo, data.run);
  },
  'select-queue': (store, data) => {
    if (data.queue === undefined) return;
    reopenQueue(store, data.queue);
    store.ui.queue = data.queue;
    store.actor.clearResult('queue');
    store.mark('rail', 'main');
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
  'toggle-group': (store, data) => {
    const group = data.group ?? '';
    store.ui.expanded = store.ui.expanded.includes(group)
      ? store.ui.expanded.filter((each) => each !== group)
      : [...store.ui.expanded, group];
    store.host.save(RAIL_KEY, JSON.stringify(store.ui.expanded));
    store.mark('rail');
  },
  'item-menu': (store, data) => {
    if (store.ui.itemMenu === data.item || data.item === undefined) delete store.ui.itemMenu;
    else store.ui.itemMenu = data.item;
    store.mark('main');
  },
  'watch-set': (store, data) => {
    const { repo, op, workflow } = data;
    if (repo === undefined || (op !== 'watch' && op !== 'unwatch')) return;
    const id = workflow === undefined ? repo : `${repo}/${workflow}`;
    if (op === 'unwatch' && store.ui.armedWatch !== id) {
      store.ui.armedWatch = id;
      store.mark('rail');
      return;
    }
    delete store.ui.armedWatch;
    watchSet(store, repo, op, workflow);
  },
  // Ticking Stop now redraws an armed Stop's confirmation, which names what it will do.
  'stop-now': (store) => {
    store.ui.act.drafts['stop-run'] = {
      ...store.ui.act.drafts['stop-run'],
      now: store.host.value('now') === 'on' ? 'on' : '',
    };
    store.mark('rail');
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
      store.actor.disarm();
      store.mark('rail');
      return;
    }
    actions['select-run']?.(store, data);
    store.ui.runMenu = runId;
    store.mark('rail');
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
  'toggle-section': (store, data) => {
    const section = data.section ?? '';
    store.ui.open = store.ui.open.includes(section)
      ? store.ui.open.filter((open) => open !== section)
      : [...store.ui.open, section];
    store.mark('rail');
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
  const def = actionOf(action);
  // A registry action is carried out by the actor, which drops any confirmation but its own. A click on anything else
  // drops it, and `stop-now` keeps it: ticking the box redraws an armed Stop. An item's menu shuts on any click but its
  // ⋯, which toggles it, and the confirmed action of an item that arms. A run's menu shuts on any click but a run
  // action and a run's ⋯, which handles its own.
  const acts = def !== undefined && def.run === undefined;
  const runAction = action === 'stop-now' || (def?.appliesTo.includes('run') ?? false);
  const arming =
    def?.appliesTo.includes('item') === true && def.tier === 'confirmed' && !store.actor.armed(action, data);
  const shuts = ui.itemMenu !== undefined && action !== 'item-menu' && !arming;
  const shutsRun = ui.runMenu !== undefined && !runAction && action !== 'run-menu';
  const disarmed = !acts && action !== 'stop-now' && store.actor.disarm();
  if (ui.armedWatch !== undefined && action !== 'watch-set') {
    delete ui.armedWatch;
    store.mark('rail');
  }
  if (shuts) delete ui.itemMenu;
  if (shutsRun) delete ui.runMenu;
  if (disarmed || shuts || shutsRun) store.mark('main', 'rail');
  if (acts) store.actor.act(action, data);
  else actions[action]?.(store, data);
}
