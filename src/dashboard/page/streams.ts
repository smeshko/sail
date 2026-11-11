// The page's sockets and the rules they follow: one index socket feeding the rail, needs attention, the queue view and
// the open run's summary; one run socket for the open run, whose events are folded into the run model; and one queue
// socket per watched workflow in the index. A run or queue socket that closes without `end` reconnects after 2 s from an
// empty model, unless its stream sent `error`: then the error stays, with no reconnect, until it is clicked again. The
// index socket always reconnects. The first index opens what the URL names, else the newest running
// run, else the newest, and a selection is kept while its run is still listed. Nothing here knows of a click or a key.
import type { QueueEvent, SailEvent } from '../../events/types';
import type { IndexRepo } from '../files';
import type { Message } from '../streams';
import { attention, identity } from './attention';
import { tick } from './draw';
import { newestFirst, railRepos, statusOf } from './index-model';
import { syncUrl } from './location';
import { queueId } from './queue-view';
import {
  clearCall,
  closeFile,
  offerSignature,
  readOffers,
  readResult,
  refreshLog,
  refreshOutput,
  selectCard,
} from './reads';
import { applyEvent, emptyRun } from './run-model';
import { saveCleared, storedCleared } from './saved';
import { type OpenQueue, type OpenRun, openQueue, type Store } from './store';

export const RECONNECT_MS = 2000;
/** How many of a queue's events its panel lists. */
export const RECENT_EVENTS = 20;

const enc = encodeURIComponent;

function parse(text: string): Message | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'object' && value !== null ? (value as Message) : undefined;
  } catch {
    return undefined;
  }
}

/** A close handler that, unless the stream failed or is no longer live, runs `again` after the reconnect delay. */
function retryOnClose(
  store: Store,
  holder: { retry?: number },
  failed: () => boolean,
  live: () => boolean,
  again: () => void,
) {
  return () => {
    if (store.stopped || failed() || !live()) return;
    holder.retry = store.host.later(() => {
      delete holder.retry;
      if (live()) again();
    }, RECONNECT_MS);
  };
}

export function onRunMessage(store: Store, open: OpenRun, text: string) {
  const { ui, host } = store;
  if (open !== store.run) return;
  const message = parse(text);
  if (message?.kind === 'event') {
    const event = message.event as SailEvent & { key?: unknown };
    applyEvent(open.model, event);
    store.mark('main', 'status');
    tick(store);
    const place = store.cursorPending ? open.model.cards.findIndex((entry) => entry.key === ui.key) : -1;
    if (place >= 0) {
      ui.cursor = place;
      store.cursorPending = false;
    }
    const key = typeof event.key === 'string' ? event.key.split('/')[0] : undefined;
    if (key !== undefined && key === ui.key) {
      store.mark('inspector');
      const card = open.model.cards.find((entry) => entry.key === key);
      // The call's end: its result.json is written now, and its log has its last lines (review R1-3). Each try ends,
      // and a corrective try writes its own result.json, so even a loaded one is read again (review R2-2).
      const ended = (event.type === 'stage:end' || event.type === 'intake:end') && event.key === key;
      if (ended) readResult(store);
      if (ui.tab === 'log' && (card?.state === 'running' || ended)) refreshLog(store);
      if (ui.timeline && store.outputs !== undefined && (card?.state === 'running' || ended)) refreshOutput(store);
    }
  } else if (message?.kind === 'end') {
    open.ended = true;
    open.endSeen = host.now();
    store.mark('main', 'status');
    // A call the URL named that the run never made is dropped, keeping the run.
    if (store.cursorPending && ui.key !== undefined) {
      ui.indexNotice = `call ${ui.key} is not in run ${open.runId}`;
      selectCard(store, undefined);
      store.mark('rail');
      syncUrl(store, false);
    }
    // An index saying the run runs again may have come before this end: look again once the index has caught up
    // (review R2-3).
    open.retry = host.later(() => {
      delete open.retry;
      followAgain(store, open);
    }, RECONNECT_MS);
  } else if (message?.kind === 'error') {
    open.error = message.message;
    store.mark('main');
  }
}

