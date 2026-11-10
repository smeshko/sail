// The page's shell. `boot(host)` holds what is on screen and keeps it live:
//
// - One index socket feeds the rail, needs attention, the queue view and the open run's summary. The first index opens
//   the newest running run, else the newest run, unless the URL names a run it lists, and a selection is kept while its
//   run is still listed.
// - One run socket is open at a time, for the open run, and its events are folded into the run model. A socket that
//   closes without `end` reconnects after 2 s and starts the model again, since the replay sends everything, unless its
//   stream sent `error`: then the error and the cards stay, with no reconnect, until the run is clicked again.
// - One queue socket per watched workflow in the index feeds its recent events and its watch state, and reconnects by
//   the same rule: a queue whose stream sent `error` shows it until its row is clicked again. A workflow's queue row in
//   the rail opens its queue in the centre, in place of the run, until a run is opened again. A queue that leaves the
//   index gives the centre back to the run.
// - Needs attention is a button in the top bar with its count. It opens a pane over the page, and `a` toggles it; Esc,
//   a click outside it, and opening one of its items close it. Its All clear button hides the items listed at the click,
//   remembered by their identities in the browser; an index that no longer lists an identity forgets it.
// - Opening a stage card shows its timeline in the centre, drawn from the same run model, so it grows with the run
//   socket's events. While the call runs and the timeline is followed, each draw scrolls it to its newest entry. The
//   kinds of entry it hides hold for every call's timeline, and are saved like the theme. An opened script command shows
//   the call's stdout and stderr, read over REST, and read again at most once a second while the call runs.
// - A file name in the inspector's files tab opens the file in the drawer, read over REST: a markdown file as the HTML
//   the server built from it. Esc or the close button shuts the drawer, and so does opening another run.
// - The inspector reads a call's `result.json` and log over REST. A response for a selection that has changed since is
//   dropped, and a running call's log is read again at most once a second.
// - While anything runs, the regions with a running time are drawn again each second, so the time counts up between
//   events.
// - Clicks arrive as delegated `data-action`s, and keys as keys. Renders are coalesced: a region marked dirty is drawn
//   by one flush at most every 100 ms, and one whose markup is unchanged is not written, nor its timeline scrolled.
//
// It controls four things. In the rail, `watch-set` asks the dashboard's server to watch or unwatch one workflow of a
// repository or all of them (an unwatch on a second click), and the answer, in `sail`'s own words, shows under the
// repository's header. In the queue view, `move-item`, `poll-queue`, `add-ticket`, `requeue-item` and `drop-item` ask
// the dashboard's server to have the watcher move, poll, add, requeue or drop (a drop on a second click, from the menu
// `item-menu` opens), and the answer,
// a refusal or that the watcher has not taken the command yet, is shown beside the queue's header. `resume-run` and
// `restart-run` ask it to start a suspended run again or a failed
// run as a seeded one, each on a second click: what the open run offers is read from its actions route when it opens
// and when the index changes its status or its queue item, and the rail draws it in the menu a run's ⋯ (`run-menu`)
// opens under its row, opening the run. A refusal is shown beside the buttons; a
// started restart opens the new run, and a started resume reads the run again. `stop-run` and `clean-run` ask it to stop
// a running or suspended run (with Stop now ticked, at once) or to clean a failed one, each on a second click: a stop
// shows its answer beside the buttons and reads the run again, and a clean leaves the run and shows its answer in the
// rail until a run is selected. The other actions change what is shown, and `copy` puts a CLI command on the clipboard.
import type { QueueEvent, SailEvent } from '../../events/types';
import type { RunActions } from '../actions';
import type { IndexRepo } from '../files';
import type { Message } from '../streams';
import { attention, identity } from './attention';
import { startDraw, tick } from './draw';
import { isMarkdown } from './drawer-view';
import type { PageHost } from './host';
import { REGIONS } from './host';
import { newestFirst, railRepos, statusOf } from './index-model';
import { logTarget } from './inspector-view';
import { queueId } from './queue-view';
import { applyEvent, emptyRun } from './run-model';
import { FILTER_KEY, RAIL_KEY, saveCleared, storedCleared, THEME_KEY } from './saved';
import { createStore, type OpenQueue, type OpenRun, openQueue } from './store';
import { outputKey, scriptId } from './timeline-view';
import { FILTERS, type InspectorTab, TABS, THEMES, type TimelineFilter, type UiState } from './ui-state';

