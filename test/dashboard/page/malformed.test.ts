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
import { queueEventLine, renderQueue } from '../../../src/dashboard/page/queue-view';
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

test('a route event with an unprintable value is passed over, and an interpolated object renders as escaped JSON', () => {
  const model = emptyRun();
  const route = { ...at, seq: 2, type: 'workflow:route', at: 'review', took: 'fix', value: unprintable() };
  expect(() => applyEvent(model, route)).not.toThrow();
  expect([model.unreadable, model.other]).toEqual([0, {}]);
  expect('routes' in model).toBe(false);
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
  expect(() => renderQueue(panel, { recent: [event], watch: 'unknown' }, initialUi(0), 0)).not.toThrow();
});

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

const HOSTILE = [null, undefined, 7, -1, '', '<b>', [], {}, [null], true, Number.NaN] as const;

/** Every key in `value`, at any depth. */
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value !== 'object' || value === null) return into;
  for (const [key, child] of Object.entries(value)) {
    if (!Array.isArray(value)) into.add(key);
    keysOf(child, into);
  }
  return into;
}

/**
 * Sets a random field, at a random depth, of `value` to a hostile value. Now and then the field is one `value` lacks,
 * named from `vocabulary`, every key the recorded files use, so an optional field a fixture leaves out is tried too
 * (review R2-4).
 */
function poison(value: unknown, next: () => number, vocabulary: readonly string[] = []): void {
  let target = value as Record<string, unknown>;
  for (let depth = 0; depth < 4; depth++) {
    const keys = Object.keys(target);
    const added = !Array.isArray(target) && vocabulary.length > 0 && next() < 0.3;
    const key = added ? vocabulary[Math.floor(next() * vocabulary.length)] : keys[Math.floor(next() * keys.length)];
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

const ROUNDS = Number(process.env.SAIL_MALFORMED_ROUNDS ?? 600);

test("seeded poisonings at any depth of the recorded events, result.json and a summary's free-form result never throw in the fold or any view", () => {
  const runs = [GOLDEN_RUN, join(DASHBOARD_FIXTURES, 'alpha', FAKE_2_ID), join(DASHBOARD_FIXTURES, 'beta', FAKE_3_ID)];
  const recorded = runs.map((dir) => {
    const events = readEvents(dir);
    const results = foldRun(events).cards.flatMap((card) =>
      card.resultPath === undefined ? [] : [JSON.parse(readFileSync(join(dir, card.resultPath), 'utf8')) as unknown],
    );
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as Record<string, unknown>;
    return { events, results, summary };
  });
  const vocabulary = [...keysOf(recorded)];
  const next = random(7);
  for (let round = 0; round < ROUNDS; round++) {
    const { events, results, summary } = recorded[round % recorded.length] ?? { events: [], results: [], summary: {} };
    const mutated = structuredClone(events) as unknown[];
    const result = structuredClone(results[Math.floor(next() * results.length)]);
    for (let n = 0; n < 3; n++) poison(mutated[Math.floor(next() * mutated.length)], next, vocabulary);
    poison(result, next, vocabulary);
    // A summary the server passes on is schema-valid, but its result is the workflow's own: poison only that.
    const given = { ...summary, result: { pr: { number: 5, url: 'https://x' }, notes: 'n' } };
    poison(given.result, next, vocabulary);
    const draw = () => {
      const model = foldRun(mutated);
      renderRun(model, given as never, initialUi(0), 0);
      renderStatus(model, given as never);
      for (const card of model.cards) {
        for (const tab of TABS) {
          const ui = { ...initialUi(0), key: card.key, tab };
          renderInspector(card, model.roster, { state: 'loaded', value: result }, { state: 'loaded', value: 'x' }, ui);
        }
      }
    };
    expect(draw).not.toThrow();
  }
}, 120_000);

test('a schema-valid summary whose free-form result holds a null or unprintable PR, and a run:start whose budget is unprintable, draw the run view (review R2-1, R2-4)', () => {
  const summary = JSON.parse(readFileSync(join(GOLDEN_RUN, 'summary.json'), 'utf8'));
  const model = foldRun(readEvents(join(DASHBOARD_FIXTURES, 'alpha', FAKE_2_ID)));
  for (const result of [{ pr: null }, { pr: { number: unprintable(), url: 7 } }, { pr: 'x' }, null]) {
    expect(() => renderRun(model, { ...summary, result }, initialUi(0), 0)).not.toThrow();
  }
  const budgeted = emptyRun();
  applyEvent(budgeted, {
    ...runStart({}),
    budget: { maxMinutes: unprintable(), maxUsd: unprintable() },
  });
  expect([budgeted.unreadable, budgeted.budget]).toEqual([0, {}]);
  expect(() => renderRun(budgeted, undefined, initialUi(0), 0)).not.toThrow();
  const fine = emptyRun();
  applyEvent(fine, { ...runStart({}), budget: { maxMinutes: 30, maxUsd: 2, other: 'kept out' } });
  expect(fine.budget).toEqual({ maxMinutes: 30, maxUsd: 2 });
});
