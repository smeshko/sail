// The POSTs the queue's changes and the watch set's still make, until the registry carries them out: the answer, in
// `sail`'s own words, is shown beside what was clicked.
import { answerField, refusal } from './action-registry';
import type { Store } from './store';

const enc = encodeURIComponent;

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
