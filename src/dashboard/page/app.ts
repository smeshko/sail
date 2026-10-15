// The page's shell. `boot(host)` holds what is on screen and keeps it live:
//
// - One index socket feeds the rail, needs attention, the queues and the open run's summary. The first index opens the
//   newest running run, else the newest run, and a selection is kept while its run is still listed.
// - One run socket is open at a time, for the open run, and its events are folded into the run model. A socket that
//   closes without `end` reconnects after 2 s and starts the model again, since the replay sends everything.
// - One queue socket per watched workflow in the index feeds its recent events and its watch state.
// - The inspector reads a call's `result.json` and log over REST. A response for a selection that has changed since is
//   dropped, and a running call's log is read again at most once a second.
// - Clicks arrive as delegated `data-action`s, and keys as keys. Renders are coalesced: a region marked dirty is drawn
//   by one flush at most every 100 ms.
//
// It controls nothing: the only actions change what is shown, and `copy` puts a CLI command on the clipboard.
import type { QueueEvent, SailEvent } from '../../events/types';
import type { IndexRepo } from '../files';
import type { Message } from '../streams';
import { attention } from './attention';
import { renderAttention } from './attention-view';
import type { PageHost, Region } from './host';
import { REGIONS } from './host';
import { html } from './html';
import { newestFirst, queuePanels, railRepos, statusOf } from './index-model';
import { type Loaded, renderInspector, streamsOf } from './inspector-view';
import { type QueueStream, queueId, renderQueues } from './queue-view';
import { renderRail } from './rail-view';
import { applyEvent, emptyRun, type RunModel } from './run-model';
import { renderRun, renderStatus } from './run-view';
import { type InspectorTab, initialUi, TABS, THEMES, type Theme, type UiState } from './ui-state';

export const THEME_KEY = 'sail-dashboard-theme';
export const RECONNECT_MS = 2000;
export const FLUSH_MS = 100;
export const LOG_REFRESH_MS = 1000;
/** How many of a queue's events its panel lists. */
export const RECENT_EVENTS = 20;

interface OpenRun {
  repo: string;
  runId: string;
  model: RunModel;
  ended: boolean;
  error?: string;
  connection?: { close(): void };
  retry?: number;
}

interface OpenQueue {
  connection?: { close(): void };
  stream: QueueStream;
  retry?: number;
}

export interface Page {
  stop(): void;
  /** What the page holds, for tests. */
  readonly ui: UiState;
}

const enc = encodeURIComponent;

/** The keys that move the card cursor, and by how much. */
const MOVES: Record<string, number> = { j: 1, ArrowDown: 1, ArrowRight: 1, k: -1, ArrowUp: -1, ArrowLeft: -1 };

function parse(text: string): Message | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'object' && value !== null ? (value as Message) : undefined;
  } catch {
    return undefined;
  }
}