export { TICK_MS } from './draw';
export { CLEARED_KEY, FILTER_KEY, RAIL_KEY, THEME_KEY } from './saved';
export { FLUSH_MS } from './store';
export const RECONNECT_MS = 2000;
export const LOG_REFRESH_MS = 1000;

/** How many of a queue's events its panel lists. */
export const RECENT_EVENTS = 20;

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

function parse(text: string): Message | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'object' && value !== null ? (value as Message) : undefined;
  } catch {
    return undefined;
  }
}

export function boot(host: PageHost): Page {
  const store = createStore(host);
  const ui = store.ui;
  const { mark } = store;

  startDraw(store);

  const callPath = (open: OpenRun, key: string) =>
    `/api/repos/${enc(open.repo)}/runs/${enc(open.runId)}/calls/${enc(key)}`;

  const readResult = () => {
    const open = store.run;
    const key = ui.key;
    if (open === undefined || key === undefined) return;
    const asked = ++store.resultRead;
    const forSelection = store.selection;
    store.result = { state: 'loading' };
    void host.get(`${callPath(open, key)}/result`).then((answer) => {
      if (asked !== store.resultRead || forSelection !== store.selection) return;
      if (answer.status === 200) {
        try {
          store.result = { state: 'loaded', value: JSON.parse(answer.body) as unknown };
        } catch {
          store.result = { state: 'missing', message: 'result.json is not JSON' };
        }
      } else store.result = { state: 'missing' };
      mark('inspector');
    });
  };

  const readLog = () => {
    const open = store.run;
    const key = ui.key;
    const card = open?.model.cards.find((entry) => entry.key === key);
    if (open === undefined || key === undefined || card === undefined) return;
    const target = logTarget(card, ui);
    const stream = ui.stream !== undefined && target.streams.includes(ui.stream) ? ui.stream : target.streams[0];
    if (stream === undefined) return;
    const asked = ++store.logRead;
    const forSelection = store.selection;
    store.lastLogRead = host.now();
    if (target.key !== store.logFor) store.log = undefined;
    store.logFor = target.key;
    if (store.log === undefined) store.log = { state: 'loading' };
    void host.get(`${callPath(open, target.key)}/log?stream=${enc(stream)}`).then((answer) => {
      if (asked !== store.logRead || forSelection !== store.selection) return;
      store.log = answer.status === 200 ? { state: 'loaded', value: answer.body } : { state: 'missing' };
      mark('inspector');
    });
  };

  /** Reads a running call's log again, at most once a second, and at once when the log tab has moved to its next step. */
  const refreshLog = () => {
    const card = store.run?.model.cards.find((entry) => entry.key === ui.key);
    if (card !== undefined && logTarget(card, ui).key !== store.logFor) {
      if (store.logTimer !== undefined) host.cancel(store.logTimer);
      store.logTimer = undefined;
      return readLog();
    }
    if (store.logTimer !== undefined) return;
    const wait = Math.max(0, store.lastLogRead + LOG_REFRESH_MS - host.now());
    if (wait === 0) return readLog();
    store.logTimer = host.later(() => {
      store.logTimer = undefined;
      readLog();
    }, wait);
  };

  /** The read keys of the selected call's opened script rows. */
  const openedOutputKeys = (): string[] => {
    const card = store.run?.model.cards.find((entry) => entry.key === ui.key);
    if (card === undefined) return [];
    return card.timeline
      .filter((entry) => entry.kind === 'script')
      .filter((_, index) => ui.opened.includes(scriptId(index)))
      .map((entry) => outputKey(card, entry));
  };

  /** Reads stdout and stderr for opened script rows and keys already read. */
  const readOutput = () => {
    const open = store.run;
    const key = ui.key;
    if (open === undefined || key === undefined) return;
    const asked = ++store.outputRead;
    const forSelection = store.selection;
    store.lastOutputRead = host.now();
    store.outputs ??= {};
    const keys = new Set([...Object.keys(store.outputs), ...openedOutputKeys()]);
    for (const key of keys) {
      store.outputs[key] ??= { stdout: { state: 'loading' }, stderr: { state: 'loading' } };
      const output = store.outputs[key];
      for (const stream of ['stdout', 'stderr'] as const) {
        void host.get(`${callPath(open, key)}/log?stream=${stream}`).then((answer) => {
          if (asked !== store.outputRead || forSelection !== store.selection || store.outputs === undefined) return;
          output[stream] = answer.status === 200 ? { state: 'loaded', value: answer.body } : { state: 'missing' };
          mark('main');
        });
      }
    }
  };

  /** Reads a running call's output again, at most once a second. */
  const refreshOutput = () => {
    if (store.outputTimer !== undefined) return;
    const wait = Math.max(0, store.lastOutputRead + LOG_REFRESH_MS - host.now());
    if (wait === 0) return readOutput();
    store.outputTimer = host.later(() => {
      store.outputTimer = undefined;
      readOutput();
    }, wait);
  };

  const clearCall = () => {
    store.selection++;
    store.result = undefined;
    store.log = undefined;
    store.outputs = undefined;
    if (store.logTimer !== undefined) host.cancel(store.logTimer);
    store.logTimer = undefined;
    if (store.outputTimer !== undefined) host.cancel(store.outputTimer);
    store.outputTimer = undefined;
  };

  /** Selects the call `key`, or none. `timeline` opens its timeline, or goes back to the cards; left out, keeps either. */
  const selectCard = (key: string | undefined, tab?: InspectorTab, timeline?: boolean) => {
    clearCall();
    if (key === undefined) delete ui.key;
    else ui.key = key;
    delete ui.stream;
    delete ui.step;
    ui.opened = [];
    if (tab !== undefined) ui.tab = tab;
    if (timeline !== undefined) ui.timeline = timeline;
    if (key === undefined) ui.timeline = false;
    const place = store.run?.model.cards.findIndex((entry) => entry.key === key) ?? -1;
    if (place >= 0) ui.cursor = place;
    store.cursorPending = key !== undefined && place < 0;
    if (key !== undefined) {
      readResult();
      if (ui.tab === 'log') readLog();
    }
    mark('main', 'inspector');
  };

  const onRunMessage = (open: OpenRun, text: string) => {
    if (open !== store.run) return;
    const message = parse(text);
    if (message?.kind === 'event') {
      const event = message.event as SailEvent & { key?: unknown };
      applyEvent(open.model, event);
      mark('main', 'status');
      tick(store);
      const place = store.cursorPending ? open.model.cards.findIndex((entry) => entry.key === ui.key) : -1;
      if (place >= 0) {
        ui.cursor = place;
        store.cursorPending = false;
      }
      const key = typeof event.key === 'string' ? event.key.split('/')[0] : undefined;
      if (key !== undefined && key === ui.key) {
        mark('inspector');
        const card = open.model.cards.find((entry) => entry.key === key);
        // The call's end: its result.json is written now, and its log has its last lines (review R1-3). Each try ends,
        // and a corrective try writes its own result.json, so even a loaded one is read again (review R2-2).
        const ended = (event.type === 'stage:end' || event.type === 'intake:end') && event.key === key;
        if (ended) readResult();
        if (ui.tab === 'log' && (card?.state === 'running' || ended)) refreshLog();
        if (ui.timeline && store.outputs !== undefined && (card?.state === 'running' || ended)) refreshOutput();
      }
    } else if (message?.kind === 'end') {
      open.ended = true;
      open.endSeen = host.now();
      mark('main', 'status');
      // An index saying the run runs again may have come before this end: look again once the index has caught up
      // (review R2-3).
      open.retry = host.later(() => {
        delete open.retry;
        followAgain(open);
      }, RECONNECT_MS);
    } else if (message?.kind === 'error') {
      open.error = message.message;
      mark('main');
    }
  };

  /** A close handler that, unless the stream failed or is no longer live, runs `again` after the reconnect delay. */
  const retryOnClose =
    (holder: { retry?: number }, failed: () => boolean, live: () => boolean, again: () => void) => () => {
      if (store.stopped || failed() || !live()) return;
      holder.retry = host.later(() => {
        delete holder.retry;
        if (live()) again();
      }, RECONNECT_MS);
    };

  const openRunSocket = (open: OpenRun) => {
    const connection = host.connect(`run=${enc(`${open.repo}/${open.runId}`)}`, {
      message: (text) => onRunMessage(open, text),
      // A socket the run has since replaced, or that ended, closes without a retry, and so does one whose stream sent
      // `error`: the error stays until the run is clicked again.
      close: retryOnClose(
        open,
        () => open.error !== undefined,
        () => !(open !== store.run || open.ended || open.connection !== connection),
        () => {
          open.model = emptyRun();
          delete open.error;
          openRunSocket(open);
          mark('main', 'status', 'inspector');
        },
      ),
    });
    open.connection = connection;
  };

  /**
   * Whether the index lists the ended run otherwise than its stream ended it: running again, as `sail resume` makes it,
   * or ended with another status or at another time, by a resume that ran between two polls (review R3-1).
   */
  const movedOn = (open: OpenRun) => {
    const item = store.index?.find((repo) => repo.name === open.repo)?.runs.find((entry) => entry.runId === open.runId);
    if (item === undefined) return false;
    const { end, endedAt } = open.model;
    if (statusOf(item) !== (end?.status ?? 'running')) return true;
    const listed = item.summary?.endedAt;
    return listed !== undefined && endedAt !== undefined && listed !== endedAt;
  };

  /**
   * Follows the open run's stream again, from an empty model, when its stream ended and the index has since moved on
   * (review R1-2). Either order of the end and the index lands here. For the reconnect delay after the end, an index
   * may still be one read before it, so only the check the end set up then decides (review R3-3).
   */
  function followAgain(open: OpenRun, fromIndex = false) {
    if (open !== store.run || !open.ended || !movedOn(open)) return;
    if (fromIndex && host.now() - (open.endSeen ?? 0) < RECONNECT_MS) return;
    if (open.retry !== undefined) host.cancel(open.retry);
    delete open.retry;
    open.ended = false;
    open.model = emptyRun();
    delete open.error;
    openRunSocket(open);
    mark('main', 'status', 'inspector');
  }

  const closeRun = () => {
    if (store.run === undefined) return;
    const closing = store.run;
    store.run = undefined;
    if (closing.retry !== undefined) host.cancel(closing.retry);
    closing.connection?.close();
  };

  const closeFile = () => {
    if (ui.file === undefined) return;
    delete ui.file;
    store.doc = undefined;
    store.docRead++;
    mark('drawer');
  };

  const openFile = (name: string, path: string) => {
    const open = store.run;
    if (open === undefined) return;
    ui.file = { name, path };
    store.doc = { state: 'loading' };
    const asked = ++store.docRead;
    const as = isMarkdown(path) ? '&as=html' : '';
    void host.get(`/api/repos/${enc(open.repo)}/runs/${enc(open.runId)}/file?path=${enc(path)}${as}`).then((answer) => {
      if (asked !== store.docRead) return;
      store.doc = answer.status === 200 ? { state: 'loaded', value: answer.body } : { state: 'missing' };
      mark('drawer');
    });
    mark('drawer');
  };

  /** The open run's status and its queue items' states: what its actions depend on that the index shows. */
  const offerSignature = (open: OpenRun) => {
    const repo = store.index?.find((each) => each.name === open.repo);
    const item = repo?.runs.find((each) => each.runId === open.runId);
    const queued = (repo?.queues ?? []).flatMap((view) =>
      (view.queue?.items ?? [])
        .filter((each) => each.runId === open.runId)
        .map((each) => `${view.workflow}:${each.state}:${each.retryAt ?? ''}`),
    );
    return `${item === undefined ? '' : statusOf(item)}|${queued.join(',')}`;
  };

  const readOffers = () => {
    const open = store.run;
    if (open === undefined) return;
    const asked = ++store.offersRead;
    store.offersFor = offerSignature(open);
    void host.get(`/api/repos/${enc(open.repo)}/runs/${enc(open.runId)}/actions`).then((answer) => {
      if (asked !== store.offersRead || store.stopped) return;
      store.offers = undefined;
      if (answer.status === 200) {
        try {
          store.offers = JSON.parse(answer.body) as RunActions;
        } catch {
          // An answer that isn't JSON offers nothing.
        }
      }
      mark('rail');
    });
  };

  const selectRun = (repo: string, runId: string) => {
    if (store.run?.repo === repo && store.run.runId === runId && store.run.error === undefined) return;
    closeRun();
    clearCall();
    ui.repo = repo;
    ui.runId = runId;
    closeFile();
    delete ui.key;
    ui.timeline = false;
    ui.opened = [];
    ui.cursor = 0;
    store.run = { repo, runId, model: emptyRun(), ended: false };
    store.offers = undefined;
    delete ui.runMenu;
    delete ui.armed;
    delete ui.runNotice;
    delete ui.raise;
    delete ui.restartStage;
    delete ui.stopNow;
    store.fieldsOwn = false;
    store.fresh.add('rail');
    openRunSocket(store.run);
    readOffers();
    mark('rail', 'main', 'inspector', 'status');
  };

  const onQueueMessage = (id: string, open: OpenQueue, text: string) => {
    const message = parse(text);
    if (message?.kind === 'error') {
      open.stream = { ...open.stream, error: message.message };
      if (ui.queue === id) mark('main');
      return;
    }
    if (message?.kind !== 'queue-event') return;
    const event = message.event as QueueEvent;
    const recent = [...open.stream.recent, event].slice(-RECENT_EVENTS);
    const watch =
      event.type === 'watch:added' ? 'watched' : event.type === 'watch:removed' ? 'not watched' : open.stream.watch;
    const polls =
      event.type === 'queue:polled' ? (event as Extract<QueueEvent, { type: 'queue:polled' }>).kind : open.stream.polls;
    open.stream = { recent, watch, ...(polls === undefined ? {} : { polls }) };
    if (ui.queue === id) mark('main');
  };

  const connectQueue = (id: string, open: OpenQueue) => {
    const connection = host.connect(`queue=${enc(id)}`, {
      message: (text) => onQueueMessage(id, open, text),
      // A socket the queue has since replaced closes without a retry, like the run's.
      close: retryOnClose(
        open,
        () => open.stream.error !== undefined,
        () => store.queues.get(id) === open && open.connection === connection,
        () => {
          open.stream = { recent: [], watch: 'unknown' };
          connectQueue(id, open);
          if (ui.queue === id) mark('main');
        },
      ),
    });
    open.connection = connection;
  };

  const openQueueSocket = (id: string) => {
    const open: OpenQueue = { stream: { recent: [], watch: 'unknown' } };
    store.queues.set(id, open);
    connectQueue(id, open);
  };

  /** Opens a queue socket for every queue in the index, and closes those no longer in it. */
  const syncQueues = (repos: readonly IndexRepo[]) => {
    const wanted = new Set(repos.flatMap((repo) => repo.queues.map((view) => queueId(repo.name, view.workflow))));
    for (const [id, open] of store.queues) {
      if (wanted.has(id)) continue;
      store.queues.delete(id);
      if (open.retry !== undefined) host.cancel(open.retry);
      open.connection?.close();
    }
    for (const id of wanted) if (!store.queues.has(id)) openQueueSocket(id);
  };

  /** The run to open on the first index: the newest running one, else the newest. */
  const firstRun = (repos: readonly IndexRepo[]) => {
    const all = newestFirst(
      railRepos(repos, host.now()).flatMap((repo) => repo.runs.map((entry) => ({ ...entry, repo: repo.name }))),
    );
    return all.find((entry) => entry.status === 'running') ?? all[0];
  };

  const onIndex = (text: string) => {
    const message = parse(text);
    if (message?.kind !== 'index') return;
    const repos = message.repos;
    store.index = repos;
    const still = new Set(attention(repos).map(identity));
    if ([...store.cleared].some((id) => !still.has(id))) {
      store.cleared = new Set([...storedCleared(host), ...store.cleared].filter((id) => still.has(id)));
      saveCleared(host, store.cleared);
    }
    syncQueues(repos);
    const lists = (name?: string, runId?: string) =>
      repos.some((repo) => repo.name === name && repo.runs.some((entry) => entry.runId === runId));
    const asked = store.start;
    store.start = undefined;
    if (asked !== undefined && lists(asked.repo, asked.run)) actions.open?.(asked);
    else if (!lists(ui.repo, ui.runId)) {
      const first = firstRun(repos);
      if (first !== undefined) selectRun(first.repo, first.runId);
    }
    if (store.run !== undefined) followAgain(store.run, true);
    if (store.run !== undefined && offerSignature(store.run) !== store.offersFor) {
      delete ui.armed;
      readOffers();
    }
    if (ui.queue !== undefined && openQueue(store) === undefined) delete ui.queue;
    mark('rail', 'attention', 'main', 'status');
    tick(store);
  };

  const openIndex = () => {
    store.indexConnection = host.connect('index=1', {
      message: onIndex,
      close: () => {
        if (store.stopped) return;
        store.indexRetry = host.later(() => {
          store.indexRetry = undefined;
          openIndex();
        }, RECONNECT_MS);
      },
    });
  };

  const step = (by: number) => {
    const cards = store.run?.model.cards ?? [];
    const at = cards.findIndex((entry) => entry.key === ui.key);
    const next = cards[at < 0 ? 0 : at + by];
    if (next !== undefined) selectCard(next.key);
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
      mark('main');
    });
  };

  const leaveQueue = () => {
    if (ui.queue === undefined) return;
    delete ui.queue;
    mark('rail', 'main');
  };

  const closeAttention = () => {
    if (!ui.attention) return;
    ui.attention = false;
    mark('attention');
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
        mark('rail');
        return;
      }
      body = { raise: { [raising]: amount } };
    }
    if (ui.armed !== kind || store.armedStage !== stage) {
      ui.armed = kind;
      store.armedStage = stage;
      delete ui.runNotice;
      mark('rail');
      return;
    }
    delete ui.armed;
    store.starting = true;
    ui.runNotice = `${kind === 'resume' ? 'resuming' : 'restarting'} ${open.runId}…`;
    mark('rail');
    void host
      .post(`/api/repos/${enc(open.repo)}/runs/${enc(open.runId)}/${kind}`, body)
      .then(({ status, body: answer }) => {
        store.starting = false;
        if (store.stopped) return;
        if (status < 200 || status >= 300) {
          ui.runNotice = refusal(status, answer, kind);
          mark('rail');
          return;
        }
        delete ui.runNotice;
        if (store.run !== open) return;
        if (kind === 'resume') {
          closeRun();
          selectRun(open.repo, open.runId);
          return;
        }
        try {
          const { runId } = JSON.parse(answer) as { runId?: unknown };
          if (typeof runId === 'string') selectRun(open.repo, runId);
        } catch {
          // An answer with no run id leaves the run open.
        }
        mark('rail');
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
      mark('rail');
      return;
    }
    delete ui.armed;
    store.starting = true;
    ui.runNotice = `${kind === 'stop' ? 'stopping' : 'cleaning'} ${open.runId}…`;
    mark('rail');
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
          mark('rail');
          return;
        }
        delete ui.runNotice;
        if (store.run !== open) return;
        const message = answerField(answer, 'message');
        if (kind === 'clean') {
          closeRun();
          if (message === undefined) delete ui.indexNotice;
          else ui.indexNotice = message;
          mark('rail', 'main', 'inspector', 'status');
          return;
        }
        const menu = ui.runMenu;
        closeRun();
        selectRun(open.repo, open.runId);
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
      selectRun(data.repo, data.run);
    },
    'select-queue': (data) => {
      if (data.queue === undefined) return;
      const failed = store.queues.get(data.queue);
      if (failed?.stream.error !== undefined) {
        failed.stream = { recent: [], watch: 'unknown' };
        connectQueue(data.queue, failed);
      }
      ui.queue = data.queue;
      delete ui.queueNotice;
      mark('rail', 'main');
    },
    'select-card': (data) => selectCard(data.key, undefined, true),
    open: (data) => {
      if (data.repo === undefined || data.run === undefined) return;
      closeAttention();
      leaveQueue();
      selectRun(data.repo, data.run);
      const tab = (TABS as readonly string[]).includes(data.tab ?? '') ? (data.tab as InspectorTab) : 'overview';
      if (data.key !== undefined) selectCard(data.key, tab, false);
    },
    'close-timeline': () => {
      ui.timeline = false;
      mark('main');
    },
    'open-file': (data) => {
      if (data.name !== undefined && data.path !== undefined) openFile(data.name, data.path);
    },
    'close-file': () => closeFile(),
    'step-card': (data) => step(Number(data.by) < 0 ? -1 : 1),
    'toggle-tool': (data) => {
      const call = data.call;
      if (call === undefined) return;
      ui.opened = ui.opened.includes(call) ? ui.opened.filter((each) => each !== call) : [...ui.opened, call];
      if (openedOutputKeys().some((key) => store.outputs?.[key] === undefined)) readOutput();
      mark('main');
    },
    'toggle-filter': (data) => {
      if (!(FILTERS as readonly string[]).includes(data.filter ?? '')) return;
      const kind = data.filter as TimelineFilter;
      const hidden = ui.hidden.includes(kind) ? ui.hidden.filter((each) => each !== kind) : [...ui.hidden, kind];
      ui.hidden = FILTERS.filter((each) => hidden.includes(each));
      host.save(FILTER_KEY, ui.hidden.join(','));
      mark('main');
    },
    'show-all': () => {
      ui.hidden = [];
      host.save(FILTER_KEY, '');
      mark('main');
    },
    tab: (data) => {
      if (!(TABS as readonly string[]).includes(data.tab ?? '')) return;
      ui.tab = data.tab as InspectorTab;
      if (ui.tab === 'log') readLog();
      mark('inspector');
    },
    stream: (data) => {
      if (data.stream === undefined) return;
      ui.stream = data.stream;
      store.log = undefined;
      readLog();
      mark('inspector');
    },
    'log-step': (data) => {
      if (data.step === undefined) return;
      ui.step = data.step;
      delete ui.stream;
      store.log = undefined;
      readLog();
      mark('inspector');
    },
    'toggle-group': (data) => {
      const group = data.group ?? '';
      ui.expanded = ui.expanded.includes(group)
        ? ui.expanded.filter((each) => each !== group)
        : [...ui.expanded, group];
      host.save(RAIL_KEY, JSON.stringify(ui.expanded));
      mark('rail');
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
      mark('main');
    },
    'requeue-item': (data) => {
      if (data.repo === undefined || data.workflow === undefined || data.item === undefined) return;
      queueOp(data.repo, data.workflow, 'requeue', { dedupKey: data.item });
    },
    'drop-item': (data) => {
      if (data.repo === undefined || data.workflow === undefined || data.item === undefined) return;
      if (ui.armedDrop !== data.item) {
        ui.armedDrop = data.item;
        mark('main');
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
        mark('rail');
        return;
      }
      delete ui.armedWatch;
      ui.watchNotice = { repo, text: op === 'watch' ? 'watching…' : 'unwatching…' };
      mark('rail');
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
          mark('rail');
        });
    },
    'resume-run': () => startRun('resume'),
    'restart-run': () => startRun('restart'),
    'stop-run': () => endRun('stop'),
    'clean-run': () => endRun('clean'),
    // Ticking Stop now redraws an armed Stop's confirmation, which names what it will do.
    'stop-now': () => {
      ui.stopNow = host.value('now') === 'on';
      mark('rail');
    },
    // A run's ⋯ opens it and its menu under its row; on the open menu's run, it shuts the menu.
    'run-menu': (data) => {
      const { repo, run: runId } = data;
      if (repo === undefined || runId === undefined) return;
      if (ui.runMenu === runId && ui.queue === undefined && store.run?.repo === repo && store.run.runId === runId) {
        delete ui.runMenu;
        delete ui.armed;
        mark('rail');
        return;
      }
      actions['select-run']?.(data);
      ui.runMenu = runId;
      mark('rail');
    },
    'toggle-queue-events': () => {
      ui.queueEvents = !ui.queueEvents;
      mark('main');
    },
    'toggle-queue-section': (data) => {
      const section = data.section;
      if (!section) return;
      ui.folded = ui.folded.includes(section) ? ui.folded.filter((id) => id !== section) : [...ui.folded, section];
      mark('main');
    },
    'toggle-attention': () => {
      ui.attention = !ui.attention;
      mark('attention');
    },
    'clear-attention': () => {
      store.cleared = new Set([...storedCleared(host), ...store.cleared, ...store.drawn]);
      saveCleared(host, store.cleared);
      mark('attention');
    },
    'toggle-section': (data) => {
      const section = data.section ?? '';
      ui.open = ui.open.includes(section) ? ui.open.filter((open) => open !== section) : [...ui.open, section];
      mark('rail');
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
      mark('main', 'inspector');
    },
    copy: (data) => {
      if (data.text !== undefined) void host.copy(data.text);
    },
  };

  const keys: Record<string, () => void> = {
    Enter: () => {
      const card = store.run?.model.cards[ui.cursor];
      if (card !== undefined) selectCard(card.key, undefined, true);
    },
    // Needs attention and the drawer shut first; then back to the cards from a timeline, keeping the selection; from
    // the cards, no selection.
    Escape: () => {
      if (ui.runMenu !== undefined) {
        delete ui.runMenu;
        delete ui.armed;
        mark('rail');
      } else if (ui.itemMenu !== undefined) {
        delete ui.itemMenu;
        delete ui.armedDrop;
        mark('main');
      } else if (ui.attention) closeAttention();
      else if (ui.file !== undefined) closeFile();
      else if (ui.timeline) actions['close-timeline']?.({});
      else selectCard(undefined);
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
      mark('rail');
    }
    if (shuts) delete ui.itemMenu;
    if (shutsRun) delete ui.runMenu;
    if (disarms) mark('main', 'rail');
    actions[action]?.(data);
  });
  host.onKey((key, inInput) => {
    if (inInput) return;
    const by = MOVES[key];
    if (by === undefined) return keys[key]?.();
    const last = (store.run?.model.cards.length ?? 0) - 1;
    ui.cursor = Math.max(0, Math.min(last, ui.cursor + by));
    mark('main');
  });
  openIndex();
  mark(...REGIONS);

  return {
    ui,
    stop() {
      store.stopped = true;
      store.indexConnection?.close();
      if (store.indexRetry !== undefined) host.cancel(store.indexRetry);
      closeRun();
      for (const open of store.queues.values()) {
        if (open.retry !== undefined) host.cancel(open.retry);
        open.connection?.close();
      }
      store.queues.clear();
      if (store.flushTimer !== undefined) host.cancel(store.flushTimer);
      if (store.logTimer !== undefined) host.cancel(store.logTimer);
      if (store.outputTimer !== undefined) host.cancel(store.outputTimer);
      if (store.tickTimer !== undefined) host.cancel(store.tickTimer);
    },
  };
}
