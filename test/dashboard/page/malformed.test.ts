// What the page does with run files of the wrong shape (D7, review R1-4): nothing it reads is re-validated, so a field
// that is null, a list, or an object whose `toString` isn't a function must be counted or shown as text, never thrown
// on. Each case below threw before; the seeded walk then puts such values at any depth of any recorded event and of a
// call's result.json, and draws every view of every card.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clock } from '../../../src/dashboard/page/format';
import { html } from '../../../src/dashboard/page/html';
import { renderInspector } from '../../../src/dashboard/page/inspector-view';
import { queueEventLine, renderQueues } from '../../../src/dashboard/page/queue-view';
import { applyEvent, emptyRun, foldRun } from '../../../src/dashboard/page/run-model';
import { renderRun, renderStatus } from '../../../src/dashboard/page/run-view';
import { initialUi, TABS } from '../../../src/dashboard/page/ui-state';
import { readEvents } from '../../../src/events/consumers/ndjson';
import type { QueueEvent } from '../../../src/events/types';
import { DASHBOARD_FIXTURES, FAKE_2_ID, FAKE_3_ID, GOLDEN_RUN } from '../../helpers/dashboard';

/** An object no `String()` can turn into text: what `{"toString":0}` parses to. */
const unprintable = () => JSON.parse('{"toString":0,"valueOf":0}') as unknown;
const at = { ts: '2026-09-25T09:00:00.000Z', runId: 'x' };
const runStart = (stages: unknown) => ({
  ...at,
  seq: 1,
  type: 'run:start',
  workflow: { name: 'w', version: 1 },
  roster: { intake: { name: 'ticket', kind: 'builtin' }, stages },
});

test('a roster stage that is null is unreadable and leaves no roster, and one whose kind and model are not text shows as a plain pending stage', () => {
  const nulled = emptyRun();
  expect(() => applyEvent(nulled, runStart({ build: null }))).not.toThrow();
  expect([nulled.unreadable, nulled.roster, nulled.pending]).toEqual([1, undefined, []]);

  const odd = emptyRun();
  applyEvent(odd, runStart({ build: { kind: unprintable(), model: unprintable() } }));
  expect([odd.unreadable, odd.pending]).toEqual([0, [{ stage: 'build', kind: 'stage' }]]);
  expect(() => renderRun(odd, undefined, initialUi(0), 0)).not.toThrow();
  expect(renderRun(odd, undefined, initialUi(0), 0).value).toContain('<span class="c-name">build</span>');
});

test("a route's value that is an object is kept as its JSON, and an interpolated object renders as escaped JSON", () => {
  const model = emptyRun();
  const route = { ...at, seq: 2, type: 'workflow:route', at: 'review', took: 'fix', value: unprintable() };
  expect(() => applyEvent(model, route)).not.toThrow();
  expect(model.routes).toEqual([{ at: 'review', value: '{"toString":0,"valueOf":0}', took: 'fix' }]);
  expect(html`<b>${unprintable() as never}</b>`.value).toBe('<b>{&quot;toString&quot;:0,&quot;valueOf&quot;:0}</b>');
  expect(html`<b>${{ a: '<i>' } as never}</b>`.value).toBe('<b>{&quot;a&quot;:&quot;&lt;i&gt;&quot;}</b>');
});

test("a result.json whose errors hold null and whose consumed and files hold unprintable values draws every tab, and a queue event's unprintable time and type draw too", () => {
  const model = foldRun(readEvents(join(DASHBOARD_FIXTURES, 'alpha', FAKE_2_ID)));
  const card = model.cards.find((entry) => entry.key === 'implement#1');
  const value = { errors: [null, 7], consumed: { b: unprintable() }, files: { a: { name: unprintable(), path: [] } } };
  for (const tab of TABS) {
    const ui = { ...initialUi(0), key: 'implement#1', tab };
    expect(() => renderInspector(card, model.roster, { state: 'loaded', value }, undefined, ui)).not.toThrow();
  }
  const event = { seq: 1, ts: unprintable(), type: unprintable(), workflow: 'w' } as unknown as QueueEvent;
  expect(clock(unprintable() as string, 0)).toBe('—');
  expect(() => queueEventLine(event)).not.toThrow();
  const panel = {
    repo: 'r',
    workflow: 'w',
    items: [],
    counts: { queued: 0, dispatched: 0, failed: 0, parked: 0, done: 0 },
  };
  expect(() => renderQueues([panel], { 'r/w': { recent: [event], watch: 'unknown' } }, initialUi(0), 0)).not.toThrow();
});

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

const HOSTILE = [null, undefined, 7, -1, '', '<b>', [], {}, [null], true, Number.NaN] as const;

/** Sets a random field, at a random depth, of `value` to a hostile value. */
function poison(value: unknown, next: () => number): void {
  let target = value as Record<string, unknown>;
  for (let depth = 0; depth < 4; depth++) {
    const keys = Object.keys(target);
    const key = keys[Math.floor(next() * keys.length)];
    if (key === undefined) break;
    const child = target[key];
    if (typeof child === 'object' && child !== null && next() < 0.6) {
      target = child as Record<string, unknown>;
      continue;
    }
    const pick = Math.floor(next() * (HOSTILE.length + 1));
    target[key] = pick === HOSTILE.length ? unprintable() : HOSTILE[pick];
    return;
  }
}

test('600 seeded poisonings at any depth of the recorded events and result.json never throw in the fold or any view', () => {
  const runs = [GOLDEN_RUN, join(DASHBOARD_FIXTURES, 'alpha', FAKE_2_ID), join(DASHBOARD_FIXTURES, 'beta', FAKE_3_ID)];
  const recorded = runs.map((dir) => {
    const events = readEvents(dir);
    const results = foldRun(events).cards.flatMap((card) =>
      card.resultPath === undefined ? [] : [JSON.parse(readFileSync(join(dir, card.resultPath), 'utf8')) as unknown],
    );
    return { events, results };
  });
  const next = random(7);
  for (let round = 0; round < 600; round++) {
    const { events, results } = recorded[round % recorded.length] ?? { events: [], results: [] };
    const mutated = structuredClone(events) as unknown[];
    const result = structuredClone(results[Math.floor(next() * results.length)]);
    for (let n = 0; n < 3; n++) poison(mutated[Math.floor(next() * mutated.length)], next);
    poison(result, next);
    const draw = () => {
      const model = foldRun(mutated);
      renderRun(model, undefined, initialUi(0), 0);
      renderStatus(model, undefined);
      for (const card of model.cards) {
        for (const tab of TABS) {
          const ui = { ...initialUi(0), key: card.key, tab };
          renderInspector(card, model.roster, { state: 'loaded', value: result }, { state: 'loaded', value: 'x' }, ui);
        }
      }
    };
    expect(draw).not.toThrow();
  }
});