export function boot(host: PageHost): Page {
  const ui = initialUi(host.offset());
  const saved = host.load(THEME_KEY);
  if ((THEMES as readonly string[]).includes(saved ?? '')) ui.theme = saved as Theme;
  host.setTheme(ui.theme);
  host.setInspector(ui.inspector);

  let index: IndexRepo[] | undefined;
  let run: OpenRun | undefined;
  let result: Loaded<unknown> | undefined;
  let log: Loaded<string> | undefined;
  /** Bumped on every change of the selected call: a read made for an older one is dropped. */
  let selection = 0;
  /** Bumped on every result and log read asked for: only the latest of each is shown. */
  let resultRead = 0;
  let logRead = 0;
  let lastLogRead = Number.NEGATIVE_INFINITY;
  /** Set when a call is selected before its card exists: the cursor moves to it once it does. */
  let cursorPending = false;
  let logTimer: number | undefined;
  const queues = new Map<string, OpenQueue>();
  let indexConnection: { close(): void } | undefined;
  let indexRetry: number | undefined;
  let stopped = false;

  const dirty = new Set<Region>();
  let flushTimer: number | undefined;

  const summaryOf = (open: OpenRun | undefined) =>
    index?.find((repo) => repo.name === open?.repo)?.runs.find((item) => item.runId === open?.runId)?.summary;

  const draw: Record<Region, () => string> = {
    rail: () =>
      index === undefined
        ? html`<div class="qempty">connecting…</div>`.value
        : renderRail(railRepos(index, host.now()), ui).value,
    attention: () => (index === undefined ? '' : renderAttention(attention(index)).value),
    queues: () => {
      const streams = Object.fromEntries([...queues].map(([id, open]) => [id, open.stream]));
      return index === undefined ? '' : renderQueues(queuePanels(index), streams, ui, host.now()).value;
    },
    main: () => {
      if (run === undefined) return html`<div class="qempty">no run selected</div>`.value;
      const error = run.error === undefined ? '' : html`<div class="code bad">${run.error}</div>`;
      return html`${error}${renderRun(run.model, summaryOf(run), ui, host.now())}`.value;
    },
    inspector: () => {
      const card = run?.model.cards.find((entry) => entry.key === ui.key);
      return renderInspector(card, run?.model.roster, result, log, ui).value;
    },
    status: () => (run === undefined ? '' : renderStatus(run.model, summaryOf(run)).value),
  };

  const flush = () => {
    flushTimer = undefined;
    const regions = REGIONS.filter((region) => dirty.has(region));
    dirty.clear();
    for (const region of regions) {
      // A region that can't be drawn says so, and the others are still drawn (review R2-1).
      let markup: string;
      try {
        markup = draw[region]();
      } catch {
        markup = html`<div class="code bad">this part of the page could not be drawn</div>`.value;
      }
      host.render(region, markup);
    }
  };

  const mark = (...regions: Region[]) => {
    for (const region of regions) dirty.add(region);
    if (flushTimer === undefined && !stopped) flushTimer = host.later(flush, FLUSH_MS);
  };

  const callPath = (open: OpenRun, key: string) =>
    `/api/repos/${enc(open.repo)}/runs/${enc(open.runId)}/calls/${enc(key)}`;

  const readResult = () => {
    const open = run;
    const key = ui.key;
    if (open === undefined || key === undefined) return;
    const asked = ++resultRead;
    const forSelection = selection;
    result = { state: 'loading' };
    void host.get(`${callPath(open, key)}/result`).then((answer) => {
      if (asked !== resultRead || forSelection !== selection) return;
      if (answer.status === 200) {
        try {
          result = { state: 'loaded', value: JSON.parse(answer.body) as unknown };
        } catch {
          result = { state: 'missing', message: 'result.json is not JSON' };
        }
      } else result = { state: 'missing' };
      mark('inspector');
    });
  };

  const readLog = () => {
    const open = run;
    const key = ui.key;
    const card = open?.model.cards.find((entry) => entry.key === key);
    if (open === undefined || key === undefined || card === undefined) return;
    const streams = streamsOf(card.kind);
    const stream = ui.stream !== undefined && streams.includes(ui.stream) ? ui.stream : streams[0];
    if (stream === undefined) return;
    const asked = ++logRead;
    const forSelection = selection;
    lastLogRead = host.now();
    if (log === undefined) log = { state: 'loading' };
    void host.get(`${callPath(open, key)}/log?stream=${enc(stream)}`).then((answer) => {
      if (asked !== logRead || forSelection !== selection) return;
      log = answer.status === 200 ? { state: 'loaded', value: answer.body } : { state: 'missing' };
      mark('inspector');
    });
  };

  /** Reads a running call's log again, at most once a second. */
  const refreshLog = () => {
    if (logTimer !== undefined) return;
    const wait = Math.max(0, lastLogRead + LOG_REFRESH_MS - host.now());
    if (wait === 0) return readLog();
    logTimer = host.later(() => {
      logTimer = undefined;
      readLog();
    }, wait);
  };

  const clearCall = () => {
    selection++;
    result = undefined;
    log = undefined;
    if (logTimer !== undefined) host.cancel(logTimer);
    logTimer = undefined;
  };

  const selectCard = (key: string | undefined, tab?: InspectorTab) => {
    clearCall();
    if (key === undefined) delete ui.key;
    else ui.key = key;
    delete ui.stream;
    if (tab !== undefined) ui.tab = tab;
    const place = run?.model.cards.findIndex((entry) => entry.key === key) ?? -1;
    if (place >= 0) ui.cursor = place;
    cursorPending = key !== undefined && place < 0;
    if (key !== undefined) {
      readResult();
      if (ui.tab === 'log') readLog();
    }
    mark('main', 'inspector');
  };

  const onRunMessage = (open: OpenRun, text: string) => {
    if (open !== run) return;
    const message = parse(text);
    if (message?.kind === 'event') {
      const event = message.event as SailEvent & { key?: unknown };
      applyEvent(open.model, event);
      mark('main', 'status');
      const place = cursorPending ? open.model.cards.findIndex((entry) => entry.key === ui.key) : -1;
      if (place >= 0) {
        ui.cursor = place;
        cursorPending = false;
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
      }
    } else if (message?.kind === 'end') {
      open.ended = true;
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

  const openRunSocket = (open: OpenRun) => {
    const connection = host.connect(`run=${enc(`${open.repo}/${open.runId}`)}`, {
      message: (text) => onRunMessage(open, text),
      close: () => {
        // A socket the run has since replaced closes without a retry.
        if (stopped || open !== run || open.ended || open.connection !== connection) return;
        open.retry = host.later(() => {
          delete open.retry;
          if (open !== run) return;
          open.model = emptyRun();
          delete open.error;
          openRunSocket(open);
          mark('main', 'status', 'inspector');
        }, RECONNECT_MS);
      },
    });
    open.connection = connection;
  };

  /** The open run's status as the index lists it, or undefined. */
  const listedStatus = (open: OpenRun) => {
    const item = index?.find((repo) => repo.name === open.repo)?.runs.find((entry) => entry.runId === open.runId);
    return item === undefined ? undefined : statusOf(item);
  };

  /**
   * Follows the open run's stream again, from an empty model, when its stream ended and the index says it runs again,
   * as `sail resume` makes it (review R1-2). Either order of the end and the index lands here.
   */
  function followAgain(open: OpenRun) {
    if (open !== run || !open.ended || listedStatus(open) !== 'running') return;
    if (open.retry !== undefined) host.cancel(open.retry);
    delete open.retry;
    open.ended = false;
    open.model = emptyRun();
    delete open.error;
    openRunSocket(open);
    mark('main', 'status', 'inspector');
  }

  const closeRun = () => {
    if (run === undefined) return;
    const closing = run;
    run = undefined;
    if (closing.retry !== undefined) host.cancel(closing.retry);
    closing.connection?.close();
  };

  const selectRun = (repo: string, runId: string) => {
    if (run?.repo === repo && run.runId === runId) return;
    closeRun();
    clearCall();
    ui.repo = repo;
    ui.runId = runId;
    delete ui.key;
    ui.cursor = 0;
    run = { repo, runId, model: emptyRun(), ended: false };
    openRunSocket(run);
    mark('rail', 'main', 'inspector', 'status');
  };

  const onQueueMessage = (open: OpenQueue, text: string) => {
    const message = parse(text);
    if (message?.kind !== 'queue-event') return;
    const event = message.event as QueueEvent;
    const recent = [...open.stream.recent, event].slice(-RECENT_EVENTS);
    const watch =
      event.type === 'watch:added' ? 'watched' : event.type === 'watch:removed' ? 'not watched' : open.stream.watch;
    open.stream = { recent, watch };
    mark('queues');
  };

  const openQueueSocket = (id: string) => {
    const open: OpenQueue = { stream: { recent: [], watch: 'unknown' } };
    queues.set(id, open);
    const connect = () => {
      open.connection = host.connect(`queue=${enc(id)}`, {
        message: (text) => onQueueMessage(open, text),
        close: () => {
          if (stopped || queues.get(id) !== open) return;
          open.retry = host.later(() => {
            delete open.retry;
            if (queues.get(id) !== open) return;
            open.stream = { recent: [], watch: 'unknown' };
            connect();
            mark('queues');
          }, RECONNECT_MS);
        },
      });
    };
    connect();
  };

  /** Opens a queue socket for every queue in the index, and closes those no longer in it. */
  const syncQueues = (repos: readonly IndexRepo[]) => {
    const wanted = new Set(repos.flatMap((repo) => repo.queues.map((view) => queueId(repo.name, view.workflow))));
    for (const [id, open] of queues) {
      if (wanted.has(id)) continue;
      queues.delete(id);
      if (open.retry !== undefined) host.cancel(open.retry);
      open.connection?.close();
    }
    for (const id of wanted) if (!queues.has(id)) openQueueSocket(id);
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
    index = message.repos;
    syncQueues(index);
    const listed = index.some((repo) => repo.name === ui.repo && repo.runs.some((entry) => entry.runId === ui.runId));
    if (!listed) {
      const first = firstRun(index);
      if (first !== undefined) selectRun(first.repo, first.runId);
    }
    if (run !== undefined) followAgain(run);
    mark('rail', 'attention', 'queues', 'main', 'status');
  };

  const openIndex = () => {
    indexConnection = host.connect('index=1', {
      message: onIndex,
      close: () => {
        if (stopped) return;
        indexRetry = host.later(() => {
          indexRetry = undefined;
          openIndex();
        }, RECONNECT_MS);
      },
    });
  };

  const step = (by: number) => {
    const cards = run?.model.cards ?? [];
    const at = cards.findIndex((entry) => entry.key === ui.key);
    const next = cards[at < 0 ? 0 : at + by];
    if (next !== undefined) selectCard(next.key);
  };

  const actions: Record<string, (data: Record<string, string>) => void> = {
    'select-run': (data) => {
      if (data.repo !== undefined && data.run !== undefined) selectRun(data.repo, data.run);
    },
    'select-card': (data) => selectCard(data.key),
    open: (data) => {
      if (data.repo === undefined || data.run === undefined) return;
      selectRun(data.repo, data.run);
      const tab = (TABS as readonly string[]).includes(data.tab ?? '') ? (data.tab as InspectorTab) : 'overview';
      if (data.key !== undefined) selectCard(data.key, tab);
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
      log = undefined;
      readLog();
      mark('inspector');
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
      mark('inspector');
    },
    copy: (data) => {
      if (data.text !== undefined) void host.copy(data.text);
    },
  };

  const keys: Record<string, () => void> = {
    Enter: () => {
      const card = run?.model.cards[ui.cursor];
      if (card !== undefined) selectCard(card.key);
    },
    Escape: () => selectCard(undefined),
    ']': () => step(1),
    '[': () => step(-1),
    i: () => actions['toggle-inspector']?.({}),
  };

  host.onAction((action, data) => actions[action]?.(data));
  host.onKey((key, inInput) => {
    if (inInput) return;
    const by = MOVES[key];
    if (by === undefined) return keys[key]?.();
    const last = (run?.model.cards.length ?? 0) - 1;
    ui.cursor = Math.max(0, Math.min(last, ui.cursor + by));
    mark('main');
  });
  openIndex();
  mark(...REGIONS);

  return {
    ui,
    stop() {
      stopped = true;
      indexConnection?.close();
      if (indexRetry !== undefined) host.cancel(indexRetry);
      closeRun();
      for (const open of queues.values()) {
        if (open.retry !== undefined) host.cancel(open.retry);
        open.connection?.close();
      }
      queues.clear();
      if (flushTimer !== undefined) host.cancel(flushTimer);
      if (logTimer !== undefined) host.cancel(logTimer);
    },
  };
}
