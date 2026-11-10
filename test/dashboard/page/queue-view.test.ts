// The queue panel, drawn: each watched workflow's items by state, its polling, its watch state from the queue's own
// stream, and a parked item's requeue and drop buttons. With no queue anywhere it draws nothing, which hides the panel.
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

test("beta's queue view lists running first, shows its header, its four items each in the box of its state, its recent events folded, FAKE-6's reason with its requeue and drop commands, its polling, and watched", () => {
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
        /<button class="qsec grp-t open" data-action="toggle-queue-section" data-section="beta\/ticket-to-pr:\w+" aria-expanded="true"><span class="caret">›<\/span>([\w ·]+)<\/button><div class="qbox"><div class="qrow2[\w ]*"><span class="c-dot"><i class="(\w+)"><\/i><\/span><span class="c-ref">([\w:-]+)<\/span>/g,
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
  expect(markup).toContain('<div class="qrow2 done">');
  expect(markup).toContain(
    '<button class="qrecent-h" data-action="toggle-queue-events" aria-expanded="false"><span class="caret">›</span>recent queue events<span class="n">9</span></button>\n</section>',
  );
  expect(markup).toContain(
    '<span class="nm">beta / ticket-to-pr</span><span class="pill p-pass">watched</span><span class="dt">label sail · polled 5m ago · 0 failed polls</span>',
  );
  expect(markup).toContain(
    'parked · 2 attempts · <span class="why">stage_error: implement#1 ended in error: harness: the session ended before it submitted a result</span>',
  );
  expect(markup).not.toContain('sail queue');
  expect(markup).not.toContain('data-action="copy"');
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
  expect(opened).toContain('<button class="qrecent-h open" data-action="toggle-queue-events" aria-expanded="true">');
  expect(opened.match(/<div class="ev">/g)?.length).toBe(9);
  expect(opened).toContain('<span class="ts">11:01:05</span><span class="tname">queue:parked</span>');
});

