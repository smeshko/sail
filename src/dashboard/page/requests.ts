// The POSTs the queue's changes and the watch set's still make, until the registry carries them out: the answer, in
// `sail`'s own words, is shown beside what was clicked.
import { answerField, refusal } from './action-registry';
import type { Store } from './store';

const enc = encodeURIComponent;

/**
 * Asks the server to have the watcher `what` the queue of `workflow`, and shows the answer beside the queue's header: a
 * 200's message, what a 202 says the watcher has yet to do, or why it was refused. `took` runs when the change was applied.
 */
export function queueOp(store: Store, repo: string, workflow: string, what: string, body: unknown, took?: () => void) {
  const { ui, host } = store;
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
