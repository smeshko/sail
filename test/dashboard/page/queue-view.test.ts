// The queue panel, drawn: each watched workflow's items by state, its polling, its watch state from the queue's own
// stream, and a parked item's commands to copy. With no queue anywhere it draws nothing, which hides the panel.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { index } from '../../../src/dashboard/files';
import { queuePanels, watchState } from '../../../src/dashboard/page/index-model';
import { queueEventLine, queueId, renderQueues } from '../../../src/dashboard/page/queue-view';
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

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ("beta's panel shows its four items with their states, FAKE-6's reason with its requeue and drop commands, its polling, and watched", () => {
  const events = queueEvents();
  const streams = { [queueId('beta', QUEUE_WORKFLOW)]: { recent: events, watch: watchState(events) } };
  const markup = renderQueues(queuePanels(index(m.registryDir)), streams, initialUi(0), NOW).value;
  expect(
    [...markup.matchAll(/<div class="qrow2 (\w+)">.*?<span class="c-ref">([\w:-]+)<\/span>/g)].map(
      ([, state, key]) => `${key} ${state}`,
    ),
  ).toEqual(['ticket:FAKE-5 queued', 'ticket:FAKE-3 dispatched', 'ticket:FAKE-6 parked', 'ticket:FAKE-4 done']);
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
    `<button class="btn" data-action="select-run" data-repo="beta" data-run="${FAKE_3_ID}">${FAKE_3_ID}</button>`,
  );
  expect(markup).toContain('<span class="c-t">Escape &lt;b&gt;this&lt;/b&gt; &amp; &quot;that&quot;</span>');
  expect(markup.match(/<div class="ev">/g)?.length).toBe(9);
  expect(markup).toContain('<span class="ts">11:01:05</span><span class="tname">queue:parked</span>');
  expect(renderQueues([], {}, initialUi(0), NOW).value).toBe('');
});

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('each queue event is one line, and a type with no line of its own shows its type alone', () => {
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
  expect(queueEventLine({ ...at, type: 'watch:removed' })).toBe('removed from the watch set');
  expect(queueEventLine({ ...at, type: 'queue:dispatched', dedupKey: 'ticket:FAKE-5' })).toBe('');
  expect(queueEventLine({ ...error, paused: true, retryInMs: undefined } as QueueEvent)).toBe(
    'ticketSource fake: the ticket source did not answer in 30s (paused)',
  );
});
