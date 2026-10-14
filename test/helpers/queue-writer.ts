// The child process of the queue store's kill test: opens the queue of workflow `writer` under the runs directory given
// as its argument, and adds FAKE-1, FAKE-2, … one per write until it is killed, printing each number once its write
// has returned.
import { openQueue } from '../../src/watch/queue-store';
import { ticket } from './queue';

const [runsDir] = process.argv.slice(2);
const store = openQueue({ runsDir: runsDir as string, workflow: 'writer', label: 'sail', now: () => new Date() });
if ('refused' in store) throw new Error(store.refused);
for (let n = 1; n <= 100_000; n += 1) {
  store.add([ticket(`FAKE-${n}`)]);
  console.log(n);
}
