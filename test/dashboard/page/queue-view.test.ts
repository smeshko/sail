// The queue panel, drawn: each watched workflow's items by state, its polling, its watch state from the live watcher, and a parked item's requeue and drop buttons. With no queue anywhere it draws nothing, which hides the panel.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { index } from '../../../src/dashboard/files';
import { type QueuePanel, queuePanels } from '../../../src/dashboard/page/index-model';
import { queueEventLine, queueId, renderQueue, renderQueueStatus } from '../../../src/dashboard/page/queue-view';
import { initialUi } from '../../../src/dashboard/page/ui-state';
import type { QueueEvent } from '../../../src/events/types';
import { FAKE_3_ID, type Machine, QUEUE_WORKFLOW, queueDirOf, seedFixtures } from '../../helpers/dashboard';

let m: Machine;
beforeEach(() => {
  m = seedFixtures();
});
afterEach(() => m.remove());

/** beta's panels as the index gives them for a live watcher that watches them. */
const watchedPanels = () =>
  queuePanels(index(m.registryDir)).map((panel) => ({ ...panel, watch: { state: 'watched' as const } }));

/**
 * `panel` with the offers the server gives each of its items by state: drop unless it runs, requeue on a parked item and
 * on a failed one whose run `ended`, move on a waiting one. For a panel whose items a test has changed.
 */
function withOffers(panel: QueuePanel, ended: (key: string) => boolean = () => true): QueuePanel {
  const on = { enabled: true };
  const items = Object.fromEntries(
    panel.items.map((item) => [
      item.dedupKey,
      {
        ...(item.state === 'parked' || (item.state === 'failed' && ended(item.dedupKey)) ? { requeue: on } : {}),
        ...(item.state === 'dispatched' ? {} : { drop: on }),
        ...(item.state === 'queued' ? { move: on } : {}),
      },
    ]),
  );
  const repoOffers = { watch: on, workflows: { [panel.workflow]: { unwatch: on } } };
  return { ...panel, offers: { poll: on, add: on, items }, repoOffers };
}

const NOW = Date.parse('2026-09-24T11:10:00.000Z');
const queueEvents = (): QueueEvent[] =>
  readFileSync(join(queueDirOf(m), 'events.ndjson'), 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));

describe('the status bar with a queue open (ADW-548)', () => {
  test('names the queue, its watch state, and how many items wait and run', () => {
    const [panel] = watchedPanels();
    if (panel === undefined) throw new Error('beta has no queue');
    const counts = { queued: 3, dispatched: 2, failed: 0, parked: 0, done: 0 };
    expect(renderQueueStatus({ ...panel, counts }).value).toBe(
      '<span>beta / ticket-to-pr</span><span>watched</span><span>waiting <b>3</b></span><span>running <b>2</b></span>',
    );
  });

  test('says a workflow nobody watches, and a zero count', () => {
    const [panel] = watchedPanels();
    if (panel === undefined) throw new Error('beta has no queue');
    const counts = { queued: 0, dispatched: 0, failed: 1, parked: 0, done: 0 };
    const markup = renderQueueStatus({
      ...panel,
      counts,
      watch: { state: 'watcher not running', why: 'no watcher is running' },
    }).value;
    expect(markup).toBe(
      '<span>beta / ticket-to-pr</span><span>watcher not running</span><span>waiting <b>0</b></span><span>running <b>0</b></span>',
    );
  });
});

describe('audit 2: rows say what they are (ADW-543)', () => {
  test("a queue that can't be read draws its problem in place of its counts, its items and its add field", () => {
    const [panel] = watchedPanels();
    if (panel === undefined) throw new Error('beta has no queue');
    const stream = { recent: [], polls: 'ticket' as const };
    const bad = renderQueue(
      withOffers({ ...panel, items: [], problem: 'queue.json is no <b>JSON</b>' }),
      stream,
      initialUi(0),
      NOW,
    ).value;
    expect(bad).toContain(
      `<div class="qproblem"><div class="qproblem-t">this queue can't be read</div><div class="code bad">queue.json is no &lt;b&gt;JSON&lt;/b&gt;</div></div>`,
    );
    expect(bad).not.toContain('statebar');
    expect(bad).not.toContain('the queue is empty');
    expect(bad).not.toContain('qadd');
    const good = renderQueue(withOffers(panel), stream, initialUi(0), NOW).value;
    expect(good).toContain('<div class="statebar">');
    expect(good).toContain('<div class="qadd"');
  });

  test("an item's sub-line leaves out the state its box is headed with, and the word under way leads it while a request is out", () => {
    const [panel] = watchedPanels();
    if (panel === undefined) throw new Error('beta has no queue');
    const markup = renderQueue(panel, undefined, initialUi(0), NOW).value;
    const subs = [...markup.matchAll(/<span class="c-sub">([^<]*)/g)].map(([, sub]) => sub);
    expect(subs.every((sub) => /^\d+ attempts?/.test(sub ?? ''))).toBe(true);
    const busy = { ...initialUi(0), underway: { [`item:beta/${QUEUE_WORKFLOW}/ticket:FAKE-5`]: 'requeuing…' } };
    expect(renderQueue(panel, undefined, busy, NOW).value).toContain(
      '<span class="c-sub"><span class="busy">requeuing…</span> · 0 attempts',
    );
  });
});