export function openRunSocket(store: Store, open: OpenRun) {
  const { host } = store;
  const connection = host.connect(`run=${enc(`${open.repo}/${open.runId}`)}`, {
    message: (text) => onRunMessage(store, open, text),
    // A socket the run has since replaced, or that ended, closes without a retry, and so does one whose stream sent
    // `error`: the error stays until the run is clicked again.
    close: retryOnClose(
      store,
      open,
      () => open.error !== undefined,
      () => !(open !== store.run || open.ended || open.connection !== connection),
      () => {
        open.model = emptyRun();
        delete open.error;
        openRunSocket(store, open);
        store.mark('main', 'status', 'inspector');
      },
    ),
  });
  open.connection = connection;
}

/**
 * Whether the index lists the ended run otherwise than its stream ended it: running again, as `sail resume` makes it,
 * or ended with another status or at another time, by a resume that ran between two polls (review R3-1).
 */
export function movedOn(store: Store, open: OpenRun) {
  const item = store.index?.find((repo) => repo.name === open.repo)?.runs.find((entry) => entry.runId === open.runId);
  if (item === undefined) return false;
  const { end, endedAt } = open.model;
  if (statusOf(item) !== (end?.status ?? 'running')) return true;
  const listed = item.summary?.endedAt;
  return listed !== undefined && endedAt !== undefined && listed !== endedAt;
}

/**
 * Follows the open run's stream again, from an empty model, when its stream ended and the index has since moved on
 * (review R1-2). Either order of the end and the index lands here. For the reconnect delay after the end, an index
 * may still be one read before it, so only the check the end set up then decides (review R3-3).
 */
export function followAgain(store: Store, open: OpenRun, fromIndex = false) {
  const { host } = store;
  if (open !== store.run || !open.ended || !movedOn(store, open)) return;
  if (fromIndex && host.now() - (open.endSeen ?? 0) < RECONNECT_MS) return;
  if (open.retry !== undefined) host.cancel(open.retry);
  delete open.retry;
  open.ended = false;
  open.model = emptyRun();
  delete open.error;
  openRunSocket(store, open);
  store.mark('main', 'status', 'inspector');
}

export function closeRun(store: Store) {
  const { host } = store;
  if (store.run === undefined) return;
  const closing = store.run;
  store.run = undefined;
  if (closing.retry !== undefined) host.cancel(closing.retry);
  closing.connection?.close();
}

export function selectRun(store: Store, repo: string, runId: string) {
  const { ui } = store;
  // Opening a run, by any path, ends a notice that a URL named what is not listed.
  delete ui.indexNotice;
  if (store.run?.repo === repo && store.run.runId === runId && store.run.error === undefined) return;
  closeRun(store);
  clearCall(store);
  ui.repo = repo;
  ui.runId = runId;
  closeFile(store);
  delete ui.key;
  ui.timeline = false;
  ui.opened = [];
  ui.cursor = 0;
  store.run = { repo, runId, model: emptyRun(), ended: false };
  store.offers = undefined;
  delete ui.runMenu;
  store.actor.forget('run');
  store.fresh.add('rail');
  openRunSocket(store, store.run);
  readOffers(store);
  store.mark('rail', 'main', 'inspector', 'status');
}

export function onQueueMessage(store: Store, id: string, open: OpenQueue, text: string) {
  const { ui } = store;
  const message = parse(text);
  if (message?.kind === 'error') {
    open.stream = { ...open.stream, error: message.message };
    if (ui.queue === id) store.mark('main');
    return;
  }
  if (message?.kind !== 'queue-event') return;
  const event = message.event as QueueEvent;
  const recent = [...open.stream.recent, event].slice(-RECENT_EVENTS);
  const polls =
    event.type === 'queue:polled' ? (event as Extract<QueueEvent, { type: 'queue:polled' }>).kind : open.stream.polls;
  open.stream = { recent, ...(polls === undefined ? {} : { polls }) };
  if (ui.queue === id) store.mark('main');
}

