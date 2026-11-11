// What the page's shell holds, as one object made per `boot()`: the index, the open run and its model, the open queue
// streams, what was read for the selected call, the person's `UiState`, the actor that carries its actions out, and the regions
// waiting to be drawn. Every module of the shell takes the store as its first argument. `mark()` is the one way to ask
// for a draw: it adds regions to the dirty set and schedules the flush, at most one per `FLUSH_MS`.
import type { RunActions } from '../actions';
import type { IndexRepo } from '../files';
import { type Actor, inertActor } from './act';
import type { OfferSource, Subject } from './action-registry';
import { attention, identity } from './attention';
import type { PageHost, Region } from './host';
import { queuePanels } from './index-model';
import type { Loaded } from './inspector-view';
import { VIEWS, type ViewName } from './list-model';
import { type QueueStream, queueId } from './queue-view';
import type { RunModel } from './run-model';
import { savedFolded, savedHidden, savedTheme, storedCleared } from './saved';
import type { CallOutput } from './timeline-view';
import { initialUi, type Pane, type UiState } from './ui-state';

export const FLUSH_MS = 100;

export interface OpenRun {
  repo: string;
  runId: string;
  model: RunModel;
  ended: boolean;
  /** When its stream's `end` arrived, by the host's clock. */
  endSeen?: number;
  error?: string;
  connection?: { close(): void };
  retry?: number;
}

export interface OpenQueue {
  connection?: { close(): void };
  stream: QueueStream;
  retry?: number;
}

export interface Store {
  readonly host: PageHost;
  readonly ui: UiState;
  index: IndexRepo[] | undefined;
  run: OpenRun | undefined;
  readonly queues: Map<string, OpenQueue>;
  /** The selected call's result and log, as read. */
  result: Loaded<unknown> | undefined;
  log: Loaded<string> | undefined;
  /** The key the log tab's text was read for: a call's, or one of its steps'. */
  logFor: string | undefined;
  /** The selected call's script output by call or step key, once a command is opened. */
  outputs: Record<string, CallOutput> | undefined;
  /** The drawer's file, as read. */
  doc: Loaded<string> | undefined;
  /** What the open run offers, as its actions route answered. */
  offers: RunActions | undefined;
  /** What the open run's status and queue item were when its actions were read. */
  offersFor: string | undefined;
  /** What a run that is not the open one offers, read for the command menu: its repository, its id and its offers. */
  subjectOffers: { repo: string; runId: string; offers: RunActions | undefined } | undefined;
  /** Bumped on every read of a subject's offers: only the latest is kept. */
  subjectOffersRead: number;
  /** Carries the registry's actions out: `boot()` wires it, with the effects only the shell can perform. */
  actor: Actor;
  /** The needs-attention identities a person cleared, and the identities of the Inbox rows last drawn. */
  cleared: Set<string>;
  drawn: string[];
  /** Set when a call is selected before its card exists: the cursor moves to it once it does. */
  cursorPending: boolean;
  /** Whether the list's cursor has moved since the list was drawn, so the next draw scrolls it into sight. */
  revealList: boolean;
  /** Whether a person closed what the centre showed (Esc, Back): no first row is selected again until one is opened or the view changes. */
  deselected: boolean;
  /** Whether the open row has changed since the list was drawn, so the next draw scrolls it into sight. */
  revealOpen: boolean;
  /** Whether the host was last told a run or queue is open beside the list. */
  detail: boolean | undefined;
  /** What the host was last told of the keyed pane: `none` while only one pane shows. */
  keyed: string | undefined;
  /** What the host was last told about the inspector: whether it is open and whether it is pinned. */
  inspector: string | undefined;
  /** What the URL asks to open, until the first index: then it is opened, or dropped when its run isn't listed. */
  start: Record<string, string> | undefined;
  /** The query last written to the URL, `undefined` until one is. */
  url: string | undefined;
  stopped: boolean;
  /** Bumped on every change of the selected call: a read made for an older one is dropped. */
  selection: number;
  /** Bumped on every read asked for: only the latest of each kind is shown. */
  resultRead: number;
  logRead: number;
  outputRead: number;
  docRead: number;
  offersRead: number;
  /** The latest read of the offers of a selection's runs: a read that is not the latest, or that a change of the selection outran, is dropped. */
  selectionRead: number;
  lastLogRead: number;
  lastOutputRead: number;
  flushTimer: number | undefined;
  /** The toast that says a URL named what is not there, while it is up. */
  missingToast: number | undefined;
  logTimer: number | undefined;
  outputTimer: number | undefined;
  tickTimer: number | undefined;
  /** The timer that takes the `copied` label off a copy button. */
  copiedTimer: number | undefined;
  indexRetry: number | undefined;
  indexConnection: { close(): void } | undefined;
  /** The last toast's id, the Undo each toast with one runs, and the timers that take a success off the stack. */
  toastSeq: number;
  readonly undos: Map<number, () => void>;
  readonly toastTimers: Map<number, number>;
  /** The regions to draw at the next flush. */
  readonly dirty: Set<Region>;
  /** What each region was last written with, and the regions whose fields the shell has just given up. */
  readonly written: Map<Region, string>;
  readonly fresh: Set<Region>;
  /** Whether the command menu's field or the menu itself is to take the focus once the menu is drawn. */
  menuFocus: boolean;
  /** Draws the dirty regions: the draw loop sets it. */
  flush: () => void;
  mark: (...regions: Region[]) => void;
}