test('a folded section draws only its heading and count, without its items, while the other sections stay open', () => {
  const [panel] = queuePanels(index(m.registryDir));
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
  const [panel] = queuePanels(index(m.registryDir));
  if (panel === undefined) throw new Error('beta has no queue');
  const failed = panel.items.map((item) =>
    item.state === 'parked' ? { ...item, state: 'failed' as const, runEnded: true } : item,
  );
  const ui = { ...initialUi(0), itemMenu: 'ticket:FAKE-6' };
  const markup = renderQueue({ ...panel, items: failed }, undefined, ui, NOW).value;
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
  const [panel] = queuePanels(index(m.registryDir));
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
  expect(markup).toContain('<span class="warnchip">held until 14:20:00: spec#1 hit the usage limit</span>');
  expect(renderQueue({ ...panel, queue }, undefined, initialUi(120), NOW).value).toContain(
    '<span class="warnchip">held until 16:20:00: spec#1 hit the usage limit</span>',
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
  const [panel] = queuePanels(index(m.registryDir));
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
  return { ...panel, items, counts: { ...panel.counts, queued: 3 } };
}

/** The rows of the waiting box, each as its key and the buttons it has. */
function waitingRows(markup: string) {
  return [...markup.matchAll(/<div class="qrow2[^"]*">((?:(?!<\/div>).)*)<\/div>/gs)]
    .filter(([, row]) => row?.includes('data-dir=') || row?.includes('>queued ·'))
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
    'ticket:FAKE-5: queued · 0 attempts · priority urgent',
    'ticket:FAKE-7: queued · 0 attempts',
    'ticket:FAKE-8: queued · 0 attempts · moved',
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
  const [panel] = queuePanels(index(m.registryDir));
  if (panel === undefined) throw new Error('beta has no queue');
  expect(renderQueue(panel, undefined, initialUi(0), NOW).value).not.toContain('move-item');
});

test("the panel's notice is drawn as a warn chip beside its header, and not when there is none", () => {
  const panel = waiting();
  const plain = renderQueue(panel, undefined, initialUi(0), NOW).value;
  const noticed = renderQueue(
    panel,
    undefined,
    { ...initialUi(0), queueNotice: 'no watcher is running <now>' },
    NOW,
  ).value;
  expect(plain).not.toContain('no watcher is running');
  expect(noticed).toContain('<span class="warnchip">no watcher is running &lt;now&gt;</span>');
});

test("the stream's error is drawn as an escaped code bad div, and none is drawn without one (ADW-209)", () => {
  const panel = waiting();
  const failed = renderQueue(
    panel,
    { recent: [], watch: 'unknown', error: "events.ndjson:2 can't be read: <b>x</b>" },
    initialUi(0),
    NOW,
  ).value;
  const healthy = renderQueue(panel, { recent: [], watch: 'unknown' }, initialUi(0), NOW).value;
  expect(failed).toContain('<div class="code bad">events.ndjson:2 can&#39;t be read: &lt;b&gt;x&lt;/b&gt;</div>');
  expect(healthy).not.toContain('code bad');
});

test("a held item's row shows held until its time and its reason, and its queue:held and queue:released lines name the item", () => {
  const [panel] = queuePanels(index(m.registryDir));
  if (panel === undefined) throw new Error('beta has no queue');
  const held = {
    until: '2026-09-24T11:01:00.000Z',
    reason: 'publish#1 could not reach a provider',
    at: '2026-09-24T11:00:00.000Z',
  };
  const items = panel.items.map((item) => (item.dedupKey === 'ticket:FAKE-3' ? { ...item, held } : item));
  const markup = renderQueue({ ...panel, items }, undefined, initialUi(0), NOW).value;
  expect(markup).toContain(' · held until 11:01:00 · <span class="why">publish#1 could not reach a provider</span>');
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
  const [panel] = queuePanels(index(m.registryDir));
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
    '<span class="warnchip">held: definitions at abc1234 need a newer sail: pull /work/clone</span>',
  );
  expect(markup).not.toContain('held until');
  const at = { seq: 20, ts: '2026-09-24T12:00:00.000Z', workflow: QUEUE_WORKFLOW };
  expect(queueEventLine({ ...at, type: 'queue:held', run: 'r', reason: held.reason } as QueueEvent)).toBe(
    `held: ${held.reason}`,
  );
});

test('a waiting item with open prerequisites shows waiting on their keys in its row, and queue:waiting has a line', () => {
  const [panel] = queuePanels(index(m.registryDir));
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
  return [...markup.matchAll(/<div class="qrow2[^"]*">(.*?)<\/div>/gs)].map(([, row]) => {
    const key = /class="c-ref">([^<]+)</.exec(row ?? '')?.[1];
    const buttons = [
      ...(row ?? '').matchAll(/<button class="btn[^"]*" data-action="(requeue-item|drop-item)"[^>]*>([^<]*)</g),
    ];
    return `${key}: ${buttons.map(([, action, label]) => `${action} ${label}`).join(', ')}`;
  });
}

test('each state shows the buttons its open menu is given: queued, parked and done drop; failed requeues only when its run ended; a dispatched item has no ⋯', () => {
  const [panel] = queuePanels(index(m.registryDir));
  if (panel === undefined) throw new Error('beta has no queue');
  const item = (state: 'failed', runEnded: boolean, key: string) => ({
    ...panel.items[0],
    ...{ state, dedupKey: key, runEnded },
  });
  const items = [
    ...panel.items,
    item('failed', false, 'ticket:FAKE-8'),
    item('failed', true, 'ticket:FAKE-9'),
  ] as typeof panel.items;
  const opened = (key: string) =>
    controls(renderQueue({ ...panel, items }, undefined, { ...initialUi(0), itemMenu: key }, NOW).value).find((row) =>
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
  const closed = renderQueue({ ...panel, items }, undefined, initialUi(0), NOW).value;
  expect(controls(closed).filter((row) => !row.endsWith(': '))).toEqual([]);
  expect([...closed.matchAll(/data-action="item-menu" data-item="([^"]+)"/g)].map(([, key]) => key).sort()).toEqual([
    'ticket:FAKE-4',
    'ticket:FAKE-5',
    'ticket:FAKE-6',
    'ticket:FAKE-8',
    'ticket:FAKE-9',
  ]);
  const markup = renderQueue({ ...panel, items }, undefined, { ...initialUi(0), itemMenu: 'ticket:FAKE-6' }, NOW).value;
  expect(markup).toContain(
    '<span class="qmore"><button class="btn mv more open" data-action="item-menu" data-item="ticket:FAKE-6" aria-label="actions for ticket:FAKE-6" aria-expanded="true" title="actions for ticket:FAKE-6">⋯</button><span class="qmenu">',
  );
  expect(markup).toContain(
    '<button class="btn" data-action="drop-item" data-repo="beta" data-workflow="ticket-to-pr" data-item="ticket:FAKE-6" title="drop ticket:FAKE-6">drop</button>',
  );
  expect(markup).toContain(
    '<button class="btn" data-action="requeue-item" data-repo="beta" data-workflow="ticket-to-pr" data-item="ticket:FAKE-6" title="requeue ticket:FAKE-6">requeue</button>',
  );
});

test("a row's controls sit after its title column, at its right: the run link, then ▲ ▼, then ⋯ (ADW-464)", () => {
  const [panel] = queuePanels(index(m.registryDir));
  if (panel === undefined) throw new Error('beta has no queue');
  const markup = renderQueue(panel, undefined, initialUi(0), NOW).value;
  const sides = [...markup.matchAll(/<\/span><\/span><span class="c-side">(.*?)<\/span><\/div>/gs)].map(([, side]) =>
    [...(side ?? '').matchAll(/data-action="([^"]+)"/g)].map(([, action]) => action),
  );
  expect(sides).toEqual([['select-run'], ['item-menu'], ['item-menu'], ['item-menu']]);
});

test('the drop an armed click named reads confirm drop and is armed; the others stay drop', () => {
  const [panel] = queuePanels(index(m.registryDir));
  if (panel === undefined) throw new Error('beta has no queue');
  const ui = { ...initialUi(0), armedDrop: 'ticket:FAKE-6', itemMenu: 'ticket:FAKE-6' };
  const markup = renderQueue(panel, undefined, ui, NOW).value;
  expect(controls(markup).filter((row) => row.includes('confirm'))).toEqual([
    'ticket:FAKE-6: requeue-item requeue, drop-item confirm drop',
  ]);
  expect(markup).toContain('<button class="btn armed" data-action="drop-item"');
  expect(markup.match(/btn armed/g)).toHaveLength(1);
});

test('the header has a poll button for the workflow, and the add form shows only for a workflow that polls tickets (ADW-460)', () => {
  const [panel] = queuePanels(index(m.registryDir));
  if (panel === undefined) throw new Error('beta has no queue');
  const draw = (polls?: 'ticket' | 'pr') =>
    renderQueue(panel, { recent: [], watch: 'watched', ...(polls === undefined ? {} : { polls }) }, initialUi(0), NOW)
      .value;
  const poll =
    '<button class="btn" data-action="poll-queue" data-repo="beta" data-workflow="ticket-to-pr" title="poll now">poll</button>';
  for (const markup of [draw('ticket'), draw('pr'), draw()]) expect(markup).toContain(poll);
  const form = draw('ticket');
  expect(form).toContain('<input class="txt" type="text" name="add-ticket" placeholder="ticket key"');
  expect(form).toContain('<label class="lbl"><input type="checkbox" name="add-force"> force</label>');
  expect(form).toContain('<button class="btn" data-action="add-ticket" data-repo="beta" data-workflow="ticket-to-pr"');
  for (const markup of [draw('pr'), draw()]) {
    expect(markup).not.toContain('add-ticket');
    expect(markup).not.toContain('add-force');
  }
});

test('what was typed in the add field and whether force is ticked survive a draw', () => {
  const [panel] = queuePanels(index(m.registryDir));
  if (panel === undefined) throw new Error('beta has no queue');
  const ui = { ...initialUi(0), addTicket: 'FAKE-"9"', addForce: true };
  const markup = renderQueue(panel, { recent: [], watch: 'watched', polls: 'ticket' }, ui, NOW).value;
  expect(markup).toContain('name="add-ticket" placeholder="ticket key" value="FAKE-&quot;9&quot;"');
  expect(markup).toContain('<input type="checkbox" name="add-force" checked> force');
});

test('a queue section, the recent events fold and an item ⋯ say whether they are open, and the item buttons are named (ADW-508)', () => {
  const [panel] = queuePanels(index(m.registryDir));
  if (panel === undefined) throw new Error('beta has no queue');
  const events = queueEvents();
  const draw = (ui = initialUi(0)) => renderQueue(panel, { recent: events, watch: watchState(events) }, ui, NOW).value;
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
  for (const [, label, title] of labels) expect(label).toBe(title as string);
  expect(labels).toHaveLength(4);
  expect(moves).toContain('aria-label="move up, before ticket:FAKE-5"');
  expect(moves).toContain('aria-label="move down, after ticket:FAKE-7"');
});

test("the queue view's header carries the workflow's watch or unwatch, which reads click again once armed, and none when it is not given (ADW-522)", () => {
  const events = queueEvents();
  const id = queueId('beta', QUEUE_WORKFLOW);
  const panel = queuePanels(index(m.registryDir)).find((each) => queueId(each.repo, each.workflow) === id);
  if (panel === undefined) throw new Error('beta has no queue');
  const stream = { recent: events, watch: watchState(events) };
  const header = (markup: string) => markup.match(/<div class="srcbar">.*?<\/div>/s)?.[0] ?? '';
  expect(header(renderQueue(panel, stream, initialUi(0), NOW).value)).not.toContain('watch-set');
  expect(header(renderQueue(panel, stream, initialUi(0), NOW, 'watch').value)).toContain(
    `title="poll now">poll</button><button class="wf-act" data-action="watch-set" data-repo="beta" data-op="watch" data-workflow="${QUEUE_WORKFLOW}">watch</button></div>`,
  );
  const armed = renderQueue(panel, stream, { ...initialUi(0), armedWatch: id }, NOW, 'unwatch').value;
  expect(header(armed)).toContain(
    `<button class="wf-act armed" data-action="watch-set" data-repo="beta" data-op="unwatch" data-workflow="${QUEUE_WORKFLOW}">unwatch? click again</button>`,
  );
});