export function connectQueue(store: Store, id: string, open: OpenQueue) {
  const { ui, host } = store;
  const connection = host.connect(`queue=${enc(id)}`, {
    message: (text) => onQueueMessage(store, id, open, text),
    // A socket the queue has since replaced closes without a retry, like the run's.
    close: retryOnClose(
      store,
      open,
      () => open.stream.error !== undefined,
      () => store.queues.get(id) === open && open.connection === connection,
      () => {
        open.stream = { recent: [] };
        connectQueue(store, id, open);
        if (ui.queue === id) store.mark('main');
      },
    ),
  });
  open.connection = connection;
}

export function openQueueSocket(store: Store, id: string) {
  const open: OpenQueue = { stream: { recent: [] } };
  store.queues.set(id, open);
  connectQueue(store, id, open);
}

/** Opens a queue socket for every queue in the index, and closes those no longer in it. */
export function syncQueues(store: Store, repos: readonly IndexRepo[]) {
  const { host } = store;
  const wanted = new Set(repos.flatMap((repo) => repo.queues.map((view) => queueId(repo.name, view.workflow))));
  for (const [id, open] of store.queues) {
    if (wanted.has(id)) continue;
    store.queues.delete(id);
    if (open.retry !== undefined) host.cancel(open.retry);
    open.connection?.close();
  }
  for (const id of wanted) if (!store.queues.has(id)) openQueueSocket(store, id);
}

/** The run to open on the first index: the newest running one, else the newest. */
export function firstRun(store: Store, repos: readonly IndexRepo[]) {
  const { host } = store;
  const all = newestFirst(
    railRepos(repos, host.now()).flatMap((repo) => repo.runs.map((entry) => ({ ...entry, repo: repo.name }))),
  );
  return all.find((entry) => entry.status === 'running') ?? all[0];
}

export function onIndex(store: Store, text: string, onStart: (asked: Record<string, string>) => void) {
  const { ui, host } = store;
  const message = parse(text);
  if (message?.kind !== 'index') return;
  const repos = message.repos;
  store.index = repos;
  const still = new Set(attention(repos).map(identity));
  if ([...store.cleared].some((id) => !still.has(id))) {
    store.cleared = new Set([...storedCleared(host), ...store.cleared].filter((id) => still.has(id)));
    saveCleared(host, store.cleared);
  }
  syncQueues(store, repos);
  const lists = (name?: string, runId?: string) =>
    repos.some((repo) => repo.name === name && repo.runs.some((entry) => entry.runId === runId));
  const asked = store.start;
  store.start = undefined;
  if (asked !== undefined) onStart(asked);
  else if (!lists(ui.repo, ui.runId)) {
    const first = firstRun(store, repos);
    if (first !== undefined) selectRun(store, first.repo, first.runId);
  }
  if (store.run !== undefined) followAgain(store, store.run, true);
  if (store.run !== undefined && offerSignature(store, store.run) !== store.offersFor) {
    store.actor.disarm();
    readOffers(store);
  }
  if (ui.queue !== undefined && openQueue(store) === undefined) delete ui.queue;
  syncUrl(store, false);
  store.mark('rail', 'attention', 'main', 'status');
  tick(store);
}

export function openIndex(store: Store, onStart: (asked: Record<string, string>) => void) {
  const { host } = store;
  store.indexConnection = host.connect('index=1', {
    message: (text) => onIndex(store, text, onStart),
    close: () => {
      if (store.stopped) return;
      store.indexRetry = host.later(() => {
        store.indexRetry = undefined;
        openIndex(store, onStart);
      }, RECONNECT_MS);
    },
  });
}

/** Ends a notice that a URL named what is not listed, and connects the queue `id` again from an empty stream when its
 * stream sent `error`. */
export function reopenQueue(store: Store, id: string): void {
  delete store.ui.indexNotice;
  const failed = store.queues.get(id);
  if (failed?.stream.error !== undefined) {
    failed.stream = { recent: [] };
    connectQueue(store, id, failed);
  }
}

/** Closes every socket and cancels the timers that reconnect them, on the page's teardown. */
export function stopStreams(store: Store): void {
  store.indexConnection?.close();
  if (store.indexRetry !== undefined) store.host.cancel(store.indexRetry);
  closeRun(store);
  for (const open of store.queues.values()) {
    if (open.retry !== undefined) store.host.cancel(open.retry);
    open.connection?.close();
  }
  store.queues.clear();
}