export function createStore(host: PageHost): Store {
  const ui = initialUi(host.offset());
  ui.theme = savedTheme(host) ?? ui.theme;
  host.setTheme(ui.theme);
  ui.hidden = savedHidden(host);
  ui.listFolded = savedFolded(host);
  const asked = host.start().view;
  if ((VIEWS as readonly string[]).includes(asked ?? '')) ui.view = asked as ViewName;
  const cleared = new Set<string>(storedCleared(host));
  const store: Store = {
    host,
    ui,
    index: undefined,
    run: undefined,
    queues: new Map(),
    result: undefined,
    log: undefined,
    logFor: undefined,
    outputs: undefined,
    doc: undefined,
    offers: undefined,
    offersFor: undefined,
    subjectOffers: undefined,
    subjectOffersRead: 0,
    actor: inertActor(),
    cleared,
    drawn: [],
    cursorPending: false,
    revealList: false,
    deselected: false,
    revealOpen: false,
    detail: undefined,
    keyed: undefined,
    inspector: undefined,
    start: host.start(),
    url: undefined,
    stopped: false,
    selection: 0,
    resultRead: 0,
    logRead: 0,
    outputRead: 0,
    docRead: 0,
    offersRead: 0,
    selectionRead: 0,
    lastLogRead: Number.NEGATIVE_INFINITY,
    lastOutputRead: Number.NEGATIVE_INFINITY,
    flushTimer: undefined,
    missingToast: undefined,
    logTimer: undefined,
    outputTimer: undefined,
    tickTimer: undefined,
    copiedTimer: undefined,
    indexRetry: undefined,
    indexConnection: undefined,
    toastSeq: 0,
    undos: new Map(),
    toastTimers: new Map(),
    dirty: new Set(),
    written: new Map(),
    fresh: new Set(),
    menuFocus: false,
    flush: () => {
      store.flushTimer = undefined;
    },
    mark: (...regions) => {
      for (const region of regions) store.dirty.add(region);
      if (store.flushTimer === undefined && !store.stopped)
        store.flushTimer = host.later(() => store.flush(), FLUSH_MS);
    },
  };
  return store;
}

export const summaryOf = (store: Store, open: OpenRun | undefined) =>
  store.index?.find((repo) => repo.name === open?.repo)?.runs.find((item) => item.runId === open?.runId)?.summary;

export const selected = (store: Store) => store.run?.model.cards.find((entry) => entry.key === store.ui.key);

/** The queue the centre shows in place of the run, while the index lists it. */
export const openQueue = (store: Store) =>
  store.ui.queue === undefined
    ? undefined
    : queuePanels(store.index ?? []).find((panel) => queueId(panel.repo, panel.workflow) === store.ui.queue);

/** The card whose timeline the centre shows, when it shows one: a card selected before it exists shows the run. */
export const opened = (store: Store) => (store.ui.timeline ? selected(store) : undefined);

export const listed = (store: Store) =>
  store.index === undefined ? [] : attention(store.index).filter((item) => !store.cleared.has(identity(item)));

/** The run the centre shows: the open run, unless a queue is open in its place. */
export const centreRun = (store: Store) => (openQueue(store) === undefined ? store.run : undefined);

/** Whether a run or queue is open beside the list. */
export const detailOpen = (store: Store) => store.run !== undefined || store.ui.queue !== undefined;

/**
 * The keyed pane, while the list and an open run or queue are both on screen: from 800px up, with one open. Undefined
 * when only one pane shows, under 800px or with nothing open: the keys then drive what shows, as they always did.
 */
export const keyedPane = (store: Store): Pane | undefined =>
  store.host.narrow() || !detailOpen(store) ? undefined : store.ui.pane;

/** The pane the keys drive: the keyed pane, else the open run or queue, else the list. */
export const drivenPane = (store: Store): Pane => keyedPane(store) ?? (detailOpen(store) ? 'centre' : 'list');

/** The selected card, while the centre shows its run. */
export const centreCard = (store: Store) => (centreRun(store) === undefined ? undefined : selected(store));

/** Whether the inspector takes its room: it is pinned, or the centre shows a run with a selected card. */
export const inspectorOpen = (store: Store) => store.ui.pinned || centreCard(store) !== undefined;

/**
 * What the offers say for `subject`: the open run's offers for the open run, and a run that is not open its own, once
 * they were read (`readSubjectOffers`), else none.
 */
export function sourceFor(store: Store, subject?: Subject): OfferSource {
  const index = store.index ?? [];
  if (subject?.kind !== 'run' || (store.run?.repo === subject.repo && store.run.runId === subject.runId))
    return { run: store.offers, index, ...(store.ui.start === undefined ? {} : { start: store.ui.start }) };
  const read = store.subjectOffers;
  const own = read?.repo === subject.repo && read.runId === subject.runId ? read.offers : undefined;
  return { run: own, index, ...(store.ui.start === undefined ? {} : { start: store.ui.start }) };
}
