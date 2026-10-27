// The queue panel, drawn: each watched workflow's items by state, its polling, its watch state from the queue's own
// stream, and a parked item's commands to copy. With no queue anywhere it draws nothing, which hides the panel.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { index } from '../../../src/dashboard/files';
import { queuePanels, watchState } from '../../../src/dashboard/page/index-model';
import { queueEventLine, queueId, renderQueue } from '../../../src/dashboard/page/queue-view';
import { initialUi } from '../../../src/dashboard/page/ui-state';
import type { QueueEvent } from '../../../src/events/types';
import { FAKE_3_ID, type Machine, QUEUE_WORKFLOW, queueDirOf, seedFixtures } from '../../helpers/dashboard';

let m: Machine;
beforeEach(() => {
  m = seedFixtures();
});
afterEach(() => m.remove());

const NOW = Date.parse('2026-09-24T11:10:00.000Z');
const queueEvents = (): QueueEvent[] =>
  readFileSync(join(queueDirOf(m), 'events.ndjson'), 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));

test("beta's queue view shows its header, its four items each in the box of its state, its recent events folded, FAKE-6's reason with its requeue and drop commands, its polling, and watched", () => {
  const events = queueEvents();
  const id = queueId('beta', QUEUE_WORKFLOW);
  const panel = queuePanels(index(m.registryDir)).find((each) => queueId(each.repo, each.workflow) === id);
  if (panel === undefined) throw new Error('beta has no queue');
  const markup = renderQueue(panel, { recent: events, watch: watchState(events) }, initialUi(0), NOW).value;
  expect(markup).toStartWith(
    '<div class="d-h"><span class="d-title">ticket-to-pr queue</span><span class="d-agent">beta</span></div>',
  );
  expect(
    [
      ...markup.matchAll(
        /<div class="qsec grp-t">([\w ·]+)<\/div><div class="qbox"><div class="qrow2[\w ]*"><span class="c-dot"><i class="(\w+)"><\/i><\/span><span class="c-ref">([\w:-]+)<\/span>/g,
      ),
    ].map(([, box, state, key]) => `${box}: ${key} ${state}`),
  ).toEqual([
    'waiting · 1: ticket:FAKE-5 queued',
    'running · 1: ticket:FAKE-3 dispatched',
    'parked · 1: ticket:FAKE-6 parked',
    'done · 1: ticket:FAKE-4 done',
  ]);
  expect(markup).toContain('<div class="qrow2 done">');
  expect(markup).toContain(
    '<button class="qrecent-h" data-action="toggle-queue-events"><span class="caret">›</span>recent queue events<span class="n">9</span></button>\n</section>',
  );
  expect(markup).toContain(
    '<span class="nm">beta / ticket-to-pr</span><span class="pill p-pass">watched</span><span class="dt">label sail · polled 5m ago · 0 failed polls</span>',
  );
  expect(markup).toContain(
    'parked · 2 attempts · <span class="why">stage_error: implement#1 ended in error: harness: the session ended before it submitted a result</span>',
  );
  expect(markup).toContain(
    '<code>sail queue requeue ticket-to-pr ticket:FAKE-6</code><button class="btn" data-action="copy" data-text="sail queue requeue ticket-to-pr ticket:FAKE-6" title="requeue">copy</button>',
  );
  expect(markup).toContain('<code>sail queue drop ticket-to-pr ticket:FAKE-6</code>');
  expect(markup).toContain(
    `<button class="run-link" data-action="select-run" data-repo="beta" data-run="${FAKE_3_ID}" title="open ${FAKE_3_ID}">${FAKE_3_ID} ›</button>`,
  );
  expect(markup).toContain('<span class="c-t">Escape &lt;b&gt;this&lt;/b&gt; &amp; &quot;that&quot;</span>');
  expect(markup).not.toContain('<div class="ev">');
  const opened = renderQueue(
    panel,
    { recent: events, watch: watchState(events) },
    { ...initialUi(0), queueEvents: true },
    NOW,
  ).value;
  expect(opened).toContain('<button class="qrecent-h open" data-action="toggle-queue-events">');
  expect(opened.match(/<div class="ev">/g)?.length).toBe(9);
  expect(opened).toContain('<span class="ts">11:01:05</span><span class="tname">queue:parked</span>');
});

test('a failed item shows its requeue and drop commands, and a queue with no items says it is empty', () => {
  const [panel] = queuePanels(index(m.registryDir));
  if (panel === undefined) throw new Error('beta has no queue');
  const failed = panel.items.map((item) => (item.state === 'parked' ? { ...item, state: 'failed' as const } : item));
  const markup = renderQueue({ ...panel, items: failed }, undefined, initialUi(0), NOW).value;
  expect(markup).toContain('<div class="qsec grp-t">failed · 1</div>');
  expect(markup).toContain('<code>sail queue requeue ticket-to-pr ticket:FAKE-6</code>');
  expect(renderQueue({ ...panel, items: [] }, undefined, initialUi(0), NOW).value).toContain(
    '<div class="qempty">the queue is empty</div>',
  );
});

test('each queue event is one line, and a type with no line of its own shows its type alone', () => {
  const [added, polled, item, , , , error, , parked] = queueEvents();
  const lines = [added, polled, item, error, parked].map((event) => queueEventLine(event as QueueEvent));
  expect(lines).toEqual([
    'added to the watch set',
    'found 4, added 4, label sail',
    'ticket:FAKE-5 Link the changelog from the README',
    'ticketSource fake: the ticket source did not answer in 30s',
    'ticket:FAKE-6 after 2 attempts: stage_error: implement#1 ended in error: harness: the session ended before it submitted a result',
  ]);
  const at = { seq: 20, ts: '2026-09-24T12:00:00.000Z', workflow: QUEUE_WORKFLOW };
  expect(queueEventLine({ ...at, type: 'watch:removed', pid: 1 } as QueueEvent)).toBe('removed from the watch set');
  expect(
    queueEventLine({
      ...at,
      type: 'queue:dispatched',
      dedupKey: 'ticket:FAKE-5',
      run: 'r',
      attempt: 1,
      pid: 1,
    } as QueueEvent),
  ).toBe('');
  const { retryInMs: _retryInMs, ...queueError } = error as Extract<QueueEvent, { type: 'queue:error' }>;
  expect(queueEventLine({ ...queueError, paused: true } as QueueEvent)).toBe(
    'ticketSource fake: the ticket source did not answer in 30s (paused)',
  );
});
