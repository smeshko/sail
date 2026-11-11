// The POSTs the page's actions make, and how a refusal is worded. A queue change, a resume, a restart, a stop, a clean
// and a change of a repository's watch set each ask the dashboard's server, and the answer, in `sail`'s own words, is
// shown beside what was clicked: a refusal as the server's message, else "the <what> was refused (<status>)", or "could
// not be sent" when nothing answered. A started resume or restart opens its run, and a clean leaves the run it removed.
import { openQueue, type Store } from './store';
import { closeRun, selectRun } from './streams';

const enc = encodeURIComponent;

/** Why a request of kind `what` (a move, a resume, a restart) was refused: the `error` its answer carries, else its status. */
export function refusal(status: number, body: string, what: string): string {
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
export function answerField(body: string, field: string): string | undefined {
  try {
    const value = (JSON.parse(body) as Record<string, unknown>)[field];
    return typeof value === 'string' && value !== '' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Asks the server to have the watcher `what` the queue of `workflow`, and shows the answer beside the queue's header: a
 * 200's message, what a 202 says the watcher has yet to do, or why it was refused. `took` runs when the change was applied.
 */
export function queueOp(store: Store, repo: string, workflow: string, what: string, body: unknown, took?: () => void) {
  const { ui, host } = store;
  // A workflow that isn't watched is refused, so nothing is sent: a key in the add field, or a click that raced an index.
  const panel = openQueue(store);
  if (panel !== undefined && panel.watch.state !== 'watched') return;
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
}

/**
 * A first click arms Resume or Restart, which then reads what it will do; a second click posts it. A raise that isn't
 * a positive number, or a stage changed since the arming, arms again instead.
 */
export function startRun(store: Store, kind: 'resume' | 'restart') {
  const { ui, host } = store;
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
}

/**
 * A first click arms Stop or Clean, which then names what it will do; a second click posts it. Stop posts `{ now }`
 * and reads the run again. Clean posts `{}` and, once the run is gone, leaves it and shows the answer in the rail.
 */
export function endRun(store: Store, kind: 'stop' | 'clean') {
  const { ui, host } = store;
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
}

/** Asks the server to watch or unwatch `workflow` of `repo` (every workflow, when none), and shows its answer under the repository's header. */
export function watchSet(store: Store, repo: string, op: 'watch' | 'unwatch', workflow?: string) {
  const { ui, host } = store;
  ui.watchNotice = { repo, text: op === 'watch' ? 'watching…' : 'unwatching…' };
  store.mark('rail');
  void host
    .post(`/api/repos/${enc(repo)}/${op}`, { workflows: workflow === undefined ? [] : [workflow] })
    .then(({ status, body }) => {
      if (store.stopped) return;
      const said =
        status === 200 || status === 202 ? (answerField(body, 'message') ?? answerField(body, 'waiting')) : undefined;
      if (said !== undefined) ui.watchNotice = { repo, text: said };
      else if (status === 200 || status === 202) delete ui.watchNotice;
      else ui.watchNotice = { repo, text: refusal(status, body, op) };
      store.mark('rail');
    });
}