test("beta's queue view lists running first, shows its header, its four items each in the box of its state, its recent events folded, FAKE-6's reason with its requeue and drop commands, its polling, and watched", () => {
  const events = queueEvents();
  const id = queueId('beta', QUEUE_WORKFLOW);
  const panel = watchedPanels().find((each) => queueId(each.repo, each.workflow) === id);
  if (panel === undefined) throw new Error('beta has no queue');
  const markup = renderQueue(panel, { recent: events }, initialUi(0), NOW).value;
  expect(markup).toStartWith(
    '<div class="d-h"><span class="d-title">ticket-to-pr queue</span><span class="d-agent">beta</span></div>',
  );
  expect(
    [
      ...markup.matchAll(
        /<button class="qsec grp-t open" data-action="toggle-queue-section" data-section="beta\/ticket-to-pr:\w+" aria-expanded="true"><span class="caret">›<\/span>([\w ·]+)<\/button><div class="qbox"><div class="qrow2[\w ]*"[^>]*><span class="c-dot"><i class="(\w+)"><\/i><\/span><span class="c-ref">([\w:-]+)<\/span>/g,
      ),
    ].map(([, box, state, key]) => `${box}: ${key} ${state}`),
  ).toEqual([
    'running · 1: ticket:FAKE-3 dispatched',
    'waiting · 1: ticket:FAKE-5 queued',
    'parked · 1: ticket:FAKE-6 parked',
    'done · 1: ticket:FAKE-4 done',
  ]);
  expect([...markup.matchAll(/<span class="sf"><i class="d \w+"><\/i>(\w+) /g)].map(([, label]) => label)).toEqual([
    'running',
    'waiting',
    'failed',
    'parked',
    'done',
  ]);
  expect(markup).toContain('<div class="qrow2 done" data-subject="item"');
  expect(markup).toContain(
    '<button class="qrecent-h" data-action="toggle-queue-events" aria-expanded="false"><span class="caret">›</span>recent queue events<span class="n">9</span></button>\n</section>',
  );
  expect(markup).toContain(
    '<span class="nm">beta / ticket-to-pr</span><span class="pill p-pass">watched</span><span class="dt">label sail · polled 5m ago · 0 failed polls</span>',
  );
  expect(markup).toContain(
    '<span class="c-sub">2 attempts · <span class="why">stage_error: implement#1 ended in error: harness: the session ended before it submitted a result</span>',
  );
  expect(markup).not.toContain('sail queue');
  expect(markup).not.toContain('data-action="copy"');
  expect(markup).toContain(
    `<button class="run-link" data-action="select-run" data-repo="beta" data-run="${FAKE_3_ID}" title="open ${FAKE_3_ID}">${FAKE_3_ID} ›</button>`,
  );
  expect(markup).toContain('<span class="c-t">Escape &lt;b&gt;this&lt;/b&gt; &amp; &quot;that&quot;</span>');
  expect(markup).not.toContain('<div class="ev">');
  const opened = renderQueue(panel, { recent: events }, { ...initialUi(0), queueEvents: true }, NOW).value;
  expect(opened).toContain('<button class="qrecent-h open" data-action="toggle-queue-events" aria-expanded="true">');
  expect(opened.match(/<div class="ev">/g)?.length).toBe(9);
  expect(opened).toContain('<span class="ts">11:01:05</span><span class="tname">queue:parked</span>');
});

test('a folded section draws only its heading and count, without its items, while the other sections stay open', () => {
  const [panel] = watchedPanels();
  if (panel === undefined) throw new Error('beta has no queue');
  const ui = { ...initialUi(0), folded: [`${queueId(panel.repo, panel.workflow)}:done`] };
  const markup = renderQueue(panel, undefined, ui, NOW).value;
  expect(markup).toContain(
    '<button class="qsec grp-t" data-action="toggle-queue-section" data-section="beta/ticket-to-pr:done" aria-expanded="false"><span class="caret">›</span>done · 1</button>\n',
  );
  expect(markup).not.toContain('ticket:FAKE-4');
  for (const key of ['ticket:FAKE-3', 'ticket:FAKE-5', 'ticket:FAKE-6'])
    expect(markup).toContain(`<span class="c-ref">${key}</span>`);
  expect(markup.match(/<button class="qsec grp-t open"/g)).toHaveLength(3);
});

