import { startDraw } from './draw';
import type { PageHost } from './host';
import { REGIONS } from './host';
import { closeFile, openedOutputKeys, openFile, readLog, readOutput, selectCard, stopReads } from './reads';
import { FILTER_KEY, RAIL_KEY, saveCleared, storedCleared, THEME_KEY } from './saved';
import { createStore } from './store';
import { closeRun, openIndex, reopenQueue, selectRun, stopStreams } from './streams';
import { FILTERS, type InspectorTab, TABS, THEMES, type TimelineFilter, type UiState } from './ui-state';

export { TICK_MS } from './draw';
export { LOG_REFRESH_MS } from './reads';
export { CLEARED_KEY, FILTER_KEY, RAIL_KEY, THEME_KEY } from './saved';
export { FLUSH_MS } from './store';
export { RECENT_EVENTS, RECONNECT_MS } from './streams';

export interface Page {
  stop(): void;
  /** What the page holds, for tests. */
  readonly ui: UiState;
}

const enc = encodeURIComponent;

/** The keys that move the card cursor, and by how much. */
const MOVES: Record<string, number> = { j: 1, ArrowDown: 1, ArrowRight: 1, k: -1, ArrowUp: -1, ArrowLeft: -1 };

/** Why a request of kind `what` (a move, a resume, a restart) was refused: the `error` its answer carries, else its status. */
function refusal(status: number, body: string, what: string): string {
  if (status === 0) return `the ${what} could not be sent: the dashboard did not answer`;
  try {
    const { error } = JSON.parse(body) as { error?: unknown };
    if (typeof error === 'string' && error !== '') return error;
  } catch {
    // An answer that isn't JSON is told by its status.
  }
  return `the ${what} was refused (${status})`;
}

/** The string field `field` of a JSON answer, undefined when it has none. */
function answerField(body: string, field: string): string | undefined {
  try {
    const value = (JSON.parse(body) as Record<string, unknown>)[field];
    return typeof value === 'string' && value !== '' ? value : undefined;
  } catch {
    return undefined;
  }
}

