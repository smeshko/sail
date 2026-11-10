// What the page reads over REST for the selection: a call's result and log, a script command's output, a file for the
// drawer and what the open run offers. Each read drops its answer when the selection has moved on or a newer read of
// the same kind has been asked for, and a running call's log and output are read again at most once a second.
import type { RunActions } from '../actions';
import { isMarkdown } from './drawer-view';
import { statusOf } from './index-model';
import { logTarget } from './inspector-view';
import type { OpenRun, Store } from './store';
import { outputKey, scriptId } from './timeline-view';
import type { InspectorTab } from './ui-state';

export const LOG_REFRESH_MS = 1000;

const enc = encodeURIComponent;

const callPath = (open: OpenRun, key: string) =>
  `/api/repos/${enc(open.repo)}/runs/${enc(open.runId)}/calls/${enc(key)}`;

export function readResult(store: Store) {
  const { ui, host } = store;
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
    store.mark('inspector');
  });
}

export function readLog(store: Store) {
  const { ui, host } = store;
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
    store.mark('inspector');
  });
}

/** Reads a running call's log again, at most once a second, and at once when the log tab has moved to its next step. */
export function refreshLog(store: Store) {
  const { ui, host } = store;
  const card = store.run?.model.cards.find((entry) => entry.key === ui.key);
  if (card !== undefined && logTarget(card, ui).key !== store.logFor) {
    if (store.logTimer !== undefined) host.cancel(store.logTimer);
    store.logTimer = undefined;
    return readLog(store);
  }
  if (store.logTimer !== undefined) return;
  const wait = Math.max(0, store.lastLogRead + LOG_REFRESH_MS - host.now());
  if (wait === 0) return readLog(store);
  store.logTimer = host.later(() => {
    store.logTimer = undefined;
    readLog(store);
  }, wait);
}

/** The read keys of the selected call's opened script rows. */
export function openedOutputKeys(store: Store): string[] {
  const { ui } = store;
  const card = store.run?.model.cards.find((entry) => entry.key === ui.key);
  if (card === undefined) return [];
  return card.timeline
    .filter((entry) => entry.kind === 'script')
    .filter((_, index) => ui.opened.includes(scriptId(index)))
    .map((entry) => outputKey(card, entry));
}

/** Reads stdout and stderr for opened script rows and keys already read. */
export function readOutput(store: Store) {
  const { ui, host } = store;
  const open = store.run;
  const key = ui.key;
  if (open === undefined || key === undefined) return;
  const asked = ++store.outputRead;
  const forSelection = store.selection;
  store.lastOutputRead = host.now();
  store.outputs ??= {};
  const keys = new Set([...Object.keys(store.outputs), ...openedOutputKeys(store)]);
  for (const key of keys) {
    store.outputs[key] ??= { stdout: { state: 'loading' }, stderr: { state: 'loading' } };
    const output = store.outputs[key];
    for (const stream of ['stdout', 'stderr'] as const) {
      void host.get(`${callPath(open, key)}/log?stream=${stream}`).then((answer) => {
        if (asked !== store.outputRead || forSelection !== store.selection || store.outputs === undefined) return;
        output[stream] = answer.status === 200 ? { state: 'loaded', value: answer.body } : { state: 'missing' };
        store.mark('main');
      });
    }
  }
}

/** Reads a running call's output again, at most once a second. */
export function refreshOutput(store: Store) {
  const { host } = store;
  if (store.outputTimer !== undefined) return;
  const wait = Math.max(0, store.lastOutputRead + LOG_REFRESH_MS - host.now());
  if (wait === 0) return readOutput(store);
  store.outputTimer = host.later(() => {
    store.outputTimer = undefined;
    readOutput(store);
  }, wait);
}

export function clearCall(store: Store) {
  const { host } = store;
  store.selection++;
  store.result = undefined;
  store.log = undefined;
  store.outputs = undefined;
  if (store.logTimer !== undefined) host.cancel(store.logTimer);
  store.logTimer = undefined;
  if (store.outputTimer !== undefined) host.cancel(store.outputTimer);
  store.outputTimer = undefined;
}

/** Selects the call `key`, or none. `timeline` opens its timeline, or goes back to the cards; left out, keeps either. */
export function selectCard(store: Store, key: string | undefined, tab?: InspectorTab, timeline?: boolean) {
  const { ui } = store;
  clearCall(store);
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
    readResult(store);
    if (ui.tab === 'log') readLog(store);
  }
  store.mark('main', 'inspector');
}

export function closeFile(store: Store) {
  const { ui } = store;
  if (ui.file === undefined) return;
  delete ui.file;
  store.doc = undefined;
  store.docRead++;
  store.mark('drawer');
}

export function openFile(store: Store, name: string, path: string) {
  const { ui, host } = store;
  const open = store.run;
  if (open === undefined) return;
  ui.file = { name, path };
  store.doc = { state: 'loading' };
  const asked = ++store.docRead;
  const as = isMarkdown(path) ? '&as=html' : '';
  void host.get(`/api/repos/${enc(open.repo)}/runs/${enc(open.runId)}/file?path=${enc(path)}${as}`).then((answer) => {
    if (asked !== store.docRead) return;
    store.doc = answer.status === 200 ? { state: 'loaded', value: answer.body } : { state: 'missing' };
    store.mark('drawer');
  });
  store.mark('drawer');
}

/** The open run's status and its queue items' states: what its actions depend on that the index shows. */
export function offerSignature(store: Store, open: OpenRun) {
  const repo = store.index?.find((each) => each.name === open.repo);
  const item = repo?.runs.find((each) => each.runId === open.runId);
  const queued = (repo?.queues ?? []).flatMap((view) =>
    (view.queue?.items ?? [])
      .filter((each) => each.runId === open.runId)
      .map((each) => `${view.workflow}:${each.state}:${each.retryAt ?? ''}`),
  );
  return `${item === undefined ? '' : statusOf(item)}|${queued.join(',')}`;
}

export function readOffers(store: Store) {
  const { host } = store;
  const open = store.run;
  if (open === undefined) return;
  const asked = ++store.offersRead;
  store.offersFor = offerSignature(store, open);
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
    store.mark('rail');
  });
}

/** Cancels the timers a read left, on the page's teardown. */
export function stopReads(store: Store): void {
  if (store.logTimer !== undefined) store.host.cancel(store.logTimer);
  if (store.outputTimer !== undefined) store.host.cancel(store.outputTimer);
}
