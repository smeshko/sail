// Drawing any action of the registry: an enabled button, an armed one with its confirm label, a disabled one with its
// why, nothing when not offered, and the parameters each kind draws.
import { expect, test } from 'bun:test';
import { ACTIONS, type ActionDef, type OfferSource, type Subject } from '../../../src/dashboard/page/action-registry';
import { actionControl, resultOf } from '../../../src/dashboard/page/action-view';
import type { ActState } from '../../../src/dashboard/page/ui-state';

const RUN: Subject = { kind: 'run', repo: 'alpha', runId: 'R1' };
const NOTHING: OfferSource = { index: [] };
const idle: ActState = { drafts: {}, results: {} };

/** A made-up entry: offered as the source's `state` says, with one text and one number parameter. */
const made = (state: 'on' | 'off' | 'absent'): ActionDef => ({
  id: 'poke',
  label: () => 'poke',
  appliesTo: ['run'],
  tier: 'confirmed',
  place: 'run',
  params: () => [
    { name: 'note', dom: 'note', label: 'note', type: 'text' },
    { name: 'times', dom: 'times', label: 'times', type: 'number', min: 1 },
  ],
  available: () =>
    state === 'absent'
      ? { offered: false }
      : {
          offered: true,
          enabled: state === 'on',
          ...(state === 'off' ? { why: 'not now' } : {}),
        },
  confirm: (_, values) => `confirm poke ${values.note ?? ''}`,
});

test('a made-up entry is drawn enabled, armed, disabled and not at all', () => {
  expect(actionControl(made('on'), RUN, idle, NOTHING).toString()).toBe(
    '<label class="lbl">note <input class="txt" type="text" name="note" value=""></label><label class="lbl">times <input class="num" type="number" name="times" min="1" step="any" value=""></label><button class="btn" data-action="poke">poke</button>',
  );
  const armed: ActState = {
    drafts: { poke: { note: 'a<b', times: '3' } },
    results: {},
    pending: { id: 'poke', subject: RUN, values: {}, sent: false },
  };
  expect(actionControl(made('on'), RUN, armed, NOTHING, { wrap: true }).toString()).toBe(
    '<span class="act"><label class="lbl">note <input class="txt" type="text" name="note" value="a&lt;b"></label><label class="lbl">times <input class="num" type="number" name="times" min="1" step="any" value="3"></label><button class="btn armed" data-action="poke">confirm poke a&lt;b</button></span>',
  );
  expect(actionControl(made('off'), RUN, idle, NOTHING, { honourDisabled: true, wrap: true }).toString()).toBe(
    '<span class="act"><button class="btn" disabled>poke</button><span class="act-why">not now</span></span>',
  );
  expect(actionControl(made('off'), RUN, idle, NOTHING).toString()).toContain(
    '<button class="btn" data-action="poke">poke</button>',
  );
  expect(actionControl(made('absent'), RUN, idle, NOTHING).toString()).toBe('');
});

test('only a pending action that is unsent, this one, on this subject, is armed', () => {
  const pending = (fields: Partial<NonNullable<ActState['pending']>>): ActState => ({
    drafts: {},
    results: {},
    pending: { id: 'poke', subject: RUN, values: {}, sent: false, ...fields },
  });
  const drawn = (act: ActState) => actionControl(made('on'), RUN, act, NOTHING).toString();
  expect(drawn(pending({}))).toContain('class="btn armed"');
  expect(drawn(pending({ sent: true }))).not.toContain('armed');
  expect(drawn(pending({ id: 'other' }))).not.toContain('armed');
  expect(drawn(pending({ subject: { ...RUN, runId: 'R2' } }))).not.toContain('armed');
});