test('a failed item whose run ended shows its requeue and drop buttons in its open menu, and a queue with no items says it is empty', () => {
  const [panel] = watchedPanels();
  if (panel === undefined) throw new Error('beta has no queue');
  const failed = panel.items.map((item) => (item.state === 'parked' ? { ...item, state: 'failed' as const } : item));
  const ui = { ...initialUi(0), itemMenu: 'ticket:FAKE-6' };
  const markup = renderQueue(withOffers({ ...panel, items: failed }), undefined, ui, NOW).value;
  expect(markup).toContain('<span class="caret">›</span>failed · 1</button><div class="qbox">');
  expect(markup).toContain('data-action="requeue-item"');
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

test('a held queue shows a held until chip with its reason, and queue:held and queue:released each have a line', () => {
  const [panel] = watchedPanels();
  if (panel === undefined) throw new Error('beta has no queue');
  const held = {
    until: '2026-09-24T14:20:00.000Z',
    runId: 'r',
    reason: 'spec#1 hit the usage limit',
    at: '2026-09-24T11:00:00.000Z',
  };
  const queue = { ...(panel.queue as NonNullable<typeof panel.queue>), held };
  const ui = initialUi(0);
  const markup = renderQueue({ ...panel, queue }, undefined, ui, NOW).value;
  expect(markup).toContain('<span class="warnchip">held until 14:20 — spec#1 hit the usage limit</span>');
  expect(renderQueue({ ...panel, queue }, undefined, initialUi(120), NOW).value).toContain(
    '<span class="warnchip">held until 16:20 — spec#1 hit the usage limit</span>',
  );
  expect(renderQueue(panel, undefined, ui, NOW).value).not.toContain('held until');
  const at = { seq: 20, ts: '2026-09-24T12:00:00.000Z', workflow: QUEUE_WORKFLOW };
  expect(
    queueEventLine({ ...at, type: 'queue:held', until: held.until, run: 'r', reason: held.reason } as QueueEvent),
  ).toBe(`until ${held.until}: spec#1 hit the usage limit`);
  expect(queueEventLine({ ...at, type: 'queue:released' } as QueueEvent)).toBe('dispatch released');
  const moved = { ...at, type: 'queue:moved', dedupKey: 'ticket:FAKE-7', reason: 'moved by hand' };
  expect([
    queueEventLine({ ...moved, before: 'ticket:FAKE-5' } as QueueEvent),
    queueEventLine({ ...moved, after: 'ticket:FAKE-6' } as QueueEvent),
  ]).toEqual([
    'ticket:FAKE-7 moved before ticket:FAKE-5: moved by hand',
    'ticket:FAKE-7 moved after ticket:FAKE-6: moved by hand',
  ]);
});

/** beta's panel with three waiting items, the first urgent and the last moved by hand, and the other states as they are. */
function waiting() {
  const [panel] = watchedPanels();
  const queued = panel?.items.find((item) => item.state === 'queued');
  if (panel === undefined || queued === undefined) throw new Error('beta has no waiting item');
  const copy = (key: string, fields: Record<string, unknown> = {}) => ({
    ...queued,
    priority: undefined,
    waitingOn: undefined,
    dedupKey: `ticket:${key}`,
    ...fields,
  });
  const items = [
    ...panel.items.filter((item) => item.state !== 'queued'),
    copy('FAKE-5', { priority: 'urgent' }),
    copy('FAKE-7'),
    copy('FAKE-8', { moved: true }),
  ];
  return withOffers({ ...panel, items, counts: { ...panel.counts, queued: 3 } });
}

/** The rows of the waiting box, each as its key and the buttons it has. */
function waitingRows(markup: string) {
  return [...markup.matchAll(/<div class="qrow2[^"]*"[^>]*>((?:(?!<\/div>).)*)<\/div>/gs)]
    .filter(([, row]) => row?.includes('data-dir=') || row?.includes('<i class="queued">'))
    .map(([, row]) => ({
      key: /class="c-ref">([^<]+)</.exec(row ?? '')?.[1],
      buttons: [
        ...(row ?? '').matchAll(
          /data-dir="(\w+)" data-repo="beta" data-workflow="ticket-to-pr" data-key="([^"]+)" data-target="([^"]+)"/g,
        ),
      ].map(([, dir, key, target]) => `${dir} ${key} -> ${target}`),
    }));
}

test('a waiting item shows priority <name> unless it is none, and moved once moved by hand', () => {
  const markup = renderQueue(waiting(), undefined, initialUi(0), NOW).value;
  expect(
    [...markup.matchAll(/<span class="c-ref">(ticket:FAKE-[578])<\/span>.*?<span class="c-sub">([^<]*)</gs)].map(
      ([, key, sub]) => `${key}: ${sub}`,
    ),
  ).toEqual([
    'ticket:FAKE-5: 0 attempts · priority urgent',
    'ticket:FAKE-7: 0 attempts',
    'ticket:FAKE-8: 0 attempts · moved',
  ]);
});

test('the first waiting row has a down button only, the last an up button only, a middle one both, and no other state has any', () => {
  const markup = renderQueue(waiting(), undefined, initialUi(0), NOW).value;
  expect(waitingRows(markup).filter((row) => row.buttons.length > 0)).toEqual([
    { key: 'ticket:FAKE-5', buttons: ['down ticket:FAKE-5 -> ticket:FAKE-7'] },
    { key: 'ticket:FAKE-7', buttons: ['up ticket:FAKE-7 -> ticket:FAKE-5', 'down ticket:FAKE-7 -> ticket:FAKE-8'] },
    { key: 'ticket:FAKE-8', buttons: ['up ticket:FAKE-8 -> ticket:FAKE-7'] },
  ]);
  expect(markup.match(/data-action="move-item"/g)).toHaveLength(4);
  expect(markup).toContain('data-action="move-item" data-dir="down"');
  const [panel] = watchedPanels();
  if (panel === undefined) throw new Error('beta has no queue');
  expect(renderQueue(panel, undefined, initialUi(0), NOW).value).not.toContain('move-item');
});

test('while a request for the queue is out its header reads the word under way in place of the watch pill, and its paused and held chips stay', () => {
  const panel = waiting();
  const at = `queue:${panel.repo}/${panel.workflow}`;
  const plain = renderQueue(panel, { recent: [] }, initialUi(0), NOW).value;
  const polling = renderQueue(panel, { recent: [] }, { ...initialUi(0), underway: { [at]: 'polling…' } }, NOW).value;
  expect(plain).toContain('<span class="pill p-pass">watched</span>');
  expect(polling).toContain('<span class="busy">polling…</span>');
  expect(polling).not.toContain('<span class="pill p-pass">watched</span>');
  expect(polling).not.toContain('warnchip">no watcher');
});

test('while a request for an item is out its row reads the word under way in place of its state, and no other row does', () => {
  const panel = waiting();
  const [first, second] = panel.items;
  const markup = renderQueue(
    panel,
    undefined,
    { ...initialUi(0), underway: { [`item:${panel.repo}/${panel.workflow}/${first?.dedupKey}`]: 'requeuing…' } },
    NOW,
  ).value;
  expect(markup.match(/<span class="c-sub"><span class="busy">requeuing…<\/span> · /g)).toHaveLength(1);
  const plain = renderQueue(panel, undefined, initialUi(0), NOW).value;
  expect(plain).not.toContain('busy');
  expect(second?.state).toBeDefined();
});

test("the stream's error is drawn as an escaped code bad div, and none is drawn without one (ADW-209)", () => {
  const panel = waiting();
  const failed = renderQueue(
    panel,
    { recent: [], error: "events.ndjson:2 can't be read: <b>x</b>" },
    initialUi(0),
    NOW,
  ).value;
  const healthy = renderQueue(panel, { recent: [] }, initialUi(0), NOW).value;
  expect(failed).toContain('<div class="code bad">events.ndjson:2 can&#39;t be read: &lt;b&gt;x&lt;/b&gt;</div>');
  expect(healthy).not.toContain('code bad');
});

test("a held item's row shows held until its time and its reason, and its queue:held and queue:released lines name the item", () => {
  const [panel] = watchedPanels();
  if (panel === undefined) throw new Error('beta has no queue');
  const held = {
    until: '2026-09-24T11:01:00.000Z',
    reason: 'publish#1 could not reach a provider',
    at: '2026-09-24T11:00:00.000Z',
  };
  const items = panel.items.map((item) => (item.dedupKey === 'ticket:FAKE-3' ? { ...item, held } : item));
  const markup = renderQueue({ ...panel, items }, undefined, initialUi(0), NOW).value;
  expect(markup).toContain(' · held until 11:01 · <span class="why">publish#1 could not reach a provider</span>');
  expect(renderQueue(panel, undefined, initialUi(0), NOW).value).not.toContain('held until');
  const at = { seq: 20, ts: '2026-09-24T12:00:00.000Z', workflow: QUEUE_WORKFLOW };
  expect(
    queueEventLine({
      ...at,
      type: 'queue:held',
      dedupKey: 'ticket:FAKE-3',
      until: held.until,
      run: 'r',
      reason: held.reason,
    } as QueueEvent),
  ).toBe(`ticket:FAKE-3 until ${held.until}: publish#1 could not reach a provider`);
  expect(queueEventLine({ ...at, type: 'queue:released', dedupKey: 'ticket:FAKE-3' } as QueueEvent)).toBe(
    'ticket:FAKE-3 released',
  );
});

test('an untimed hold shows a held: chip with its reason, and its queue:held a held: line', () => {
  const [panel] = watchedPanels();
  if (panel === undefined) throw new Error('beta has no queue');
  const held = {
    sail: 'print-1',
    runId: 'r',
    reason: 'definitions at abc1234 need a newer sail: pull /work/clone',
    at: '2026-09-24T11:00:00.000Z',
  };
  const queue = { ...(panel.queue as NonNullable<typeof panel.queue>), held };
  const markup = renderQueue({ ...panel, queue }, undefined, initialUi(0), NOW).value;
  expect(markup).toContain(
    '<span class="warnchip">held — definitions at abc1234 need a newer sail: pull /work/clone</span>',
  );
  expect(markup).not.toContain('held until');
  const at = { seq: 20, ts: '2026-09-24T12:00:00.000Z', workflow: QUEUE_WORKFLOW };
  expect(queueEventLine({ ...at, type: 'queue:held', run: 'r', reason: held.reason } as QueueEvent)).toBe(
    `held: ${held.reason}`,
  );
});

test('a waiting item with open prerequisites shows waiting on their keys in its row, and queue:waiting has a line', () => {
  const [panel] = watchedPanels();
  if (panel === undefined) throw new Error('beta has no queue');
  const markup = renderQueue(panel, undefined, initialUi(0), NOW).value;
  expect(markup).toContain(' · waiting on FAKE-1, FAKE-99 (unreadable)');
  expect(markup.split(' · waiting on ')).toHaveLength(2);
  const at = { seq: 21, ts: '2026-09-24T12:00:00.000Z', workflow: QUEUE_WORKFLOW };
  expect(
    queueEventLine({ ...at, type: 'queue:waiting', dedupKey: 'ticket:FAKE-5', on: ['FAKE-1'] } as QueueEvent),
  ).toBe('ticket:FAKE-5 waiting on FAKE-1');
});

/** The queue-changing buttons of each row, as `<key>: <action>[ <label>]`, in row order. */
function controls(markup: string): string[] {
  return [...markup.matchAll(/<div class="qrow2[^"]*"[^>]*>(.*?)<\/div>/gs)].map(([, row]) => {
    const key = /class="c-ref">([^<]+)</.exec(row ?? '')?.[1];
    const buttons = [
      ...(row ?? '').matchAll(/<button class="btn[^"]*" data-action="(requeue-item|drop-item)"[^>]*>([^<]*)</g),
    ];
    return `${key}: ${buttons.map(([, action, label]) => `${action} ${label}`).join(', ')}`;
  });
}

test('each state shows the buttons its open menu is given: queued, parked and done drop; failed requeues only when its run ended; a dispatched item has no ⋯', () => {
  const [panel] = watchedPanels();
  if (panel === undefined) throw new Error('beta has no queue');
  const item = (state: 'failed', key: string) => ({ ...panel.items[0], ...{ state, dedupKey: key } });
  const items = [
    ...panel.items,
    item('failed', 'ticket:FAKE-8'),
    item('failed', 'ticket:FAKE-9'),
  ] as typeof panel.items;
  // FAKE-8's run is still going, FAKE-9's has ended.
  const offered = withOffers({ ...panel, items }, (key) => key !== 'ticket:FAKE-8');
  const opened = (key: string) =>
    controls(renderQueue(offered, undefined, { ...initialUi(0), itemMenu: key }, NOW).value).find((row) =>
      row.startsWith(`${key}:`),
    );
  expect(items.map((each) => opened(each.dedupKey)).sort()).toEqual([
    'ticket:FAKE-3: ',
    'ticket:FAKE-4: drop-item drop',
    'ticket:FAKE-5: drop-item drop',
    'ticket:FAKE-6: requeue-item requeue, drop-item drop',
    'ticket:FAKE-8: drop-item drop',
    'ticket:FAKE-9: requeue-item requeue, drop-item drop',
  ]);
  const closed = renderQueue(offered, undefined, initialUi(0), NOW).value;
  expect(controls(closed).filter((row) => !row.endsWith(': '))).toEqual([]);
  expect([...closed.matchAll(/data-action="item-menu" data-item="([^"]+)"/g)].map(([, key]) => key).sort()).toEqual([
    'ticket:FAKE-4',
    'ticket:FAKE-5',
    'ticket:FAKE-6',
    'ticket:FAKE-8',
    'ticket:FAKE-9',
  ]);
  const markup = renderQueue(offered, undefined, { ...initialUi(0), itemMenu: 'ticket:FAKE-6' }, NOW).value;
  expect(markup).toContain(
    '<span class="qmore"><button class="btn mv more open" data-action="item-menu" data-item="ticket:FAKE-6" aria-label="actions for ticket:FAKE-6" aria-expanded="true" title="actions for ticket:FAKE-6">⋯</button><span class="qmenu">',
  );
  expect(markup).toContain(
    '<button class="btn" data-action="drop-item" data-repo="beta" data-workflow="ticket-to-pr" data-item="ticket:FAKE-6" title="drop ticket:FAKE-6 (⌫)">drop</button>',
  );
  expect(markup).toContain(
    '<button class="btn" data-action="requeue-item" data-repo="beta" data-workflow="ticket-to-pr" data-item="ticket:FAKE-6" title="requeue ticket:FAKE-6 (R)">requeue</button>',
  );
});

test("a row's controls sit after its title column, at its right: the run link, then ▲ ▼, then ⋯ (ADW-464)", () => {
  const [panel] = watchedPanels();
  if (panel === undefined) throw new Error('beta has no queue');
  const markup = renderQueue(panel, undefined, initialUi(0), NOW).value;
  const sides = [...markup.matchAll(/<\/span><\/span><span class="c-side">(.*?)<\/span><\/div>/gs)].map(([, side]) =>
    [...(side ?? '').matchAll(/data-action="([^"]+)"/g)].map(([, action]) => action),
  );
  expect(sides).toEqual([['select-run'], ['item-menu'], ['item-menu'], ['item-menu']]);
});

test('the drop in an open item menu reads drop and is never armed: the dialog confirms it', () => {
  const [panel] = watchedPanels();
  if (panel === undefined) throw new Error('beta has no queue');
  const ui = { ...initialUi(0), itemMenu: 'ticket:FAKE-6' };
  const markup = renderQueue(panel, undefined, ui, NOW).value;
  expect(controls(markup).filter((row) => row.startsWith('ticket:FAKE-6'))).toEqual([
    'ticket:FAKE-6: requeue-item requeue, drop-item drop',
  ]);
  expect(markup).not.toContain('armed');
  expect(markup).not.toContain('confirm drop');
});

test('the header has a poll button for the workflow, and the add form shows only for a workflow that polls tickets (ADW-460)', () => {
  const [panel] = watchedPanels();
  if (panel === undefined) throw new Error('beta has no queue');
  const draw = (polls?: 'ticket' | 'pr') =>
    renderQueue(withOffers(panel), { recent: [], ...(polls === undefined ? {} : { polls }) }, initialUi(0), NOW).value;
  const poll =
    '<button class="btn" data-action="poll-queue" data-repo="beta" data-workflow="ticket-to-pr" title="poll now (P)">poll</button>';
  for (const markup of [draw('ticket'), draw('pr'), draw()]) expect(markup).toContain(poll);
  const form = draw('ticket');
  expect(form).toContain('<input class="txt" type="text" name="add-ticket" placeholder="ticket key"');
  expect(form).toContain('<div class="qadd" data-enter="add-ticket">');
  expect(form).not.toContain('type="checkbox"');
  expect(form).toContain('<button class="btn" data-action="add-ticket" data-repo="beta" data-workflow="ticket-to-pr"');
  expect(form).toContain(
    '<button class="btn" data-action="add-ticket-force" data-repo="beta" data-workflow="ticket-to-pr" title="add the ticket without checking its label or state">add, skipping its checks</button>',
  );
  for (const markup of [draw('pr'), draw()]) {
    expect(markup).not.toContain('add-ticket');
    expect(markup).not.toContain('add-force');
  }
});

test('what was typed in the add field survives a draw, with no force box drawn', () => {
  const [panel] = watchedPanels();
  if (panel === undefined) throw new Error('beta has no queue');
  const ui = { ...initialUi(0), act: { drafts: { 'add-ticket': { ticket: 'FAKE-"9"' } }, results: {} } };
  const markup = renderQueue(panel, { recent: [], polls: 'ticket' }, ui, NOW).value;
  expect(markup).toContain('name="add-ticket" placeholder="ticket key" value="FAKE-&quot;9&quot;"');
  expect(markup).not.toContain('add-force');
});

test('a queue section, the recent events fold and an item ⋯ say whether they are open, and the item buttons are named (ADW-508)', () => {
  const [panel] = watchedPanels();
  if (panel === undefined) throw new Error('beta has no queue');
  const events = queueEvents();
  const draw = (ui = initialUi(0)) => renderQueue(panel, { recent: events }, ui, NOW).value;
  const closed = draw();
  expect(closed).toMatch(/<button class="qsec grp-t open"[^>]*aria-expanded="true"/);
  expect(closed).toMatch(/<button class="qrecent-h"[^>]*aria-expanded="false"/);
  expect(closed).toContain(
    'data-item="ticket:FAKE-6" aria-label="actions for ticket:FAKE-6" aria-expanded="false" title="actions for ticket:FAKE-6">⋯</button>',
  );
  const open = draw({ ...initialUi(0), queueEvents: true, itemMenu: 'ticket:FAKE-6' });
  expect(open).toMatch(/<button class="qrecent-h open"[^>]*aria-expanded="true"/);
  expect(open).toContain('data-item="ticket:FAKE-6" aria-label="actions for ticket:FAKE-6" aria-expanded="true"');
  const moves = renderQueue(waiting(), undefined, initialUi(0), NOW).value;
  const labels = [...moves.matchAll(/data-action="move-item"[^>]*aria-label="([^"]+)" title="([^"]+)"/g)];
  expect(labels.length).toBeGreaterThan(0);
  // The tooltip is the label with the key that moves it: Alt+Up or Alt+Down (ADW-523).
  for (const [, label, title] of labels) expect(title).toBe(`${label} (${label?.startsWith('move up') ? '⌥↑' : '⌥↓'})`);
  expect(labels).toHaveLength(4);
  expect(moves).toContain('aria-label="move up, before ticket:FAKE-5"');
  expect(moves).toContain('aria-label="move down, after ticket:FAKE-7"');
});

const headerOf = (markup: string) => markup.match(/<div class="srcbar"[^>]*>.*?<\/span><\/span><\/div>/s)?.[0] ?? '';
const ON = { enabled: true };

test("a queue's header draws poll and unwatch for a watched workflow, and no watch", () => {
  const header = headerOf(renderQueue(waiting(), { recent: [], polls: 'ticket' }, initialUi(0), NOW).value);
  expect(header).toContain(
    '<button class="btn" data-action="poll-queue" data-repo="beta" data-workflow="ticket-to-pr" title="poll now (P)">poll</button>',
  );
  expect(header).toContain(
    `<button class="btn" data-action="unwatch" data-repo="beta" data-workflow="${QUEUE_WORKFLOW}">unwatch</button>`,
  );
  expect(header).not.toContain('data-action="watch"');
  expect(header).not.toContain('disabled');
});

test("a queue whose workflow is not watched draws watch, no unwatch, and poll disabled with the server's reason", () => {
  const panel = {
    ...waiting(),
    watch: { state: 'not watched' as const, why: WHY },
    offers: { ...(waiting().offers as NonNullable<QueuePanel['offers']>), poll: { enabled: false, why: WHY } },
    repoOffers: { watch: ON, workflows: { [QUEUE_WORKFLOW]: { watch: ON } } },
  };
  const header = headerOf(renderQueue(panel, { recent: [] }, initialUi(0), NOW).value);
  expect(header).toContain(
    '<span class="act"><button class="btn" disabled>poll</button><span class="act-why">no watcher is running &lt;x&gt;</span></span>',
  );
  expect(header).toContain(`data-action="watch" data-repo="beta" data-workflow="${QUEUE_WORKFLOW}">watch</button>`);
  expect(header).not.toContain('unwatch');
});

test('a disabled watch offer is drawn disabled with its reason in the queue header', () => {
  const panel = {
    ...waiting(),
    repoOffers: {
      watch: ON,
      workflows: { [QUEUE_WORKFLOW]: { watch: { enabled: false, why: 'the repository has no clone' } } },
    },
  };
  const header = headerOf(renderQueue(panel, { recent: [] }, initialUi(0), NOW).value);
  expect(header).toContain(
    '<span class="act"><button class="btn" disabled>watch</button><span class="act-why">the repository has no clone</span></span>',
  );
});

test("a queue of a repository that offers nothing draws poll alone, and the word under way takes watch's place", () => {
  const { repoOffers: _, ...panel } = waiting();
  const header = headerOf(renderQueue(panel, { recent: [] }, initialUi(0), NOW).value);
  expect(header).toContain('data-action="poll-queue"');
  expect(header).not.toContain('data-action="watch"');
  expect(header).not.toContain('data-action="unwatch"');
  const underway = { ...initialUi(0), underway: { [`watch:beta/${QUEUE_WORKFLOW}`]: 'unwatching…' } };
  const busy = headerOf(renderQueue(waiting(), { recent: [] }, underway, NOW).value);
  expect(busy).toContain('<span class="busy">unwatching…</span>');
  expect(busy).not.toContain('data-action="unwatch"');
});

const WHY = 'no watcher is running <x>';
const ACTIONS = ['poll-queue', 'add-ticket', 'move-item', 'item-menu', 'requeue-item', 'drop-item'];

test.each([
  ['watcher not running', 'p-skip'],
  ['not watched', 'p-skip'],
] as const)(
  'a workflow in state %s has its pill, a disabled poll with the reason beside it, and no queue control',
  (state) => {
    const panel = {
      ...waiting(),
      watch: { state, why: WHY },
      offers: { ...(waiting().offers as NonNullable<QueuePanel['offers']>), poll: { enabled: false, why: WHY } },
      repoOffers: { watch: ON, workflows: { [QUEUE_WORKFLOW]: { watch: ON } } },
    };
    const ui = { ...initialUi(0), itemMenu: 'ticket:FAKE-6', armedDrop: 'ticket:FAKE-6' };
    const markup = renderQueue(panel, { recent: [], polls: 'ticket' }, ui, NOW).value;
    expect(markup).toContain(`<span class="h held"></span>`);
    expect(markup).toContain(`<span class="pill p-skip">${state}</span>`);
    expect(markup).toContain(
      '<span class="act"><button class="btn" disabled>poll</button><span class="act-why">no watcher is running &lt;x&gt;</span></span>',
    );
    for (const action of ACTIONS) expect(markup).not.toContain(`data-action="${action}"`);
    expect(markup).toContain(
      'name="add-ticket" placeholder="ticket key" value="" disabled title="no watcher is running &lt;x&gt;"',
    );
    expect(markup).toContain('<button class="btn" disabled title="no watcher is running &lt;x&gt;">add</button>');
    expect(markup.match(/<button class="btn mv" disabled /g)).toHaveLength(4);
    expect(markup.match(/<button class="btn mv more" disabled /g)).toHaveLength(5);
    expect(markup).not.toContain('class="qmenu"');
  },
);

test('a watched workflow reads watched, its controls are enabled, and no reason is shown', () => {
  const panel = waiting();
  const markup = renderQueue(
    panel,
    { recent: [], polls: 'ticket' },
    { ...initialUi(0), itemMenu: 'ticket:FAKE-6' },
    NOW,
  ).value;
  expect(markup).toContain('<span class="h"></span>');
  expect(markup).toContain('<span class="pill p-pass">watched</span>');
  for (const action of ACTIONS) expect(markup).toContain(`data-action="${action}"`);
  expect(markup).not.toContain('act-why');
  expect(markup).not.toContain('disabled');
});

const HELD = {
  until: '2026-09-24T14:20:00.000Z',
  runId: 'r',
  reason: 'claude-code hit the usage limit',
  at: '2026-09-24T11:00:00.000Z',
};
const heldPanel = (held: Record<string, unknown>) => {
  const [panel] = watchedPanels();
  if (panel === undefined) throw new Error('beta has no queue');
  return { ...panel, queue: { ...(panel.queue as NonNullable<typeof panel.queue>), held } } as QueuePanel;
};

test('a hold that records a harness key draws a release button for it after the held chip', () => {
  const markup = renderQueue(heldPanel({ ...HELD, harnessKey: 'claude-code' }), undefined, initialUi(0), NOW).value;
  expect(markup).toContain(
    '<span class="warnchip">held until 14:20 — claude-code hit the usage limit</span><button class="btn" data-action="release-hold" data-repo="beta" data-workflow="ticket-to-pr" data-harness="claude-code" title="release the usage-limit hold on claude-code">release</button>',
  );
});

test('a key is escaped in the release button', () => {
  const markup = renderQueue(heldPanel({ ...HELD, harnessKey: '"><b>' }), undefined, initialUi(0), NOW).value;
  expect(markup).toContain('data-harness="&quot;&gt;&lt;b&gt;"');
  expect(markup).not.toContain('<b>');
});

test('a hold with no harness key, timed or not, draws no release button', () => {
  const timed = renderQueue(heldPanel(HELD), undefined, initialUi(0), NOW).value;
  expect(timed).toContain('held until 14:20 —');
  expect(timed).not.toContain('release-hold');
  const { until: _until, ...untimed } = HELD;
  const plain = renderQueue(heldPanel({ ...untimed, sail: 'abc' }), undefined, initialUi(0), NOW).value;
  expect(plain).toContain('held — claude-code hit the usage limit');
  expect(plain).not.toContain('release-hold');
});