export function boot(host: PageHost): Page {
  const store = createStore(host);
  const ui = store.ui;

  startDraw(store);

  const step = (by: number) => {
    const cards = store.run?.model.cards ?? [];
    const at = cards.findIndex((entry) => entry.key === ui.key);
    const next = cards[at < 0 ? 0 : at + by];
    if (next !== undefined) selectCard(store, next.key);
  };

  /** Gives the centre back to the run, from the queue it showed. */
  /**
   * Asks the server to have the watcher `what` the queue of `workflow`, and shows the answer beside the queue's header: a
   * 200's message, what a 202 says the watcher has yet to do, or why it was refused. `took` runs when the change was applied.
   */
  const queueOp = (repo: string, workflow: string, what: string, body: unknown, took?: () => void) => {
    const path = `/api/repos/${enc(repo)}/queues/${enc(workflow)}/${what}`;
    void host.post(path, body).then(({ status, body: answer }) => {
      if (store.stopped) return;
      if (status === 200 || status === 202) {
        const notice = answerField(answer, status === 200 ? 'message' : 'waiting');
        if (notice === undefined) delete ui.queueNotice;
        else ui.queueNotice = notice;
        if (status === 200) took?.();
      } else ui.queueNotice = refusal(status, answer, what);
      store.mark('main');
    });
  };

  const leaveQueue = () => {
    if (ui.queue === undefined) return;
    delete ui.queue;
    store.mark('rail', 'main');
  };

  const closeAttention = () => {
    if (!ui.attention) return;
    ui.attention = false;
    store.mark('attention');
  };

  /**
   * A first click arms Resume or Restart, which then reads what it will do; a second click posts it. A raise that isn't
   * a positive number, or a stage changed since the arming, arms again instead.
   */
  const startRun = (kind: 'resume' | 'restart') => {
    const open = store.run;
    const offer = kind === 'resume' ? store.offers?.resume : store.offers?.restart;
    if (open === undefined || offer === undefined || !offer.enabled || store.starting) return;
    const stage =
      kind === 'restart' ? (host.value('stage') ?? ui.restartStage ?? store.offers?.restart?.stage) : undefined;
    if (kind === 'restart') ui.restartStage = stage;
    let body: Record<string, unknown> = kind === 'restart' ? { stage } : {};
    const raising = store.offers?.resume?.raise;
    if (kind === 'resume' && raising !== undefined) {
      ui.raise = host.value('raise') ?? ui.raise;
      const amount = Number(ui.raise);
      if (ui.raise === undefined || ui.raise.trim() === '' || !Number.isFinite(amount) || amount < 0.01) {
        delete ui.armed;
        ui.runNotice = `give the ${raising === 'usd' ? 'dollars' : 'minutes'} to raise the budget by: at least 0.01`;
        store.mark('rail');
        return;
      }
      body = { raise: { [raising]: amount } };
    }
    if (ui.armed !== kind || store.armedStage !== stage) {
      ui.armed = kind;
      store.armedStage = stage;
      delete ui.runNotice;
      store.mark('rail');
      return;
    }
    delete ui.armed;
    store.starting = true;
    ui.runNotice = `${kind === 'resume' ? 'resuming' : 'restarting'} ${open.runId}…`;
    store.mark('rail');
    void host
      .post(`/api/repos/${enc(open.repo)}/runs/${enc(open.runId)}/${kind}`, body)
      .then(({ status, body: answer }) => {
        store.starting = false;
        if (store.stopped) return;
        if (status < 200 || status >= 300) {
          ui.runNotice = refusal(status, answer, kind);
          store.mark('rail');
          return;
        }
        delete ui.runNotice;
        if (store.run !== open) return;
        if (kind === 'resume') {
          closeRun(store);
          selectRun(store, open.repo, open.runId);
          return;
        }
        try {
          const { runId } = JSON.parse(answer) as { runId?: unknown };
          if (typeof runId === 'string') selectRun(store, open.repo, runId);
        } catch {
          // An answer with no run id leaves the run open.
        }
        store.mark('rail');
      });
  };

  /**
   * A first click arms Stop or Clean, which then names what it will do; a second click posts it. Stop posts `{ now }`
   * and reads the run again. Clean posts `{}` and, once the run is gone, leaves it and shows the answer in the rail.
   */
  const endRun = (kind: 'stop' | 'clean') => {
    const open = store.run;
    const offer = kind === 'stop' ? store.offers?.stop : store.offers?.clean;
    if (open === undefined || offer === undefined || !offer.enabled || store.starting) return;
    if (kind === 'stop') ui.stopNow = (host.value('now') ?? (ui.stopNow === true ? 'on' : '')) !== '';
    if (ui.armed !== kind) {
      ui.armed = kind;
      delete ui.runNotice;
      store.mark('rail');
      return;
    }
    delete ui.armed;
    store.starting = true;
    ui.runNotice = `${kind === 'stop' ? 'stopping' : 'cleaning'} ${open.runId}…`;
    store.mark('rail');
    void host
      .post(
        `/api/repos/${enc(open.repo)}/runs/${enc(open.runId)}/${kind}`,
        kind === 'stop' ? { now: ui.stopNow === true } : {},
      )
      .then(({ status, body: answer }) => {
        store.starting = false;
        if (store.stopped) return;
        if (status < 200 || status >= 300) {
          ui.runNotice = refusal(status, answer, kind);
          store.mark('rail');
          return;
        }
        delete ui.runNotice;
        if (store.run !== open) return;
        const message = answerField(answer, 'message');
        if (kind === 'clean') {
          closeRun(store);
          if (message === undefined) delete ui.indexNotice;
          else ui.indexNotice = message;
          store.mark('rail', 'main', 'inspector', 'status');
          return;
        }
        const menu = ui.runMenu;
        closeRun(store);
        selectRun(store, open.repo, open.runId);
        // The menu the stop was made from stays open on the run read again, with the answer.
        if (menu !== undefined) ui.runMenu = menu;
        if (message !== undefined) ui.runNotice = message;
      });
  };

  const actions: Record<string, (data: Record<string, string>) => void> = {
    'select-run': (data) => {
      if (data.repo === undefined || data.run === undefined) return;
      delete ui.indexNotice;
      leaveQueue();
      selectRun(store, data.repo, data.run);
    },
    'select-queue': (data) => {
      if (data.queue === undefined) return;
      reopenQueue(store, data.queue);
      ui.queue = data.queue;
      delete ui.queueNotice;
      store.mark('rail', 'main');
    },
    'select-card': (data) => selectCard(store, data.key, undefined, true),
    open: (data) => {
      if (data.repo === undefined || data.run === undefined) return;
      closeAttention();
      leaveQueue();
      selectRun(store, data.repo, data.run);
      const tab = (TABS as readonly string[]).includes(data.tab ?? '') ? (data.tab as InspectorTab) : 'overview';
      if (data.key !== undefined) selectCard(store, data.key, tab, false);
    },
    'close-timeline': () => {
      ui.timeline = false;
      store.mark('main');
    },
    'open-file': (data) => {
      if (data.name !== undefined && data.path !== undefined) openFile(store, data.name, data.path);
    },
    'close-file': () => closeFile(store),
    'step-card': (data) => step(Number(data.by) < 0 ? -1 : 1),
    'toggle-tool': (data) => {
      const call = data.call;
      if (call === undefined) return;
      ui.opened = ui.opened.includes(call) ? ui.opened.filter((each) => each !== call) : [...ui.opened, call];
      if (openedOutputKeys(store).some((key) => store.outputs?.[key] === undefined)) readOutput(store);
      store.mark('main');
    },
    'toggle-filter': (data) => {
      if (!(FILTERS as readonly string[]).includes(data.filter ?? '')) return;
      const kind = data.filter as TimelineFilter;
      const hidden = ui.hidden.includes(kind) ? ui.hidden.filter((each) => each !== kind) : [...ui.hidden, kind];
      ui.hidden = FILTERS.filter((each) => hidden.includes(each));
      host.save(FILTER_KEY, ui.hidden.join(','));
      store.mark('main');
    },
    'show-all': () => {
      ui.hidden = [];
      host.save(FILTER_KEY, '');
      store.mark('main');
    },
    tab: (data) => {
      if (!(TABS as readonly string[]).includes(data.tab ?? '')) return;
      ui.tab = data.tab as InspectorTab;
      if (ui.tab === 'log') readLog(store);
      store.mark('inspector');
    },
    stream: (data) => {
      if (data.stream === undefined) return;
      ui.stream = data.stream;
      store.log = undefined;
      readLog(store);
      store.mark('inspector');
    },
    'log-step': (data) => {
      if (data.step === undefined) return;
      ui.step = data.step;
      delete ui.stream;
      store.log = undefined;
      readLog(store);
      store.mark('inspector');
    },
    'toggle-group': (data) => {
      const group = data.group ?? '';
      ui.expanded = ui.expanded.includes(group)
        ? ui.expanded.filter((each) => each !== group)
        : [...ui.expanded, group];
      host.save(RAIL_KEY, JSON.stringify(ui.expanded));
      store.mark('rail');
    },
    'move-item': (data) => {
      const { dir, repo, workflow, key, target } = data;
      if (repo === undefined || workflow === undefined || key === undefined || target === undefined) return;
      const body = dir === 'up' ? { dedupKey: key, before: target } : { dedupKey: key, after: target };
      queueOp(repo, workflow, 'move', body);
    },
    'poll-queue': (data) => {
      if (data.repo === undefined || data.workflow === undefined) return;
      queueOp(data.repo, data.workflow, 'poll', {});
    },
    'add-ticket': (data) => {
      const { repo, workflow } = data;
      if (repo === undefined || workflow === undefined) return;
      ui.addTicket = host.value('add-ticket') ?? ui.addTicket;
      const forced = host.value('add-force');
      if (forced !== undefined) ui.addForce = forced !== '';
      const ticketKey = (ui.addTicket ?? '').trim();
      if (ticketKey === '') return;
      queueOp(repo, workflow, 'add', ui.addForce === true ? { ticketKey, force: true } : { ticketKey }, () => {
        delete ui.addTicket;
        store.addFieldsOwn = false;
        store.fresh.add('main');
      });
    },
    'item-menu': (data) => {
      if (ui.itemMenu === data.item || data.item === undefined) delete ui.itemMenu;
      else ui.itemMenu = data.item;
      store.mark('main');
    },
    'requeue-item': (data) => {
      if (data.repo === undefined || data.workflow === undefined || data.item === undefined) return;
      queueOp(data.repo, data.workflow, 'requeue', { dedupKey: data.item });
    },
    'drop-item': (data) => {
      if (data.repo === undefined || data.workflow === undefined || data.item === undefined) return;
      if (ui.armedDrop !== data.item) {
        ui.armedDrop = data.item;
        store.mark('main');
        return;
      }
      delete ui.armedDrop;
      queueOp(data.repo, data.workflow, 'drop', { dedupKey: data.item });
    },
    'watch-set': (data) => {
      const { repo, op, workflow } = data;
      if (repo === undefined || (op !== 'watch' && op !== 'unwatch')) return;
      const id = workflow === undefined ? repo : `${repo}/${workflow}`;
      if (op === 'unwatch' && ui.armedWatch !== id) {
        ui.armedWatch = id;
        store.mark('rail');
        return;
      }
      delete ui.armedWatch;
      ui.watchNotice = { repo, text: op === 'watch' ? 'watching…' : 'unwatching…' };
      store.mark('rail');
      void host
        .post(`/api/repos/${enc(repo)}/${op}`, { workflows: workflow === undefined ? [] : [workflow] })
        .then(({ status, body }) => {
          if (store.stopped) return;
          const said =
            status === 200 || status === 202
              ? (answerField(body, 'message') ?? answerField(body, 'waiting'))
              : undefined;
          if (said !== undefined) ui.watchNotice = { repo, text: said };
          else if (status === 200 || status === 202) delete ui.watchNotice;
          else ui.watchNotice = { repo, text: refusal(status, body, op) };
          store.mark('rail');
        });
    },
    'resume-run': () => startRun('resume'),
    'restart-run': () => startRun('restart'),
    'stop-run': () => endRun('stop'),
    'clean-run': () => endRun('clean'),
    // Ticking Stop now redraws an armed Stop's confirmation, which names what it will do.
    'stop-now': () => {
      ui.stopNow = host.value('now') === 'on';
      store.mark('rail');
    },
    // A run's ⋯ opens it and its menu under its row; on the open menu's run, it shuts the menu.
    'run-menu': (data) => {
      const { repo, run: runId } = data;
      if (repo === undefined || runId === undefined) return;
      if (ui.runMenu === runId && ui.queue === undefined && store.run?.repo === repo && store.run.runId === runId) {
        delete ui.runMenu;
        delete ui.armed;
        store.mark('rail');
        return;
      }
      actions['select-run']?.(data);
      ui.runMenu = runId;
      store.mark('rail');
    },
    'toggle-queue-events': () => {
      ui.queueEvents = !ui.queueEvents;
      store.mark('main');
    },
    'toggle-queue-section': (data) => {
      const section = data.section;
      if (!section) return;
      ui.folded = ui.folded.includes(section) ? ui.folded.filter((id) => id !== section) : [...ui.folded, section];
      store.mark('main');
    },
    'toggle-attention': () => {
      ui.attention = !ui.attention;
      store.mark('attention');
    },
    'clear-attention': () => {
      store.cleared = new Set([...storedCleared(host), ...store.cleared, ...store.drawn]);
      saveCleared(host, store.cleared);
      store.mark('attention');
    },
    'toggle-section': (data) => {
      const section = data.section ?? '';
      ui.open = ui.open.includes(section) ? ui.open.filter((open) => open !== section) : [...ui.open, section];
      store.mark('rail');
    },
    'toggle-inspector': () => {
      ui.inspector = !ui.inspector;
      host.setInspector(ui.inspector);
    },
    'toggle-theme': () => {
      ui.theme = THEMES[(THEMES.indexOf(ui.theme) + 1) % THEMES.length] ?? 'dark';
      host.save(THEME_KEY, ui.theme);
      host.setTheme(ui.theme);
    },
    'toggle-follow': () => {
      ui.follow = !ui.follow;
      store.mark('main', 'inspector');
    },
    copy: (data) => {
      if (data.text !== undefined) void host.copy(data.text);
    },
  };

  const keys: Record<string, () => void> = {
    Enter: () => {
      const card = store.run?.model.cards[ui.cursor];
      if (card !== undefined) selectCard(store, card.key, undefined, true);
    },
    // Needs attention and the drawer shut first; then back to the cards from a timeline, keeping the selection; from
    // the cards, no selection.
    Escape: () => {
      if (ui.runMenu !== undefined) {
        delete ui.runMenu;
        delete ui.armed;
        store.mark('rail');
      } else if (ui.itemMenu !== undefined) {
        delete ui.itemMenu;
        delete ui.armedDrop;
        store.mark('main');
      } else if (ui.attention) closeAttention();
      else if (ui.file !== undefined) closeFile(store);
      else if (ui.timeline) actions['close-timeline']?.({});
      else selectCard(store, undefined);
    },
    ']': () => step(1),
    '[': () => step(-1),
    i: () => actions['toggle-inspector']?.({}),
    a: () => actions['toggle-attention']?.({}),
  };

  host.onAction((action, data) => {
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
      store.mark('rail');
    }
    if (shuts) delete ui.itemMenu;
    if (shutsRun) delete ui.runMenu;
    if (disarms) store.mark('main', 'rail');
    actions[action]?.(data);
  });
  host.onKey((key, inInput) => {
    if (inInput) return;
    const by = MOVES[key];
    if (by === undefined) return keys[key]?.();
    const last = (store.run?.model.cards.length ?? 0) - 1;
    ui.cursor = Math.max(0, Math.min(last, ui.cursor + by));
    store.mark('main');
  });
  openIndex(store, (asked) => actions.open?.(asked));
  store.mark(...REGIONS);

  return {
    ui,
    stop() {
      store.stopped = true;
      stopStreams(store);
      if (store.flushTimer !== undefined) host.cancel(store.flushTimer);
      stopReads(store);
      if (store.tickTimer !== undefined) host.cancel(store.tickTimer);
    },
  };
}