test("a button carries its subject's data, its class and its title when asked", () => {
  const item: Subject = { kind: 'item', repo: 'a"', workflow: 'wf', item: 'ticket:FAKE-5' };
  const drop = ACTIONS.find((each) => each.id === 'drop-item');
  if (drop === undefined) throw new Error('no drop');
  const source: OfferSource = {
    index: [
      {
        name: 'a"',
        runs: [],
        queues: [
          {
            workflow: 'wf',
            offers: {
              poll: { enabled: true },
              add: { enabled: true },
              items: { 'ticket:FAKE-5': { drop: { enabled: true } } },
            },
          },
        ],
      },
    ] as unknown as OfferSource['index'],
  };
  expect(actionControl(drop, item, idle, source, { data: true, title: 'drop ticket:FAKE-5' }).toString()).toBe(
    '<button class="btn" data-action="drop-item" data-repo="a&quot;" data-workflow="wf" data-item="ticket:FAKE-5" title="drop ticket:FAKE-5">drop</button>',
  );
  const armed: ActState = {
    drafts: {},
    results: {},
    pending: { id: 'drop-item', subject: item, values: {}, sent: false },
  };
  expect(actionControl(drop, item, armed, source, { class: 'wf-act' }).toString()).toBe(
    '<button class="wf-act armed" data-action="drop-item">confirm drop</button>',
  );
});

test('a choice is drawn as a select with the draft chosen, else the initial one, and a tick as a checkbox', () => {
  const stop = ACTIONS.find((each) => each.id === 'stop-run');
  const restart = ACTIONS.find((each) => each.id === 'restart-run');
  if (stop === undefined || restart === undefined) throw new Error('missing');
  const source = {
    index: [],
    run: {
      stop: { enabled: true },
      restart: {
        enabled: true,
        stage: 'b',
        stages: [
          { stage: 'a', runsAgain: 'a once' },
          { stage: 'b', runsAgain: 'b once' },
        ],
        budget: {},
      },
    },
  } as unknown as OfferSource;
  expect(actionControl(stop, RUN, idle, source).toString()).toContain(
    '<input type="checkbox" name="now" data-action="stop-now"> stop now</label>',
  );
  expect(actionControl(stop, RUN, { drafts: { 'stop-run': { now: 'on' } }, results: {} }, source).toString()).toContain(
    'name="now" data-action="stop-now" checked>',
  );
  const select = (act: ActState) => actionControl(restart, RUN, act, source).toString();
  expect(select(idle)).toContain(
    '<option value="a" title="a once">a</option><option value="b" title="b once" selected>b</option>',
  );
  expect(select({ drafts: { 'restart-run': { stage: 'a' } }, results: {} })).toContain(
    '<option value="a" title="a once" selected>a</option>',
  );
  expect(select({ drafts: { 'restart-run': { stage: 'zzz' } }, results: {} })).toContain(
    '<option value="b" title="b once" selected>b</option>',
  );
});

test('a parameter the row gives is not drawn', () => {
  const move = ACTIONS.find((each) => each.id === 'move-item');
  if (move === undefined) throw new Error('no move');
  const item: Subject = { kind: 'item', repo: 'a', workflow: 'wf', item: 'k' };
  const source = {
    index: [
      {
        name: 'a',
        runs: [],
        queues: [
          {
            workflow: 'wf',
            offers: { poll: { enabled: true }, add: { enabled: true }, items: { k: { move: { enabled: true } } } },
          },
        ],
      },
    ],
  } as unknown as OfferSource;
  expect(actionControl(move, item, idle, source).toString()).toBe(
    '<button class="btn" data-action="move-item">move</button>',
  );
});

test('resultOf gives the last result only at its place, and for the repository and workflow it names', () => {
  const act: ActState = {
    drafts: {},
    results: {
      queue: {
        id: 'poll-queue',
        subject: { kind: 'item', repo: 'a', workflow: 'wf', item: 'k' },
        text: 'polled',
        place: 'queue',
      },
    },
  };
  expect(resultOf(act, 'queue')).toBe('polled');
  expect(resultOf(act, 'queue', { repo: 'a', workflow: 'wf' })).toBe('polled');
  expect(resultOf(act, 'queue', { repo: 'b' })).toBeUndefined();
  expect(resultOf(act, 'queue', { repo: 'a', workflow: 'other' })).toBeUndefined();
  expect(resultOf(act, 'run')).toBeUndefined();
  expect(resultOf(idle, 'queue')).toBeUndefined();
  expect(
    resultOf(
      { drafts: {}, results: { list: { id: 'x', subject: { kind: 'none' }, text: 't', place: 'list' } } },
      'list',
      {
        repo: 'a',
      },
    ),
  ).toBeUndefined();
});
