// Drawing any action of the registry: an enabled button, a disabled one with its
// why, nothing when not offered, and the parameters each kind draws.
import { expect, test } from 'bun:test';
import { ACTIONS, type ActionDef, type OfferSource, type Subject } from '../../../src/dashboard/page/action-registry';
import { actionControl, field, subjectAttrs } from '../../../src/dashboard/page/action-view';
import type { ActState } from '../../../src/dashboard/page/ui-state';

const RUN: Subject = { kind: 'run', repo: 'alpha', runId: 'R1' };
const NOTHING: OfferSource = { index: [] };
const idle: ActState = { drafts: {} };

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
});

test('a made-up entry is drawn enabled with what was typed, disabled and not at all', () => {
  expect(actionControl(made('on'), RUN, idle, NOTHING).toString()).toBe(
    '<label class="lbl">note <input class="txt" type="text" name="note" value=""></label><label class="lbl">times <input class="num" type="number" name="times" min="1" step="any" value=""></label><button class="btn" data-action="poke">poke</button>',
  );
  const typed: ActState = { drafts: { poke: { note: 'a<b', times: '3' } } };
  expect(actionControl(made('on'), RUN, typed, NOTHING, { wrap: true }).toString()).toBe(
    '<span class="act"><label class="lbl">note <input class="txt" type="text" name="note" value="a&lt;b"></label><label class="lbl">times <input class="num" type="number" name="times" min="1" step="any" value="3"></label><button class="btn" data-action="poke">poke</button></span>',
  );
  expect(actionControl(made('off'), RUN, idle, NOTHING, { honourDisabled: true, wrap: true }).toString()).toBe(
    '<span class="act"><button class="btn" disabled>poke</button><span class="act-why">not now</span></span>',
  );
  expect(actionControl(made('off'), RUN, idle, NOTHING).toString()).toContain(
    '<button class="btn" data-action="poke">poke</button>',
  );
  expect(actionControl(made('absent'), RUN, idle, NOTHING).toString()).toBe('');
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
  // A confirmed action's button is never armed: its dialog confirms it.
  expect(actionControl(drop, item, idle, source, { class: 'wf-act' }).toString()).toBe(
    '<button class="wf-act" data-action="drop-item">drop</button>',
  );
});

test('a choice is drawn as a select with the draft chosen, else the initial one, and Stop draws no box', () => {
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
  expect(actionControl(stop, RUN, idle, source).toString()).toBe(
    '<button class="btn" data-action="stop-run">stop</button>',
  );
  const stage = restart.params(RUN, source)[0];
  if (stage === undefined) throw new Error('no stage');
  const select = (act: ActState) => String(field(stage, act.drafts['restart-run'] ?? {}));
  expect(select(idle)).toContain(
    '<option value="a" title="a once">a</option><option value="b" title="b once" selected>b</option>',
  );
  expect(select({ drafts: { 'restart-run': { stage: 'a' } } })).toContain(
    '<option value="a" title="a once" selected>a</option>',
  );
  expect(select({ drafts: { 'restart-run': { stage: 'zzz' } } })).toContain(
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

test('subjectAttrs writes the kind and the data each subject needs, and nothing for none', () => {
  expect(String(subjectAttrs(RUN))).toBe(' data-subject="run" data-repo="alpha" data-run="R1"');
  expect(String(subjectAttrs({ kind: 'item', repo: 'a', workflow: 'w', item: 'ticket:X-1' }))).toBe(
    ' data-subject="item" data-repo="a" data-workflow="w" data-item="ticket:X-1"',
  );
  expect(String(subjectAttrs({ kind: 'workflow', repo: 'a', workflow: 'w' }))).toBe(
    ' data-subject="workflow" data-repo="a" data-workflow="w"',
  );
  expect(String(subjectAttrs({ kind: 'repo', repo: 'a' }))).toBe(' data-subject="repo" data-repo="a"');
  expect(subjectAttrs({ kind: 'none' })).toBe('');
});

test('a parameter asked in the dialog is not drawn beside its button', () => {
  const restart = ACTIONS.find((each) => each.id === 'restart-run');
  const resume = ACTIONS.find((each) => each.id === 'resume-run');
  if (restart === undefined || resume === undefined) throw new Error('missing');
  const source = {
    index: [],
    run: {
      resume: { enabled: true, spentUsd: 1, budget: {}, raise: 'usd' },
      restart: { enabled: true, stage: 'b', stages: [{ stage: 'b', runsAgain: 'b once' }], budget: {} },
    },
  } as unknown as OfferSource;
  expect(actionControl(restart, RUN, idle, source).toString()).toBe(
    '<button class="btn" data-action="restart-run">restart</button>',
  );
  expect(actionControl(resume, RUN, idle, source).toString()).toBe(
    '<button class="btn" data-action="resume-run">resume</button>',
  );
});

test('no action draws a checkbox beside its button: a tick is asked in the dialog alone', () => {
  const on = { enabled: true };
  const source = {
    run: {
      resume: { ...on, spentUsd: 1, budget: {}, raise: 'usd' },
      restart: { ...on, stage: 'b', stages: [{ stage: 'b', runsAgain: 'b once' }], budget: {} },
      stop: on,
      clean: { ...on, removes: [] },
    },
    index: [
      {
        name: 'alpha',
        runs: [],
        watching: { workflows: ['wf'] },
        offers: { watch: on, unwatch: on, workflows: { wf: { watch: on, unwatch: on } } },
        queues: [
          {
            workflow: 'wf',
            offers: { poll: on, add: on, items: { k: { requeue: on, drop: on, move: on } } },
          },
        ],
      },
    ],
  } as unknown as OfferSource;
  const subjects: Subject[] = [
    RUN,
    { kind: 'item', repo: 'alpha', workflow: 'wf', item: 'k' },
    { kind: 'workflow', repo: 'alpha', workflow: 'wf' },
    { kind: 'repo', repo: 'alpha' },
    { kind: 'none' },
  ];
  let drawn = 0;
  for (const def of ACTIONS)
    for (const subject of subjects) {
      if (!def.appliesTo.includes(subject.kind)) continue;
      const out = actionControl(def, subject, idle, source).toString();
      if (out !== '') drawn++;
      expect([def.id, out.includes('type="checkbox"')]).toEqual([def.id, false]);
      for (const param of def.params(subject, source)) {
        expect(['number', 'text', 'choice', 'tick']).toContain(param.type);
        if (param.type === 'tick') expect([def.id, param.ask]).toEqual([def.id, 'dialog']);
      }
    }
  expect(drawn).toBeGreaterThanOrEqual(12);
});
