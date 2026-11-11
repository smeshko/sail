// The executor of the registry's actions (src/dashboard/page/act.ts): a first click arms a confirmed action and a second
// sends it, an instant action is sent at once, an invalid request arms nothing, the answer is the registry's meaning
// and the shell's effects are performed, with the one state `ui.act`.
import { expect, test } from 'bun:test';
import type { RunActions } from '../../../src/dashboard/actions';
import type { IndexRepo } from '../../../src/dashboard/files';
import { type Actor, createActor, inertActor } from '../../../src/dashboard/page/act';
import type { ActionDef, OfferSource } from '../../../src/dashboard/page/action-registry';
import { ACTIONS } from '../../../src/dashboard/page/action-registry';
import { actionControl, resultOf } from '../../../src/dashboard/page/action-view';
import { initialUi } from '../../../src/dashboard/page/ui-state';

const on = { enabled: true };

interface Rig {
  actor: Actor;
  ui: ReturnType<typeof initialUi>;
  posts: { path: string; body: unknown }[];
  fields: Record<string, string>;
  effects: string[];
  toasts: string[];
  marks: string[][];
  answer(status: number, body: unknown): Promise<void>;
  open: { repo: string; runId: string } | undefined;
  stopped: boolean;
  run: RunActions | undefined;
  registry: ActionDef[];
}

/** An actor over a fake host: each POST waits for `answer()`. */
function rig(run?: RunActions, index: IndexRepo[] = []): Rig {
  const waiting: ((answer: { status: number; body: string }) => void)[] = [];
  const state = {
    ui: initialUi(0),
    posts: [] as Rig['posts'],
    fields: {} as Record<string, string>,
    effects: [] as string[],
    toasts: [] as string[],
    marks: [] as string[][],
    open: { repo: 'alpha', runId: 'R1' } as Rig['open'],
    stopped: false,
    run,
    registry: [...ACTIONS],
  };
  const actor = createActor({
    host: {
      post: (path, body) => {
        state.posts.push({ path, body });
        return new Promise((resolve) => waiting.push(resolve));
      },
      value: (name) => state.fields[name],
    },
    ui: state.ui,
    source: () => ({ run: state.run, index }),
    openRun: () => state.open,
    effects: {
      reopen: (repo, runId, keepMenu) => state.effects.push(`reopen ${repo}/${runId}${keepMenu ? ' keep' : ''}`),
      open: (repo, runId) => state.effects.push(`open ${repo}/${runId}`),
      leave: () => state.effects.push('leave'),
      took: () => state.effects.push('took'),
      toast: (kind, head, text) => state.toasts.push(`${kind} ${head}: ${text}`),
      local: { 'clear-attention': () => state.effects.push('cleared') },
    },
    mark: (...regions) => state.marks.push(regions),
    stopped: () => state.stopped,
    registry: state.registry,
  });
  const rigged = {
    ...state,
    actor,
    answer: async (status: number, body: unknown) => {
      waiting.shift()?.({ status, body: typeof body === 'string' ? body : JSON.stringify(body) });
      await Bun.sleep(0);
    },
  };
  // The fields are shared with the actor's closures, so the rig is the state itself.
  return Object.assign(state, rigged) as Rig;
}

const RESTART = {
  restart: {
    ...on,
    stage: 'tests',
    stages: [
      { stage: 'spec', runsAgain: 's' },
      { stage: 'tests', runsAgain: 't' },
    ],
    budget: { maxUsd: 10 },
  },
  stop: on,
  clean: { ...on, removes: ['a'], archive: '/x' },
  resume: { ...on, spentUsd: 1, budget: { maxUsd: 2 }, raise: 'usd' },
} as unknown as RunActions;

test('a first click on Restart arms it, a second with another stage chosen arms again, and one with the same stage posts it and opens the run the answer names', async () => {
  const r = rig(RESTART);
  r.fields.stage = 'spec';
  r.actor.act('restart-run', {});
  expect([r.posts, r.ui.act.pending]).toEqual([
    [],
    { id: 'restart-run', subject: { kind: 'run', repo: 'alpha', runId: 'R1' }, values: { stage: 'spec' }, sent: false },
  ]);
  r.fields.stage = 'tests';
  r.actor.act('restart-run', {});
  expect([r.posts, r.ui.act.pending?.values, r.ui.act.pending?.sent]).toEqual([[], { stage: 'tests' }, false]);
  r.actor.act('restart-run', {});
  expect(r.posts).toEqual([{ path: '/api/repos/alpha/runs/R1/restart', body: { stage: 'tests' } }]);
  expect([r.ui.act.pending?.sent, r.ui.act.results.run?.text]).toEqual([true, 'restarting R1…']);
  await r.answer(202, { runId: 'NEW' });
  expect([r.effects, r.ui.act.pending, r.ui.act.results.run]).toEqual([['open alpha/NEW'], undefined, undefined]);
});

test('a Resume that needs a raise with none typed says so and stays unarmed, and with a number typed arms and posts the raise and reopens the run', async () => {
  const r = rig(RESTART);
  r.actor.act('resume-run', {});
  expect([r.posts, r.ui.act.pending, r.ui.act.results.run?.text]).toEqual([
    [],
    undefined,
    'give the dollars to raise the budget by: at least 0.01',
  ]);
  r.fields.raise = '5';
  r.actor.act('resume-run', {});
  expect([r.posts, r.ui.act.pending?.sent, r.ui.act.results.run]).toEqual([[], false, undefined]);
  r.actor.act('resume-run', {});
  expect(r.posts).toEqual([{ path: '/api/repos/alpha/runs/R1/resume', body: { raise: { usd: 5 } } }]);
  await r.answer(200, {});
  expect([r.effects, r.ui.act.results.run]).toEqual([['reopen alpha/R1'], undefined]);
});

test('a refused resume shows the refusal and performs no effect', async () => {
  const r = rig({ resume: { ...on, spentUsd: 0, budget: {} } } as unknown as RunActions);
  r.actor.act('resume-run', {});
  r.actor.act('resume-run', {});
  await r.answer(409, { error: 'run is running' });
  expect([r.effects, r.ui.act.results.run?.text, r.ui.act.results.run?.place, r.ui.act.pending]).toEqual([
    [],
    'run is running',
    'run',
    undefined,
  ]);
});

test('Stop now ticked after Stop is armed is what the second click sends, and the answer reopens the run keeping its menu, with its message', async () => {
  const r = rig(RESTART);
  r.actor.act('stop-run', {});
  r.fields.now = 'on';
  r.actor.act('stop-run', {});
  expect(r.posts).toEqual([{ path: '/api/repos/alpha/runs/R1/stop', body: { now: true } }]);
  await r.answer(200, { message: 'stopping R1' });
  expect([r.effects, r.ui.act.results.run]).toEqual([
    ['reopen alpha/R1 keep'],
    { id: 'stop-run', subject: { kind: 'run', repo: 'alpha', runId: 'R1' }, text: 'stopping R1', place: 'run' },
  ]);
});

test('a confirmed Clean leaves the run and puts the answer in the rail, and marks every region it changes', async () => {
  const r = rig(RESTART);
  r.actor.act('clean-run', {});
  r.actor.act('clean-run', {});
  expect(r.posts).toEqual([{ path: '/api/repos/alpha/runs/R1/clean', body: {} }]);
  await r.answer(200, { message: 'cleaned R1' });
  expect([r.effects, r.ui.act.results.rail?.text, r.ui.act.results.rail?.place]).toEqual([
    ['leave'],
    'cleaned R1',
    'rail',
  ]);
  expect(r.marks.flat()).toEqual(expect.arrayContaining(['rail', 'main', 'inspector', 'status']));
});

test('any other action clicked disarms an armed one, and the same one on another run arms afresh', () => {
  const r = rig(RESTART);
  r.actor.act('stop-run', {});
  expect(r.actor.armed('stop-run', {})).toBe(true);
  r.actor.act('clean-run', {});
  expect([r.ui.act.pending?.id, r.actor.armed('stop-run', {}), r.actor.armed('clean-run', {})]).toEqual([
    'clean-run',
    false,
    true,
  ]);
  expect(r.actor.disarm({ id: 'clean-run', subject: { kind: 'run', repo: 'alpha', runId: 'R1' } })).toBe(false);
  expect(r.actor.disarm()).toBe(true);
  expect([r.ui.act.pending, r.actor.disarm()]).toEqual([undefined, false]);
  r.actor.act('stop-run', { repo: 'alpha', run: 'R2' });
  expect(r.ui.act.pending?.subject).toEqual({ kind: 'run', repo: 'alpha', runId: 'R2' });
});

test('a second run action clicked while one is out is ignored, and a disabled offer stops the click before its request', async () => {
  const r = rig(RESTART);
  r.actor.act('stop-run', {});
  r.actor.act('stop-run', {});
  r.actor.act('clean-run', {});
  r.actor.act('clean-run', {});
  expect([r.posts.length, r.ui.act.pending?.id]).toEqual([1, 'stop-run']);
  await r.answer(200, {});
  const off = rig({ stop: { enabled: false, why: 'no' }, clean: undefined } as unknown as RunActions);
  off.actor.act('stop-run', {});
  off.actor.act('stop-run', {});
  expect([off.posts, off.ui.act.pending]).toEqual([[], undefined]);
  const none = rig(undefined);
  none.actor.act('stop-run', {});
  expect(none.ui.act.pending).toBeUndefined();
});

test('an answer for a run no longer open performs no run effect and shows nothing, and one after the page stopped is dropped', async () => {
  const r = rig(RESTART);
  r.actor.act('stop-run', {});
  r.actor.act('stop-run', {});
  r.open = { repo: 'alpha', runId: 'OTHER' };
  await r.answer(200, { message: 'stopped' });
  expect([r.effects, r.ui.act.results.run]).toEqual([[], undefined]);
  const s = rig(RESTART);
  s.actor.act('clean-run', {});
  s.actor.act('clean-run', {});
  s.stopped = true;
  await s.answer(200, {});
  expect([s.effects, s.ui.act.pending?.sent]).toEqual([[], true]);
});

test('no open run and no data means a run action does nothing, and an unknown action is ignored', () => {
  const r = rig(RESTART);
  r.open = undefined;
  r.actor.act('stop-run', {});
  r.actor.act('no-such-action', {});
  expect([r.ui.act.pending, r.posts]).toEqual([undefined, []]);
});

test('forget drops what a run left: its pending action, its notice, its drafts, and the next keep leaves the page fields alone', () => {
  const r = rig(RESTART);
  r.fields = { raise: '3', stage: 'spec', now: 'on' };
  r.actor.keep('run');
  expect(r.ui.act.drafts).toEqual({
    'resume-run': { raise: '3' },
    'restart-run': { stage: 'spec' },
    'stop-run': { now: 'on' },
  });
  r.actor.act('stop-run', {});
  r.ui.act.results.run = { id: 'x', subject: { kind: 'none' }, text: 'n', place: 'run' };
  r.actor.forget('run');
  expect([r.ui.act.pending, r.ui.act.results.run, r.ui.act.drafts]).toEqual([undefined, undefined, {}]);
  r.actor.keep('run');
  expect(r.ui.act.drafts).toEqual({});
  r.actor.keep('run');
  expect(r.ui.act.drafts).toEqual({
    'resume-run': { raise: '3' },
    'restart-run': { stage: 'spec' },
    'stop-run': { now: 'on' },
  });
  r.ui.act.results.rail = { id: 'x', subject: { kind: 'none' }, text: 'rail', place: 'rail' };
  r.actor.clearResult('run');
  expect(r.ui.act.results.rail?.text).toBe('rail');
  r.actor.clearResult('rail');
  expect(r.ui.act.results.rail).toBeUndefined();
});

test('an action added as one entry is drawn, sent and answered', async () => {
  const poke: ActionDef = {
    id: 'poke-run',
    label: () => 'poke',
    appliesTo: ['run'],
    tier: 'instant',
    place: 'run',
    params: () => [{ name: 'note', dom: 'note', label: 'note', type: 'text' }],
    available: () => ({ offered: true, enabled: true }),
    request: (subject, values) =>
      subject.kind === 'run'
        ? { path: `/api/repos/${subject.repo}/runs/${subject.runId}/poke`, body: { note: values.note } }
        : undefined,
    answer: (status, body) => ({ place: 'run', text: `poked: ${status} ${body}` }),
  };
  const r = rig(RESTART);
  r.registry.push(poke);
  const subject = { kind: 'run', repo: 'alpha', runId: 'R1' } as const;
  expect(actionControl(poke, subject, r.ui.act, { index: [] }).toString()).toContain(
    'data-action="poke-run">poke</button>',
  );
  r.fields.note = 'hello';
  r.actor.act('poke-run', {});
  expect(r.posts).toEqual([{ path: '/api/repos/alpha/runs/R1/poke', body: { note: 'hello' } }]);
  await r.answer(200, 'ok');
  expect(r.ui.act.results.run).toEqual({ id: 'poke-run', subject, text: 'poked: 200 ok', place: 'run' });
});

test('a local action performs its effect and posts nothing', () => {
  const r = rig();
  r.actor.act('clear-attention', {});
  expect([r.effects, r.posts]).toEqual([['cleared'], []]);
});

test('an index of no offers is the source an action has none to read', () => {
  const none: OfferSource = { index: [] };
  expect(ACTIONS.find((each) => each.id === 'watch')?.available({ kind: 'repo', repo: 'x' }, none)).toEqual({
    offered: false,
  });
});

const BETA = { repo: 'beta', workflow: 'wf' };
const queueIndex = [
  {
    name: 'beta',
    runs: [],
    queues: [
      {
        workflow: 'wf',
        offers: {
          poll: on,
          add: on,
          items: { 'ticket:FAKE-5': { drop: on, move: on }, 'ticket:FAKE-6': { drop: on, requeue: on } },
        },
      },
    ],
  },
] as unknown as IndexRepo[];

test('a first click on drop arms it, a click elsewhere disarms it, and a second posts the dedup key and shows the answer for the queue', async () => {
  const r = rig(undefined, queueIndex);
  r.actor.act('drop-item', { ...BETA, item: 'ticket:FAKE-5' });
  expect([r.posts, r.actor.armed('drop-item', { ...BETA, item: 'ticket:FAKE-5' })]).toEqual([[], true]);
  expect(r.actor.armed('drop-item', { ...BETA, item: 'ticket:FAKE-6' })).toBe(false);
  r.actor.act('poll-queue', BETA);
  expect([r.ui.act.pending, r.posts]).toEqual([undefined, [{ path: '/api/repos/beta/queues/wf/poll', body: {} }]]);
  await r.answer(202, { waiting: 'the watcher has not taken it' });
  r.actor.act('drop-item', { ...BETA, item: 'ticket:FAKE-5' });
  r.actor.act('drop-item', { ...BETA, item: 'ticket:FAKE-5' });
  expect(r.posts[1]).toEqual({ path: '/api/repos/beta/queues/wf/drop', body: { dedupKey: 'ticket:FAKE-5' } });
  expect(r.ui.underway).toEqual({ 'item:beta/wf/ticket:FAKE-5': 'dropping…' });
  await r.answer(200, { message: 'ticket:FAKE-5 dropped' });
  expect([r.toasts, r.ui.underway, r.effects, r.ui.act.pending]).toEqual([
    ['ok poll beta / wf: the watcher has not taken it', 'ok drop ticket:FAKE-5: ticket:FAKE-5 dropped'],
    {},
    [],
    undefined,
  ]);
});

test('a move posts before for up and after for down, a requeue posts at once, and a 409 shows its error for the queue', async () => {
  const r = rig(undefined, queueIndex);
  r.actor.act('move-item', { ...BETA, key: 'ticket:FAKE-5', dir: 'up', target: 'ticket:FAKE-4' });
  r.actor.act('move-item', { ...BETA, key: 'ticket:FAKE-5', dir: 'down', target: 'ticket:FAKE-7' });
  r.actor.act('requeue-item', { ...BETA, item: 'ticket:FAKE-6' });
  expect(r.posts).toEqual([
    { path: '/api/repos/beta/queues/wf/move', body: { dedupKey: 'ticket:FAKE-5', before: 'ticket:FAKE-4' } },
    { path: '/api/repos/beta/queues/wf/move', body: { dedupKey: 'ticket:FAKE-5', after: 'ticket:FAKE-7' } },
    { path: '/api/repos/beta/queues/wf/requeue', body: { dedupKey: 'ticket:FAKE-6' } },
  ]);
  expect(r.ui.underway).toEqual({
    'item:beta/wf/ticket:FAKE-5': 'moving…',
    'item:beta/wf/ticket:FAKE-6': 'requeuing…',
  });
  await r.answer(409, { error: 'no watcher is running' });
  expect(r.toasts).toEqual(['bad move ticket:FAKE-5: no watcher is running']);
  expect(r.ui.underway).toEqual({ 'item:beta/wf/ticket:FAKE-6': 'requeuing…' });
});

test('an add posts the ticket key, with force when ticked, and one that took empties the ticket field and keeps force ticked', async () => {
  const r = rig(undefined, queueIndex);
  r.actor.act('add-ticket', BETA);
  expect(r.posts).toEqual([]);
  r.fields['add-ticket'] = ' FAKE-9 ';
  r.fields['add-force'] = 'on';
  r.actor.act('add-ticket', BETA);
  expect(r.posts).toEqual([{ path: '/api/repos/beta/queues/wf/add', body: { ticketKey: 'FAKE-9', force: true } }]);
  await r.answer(200, { message: 'queued' });
  expect([r.ui.act.drafts['add-ticket'], r.effects]).toEqual([{ force: 'on' }, ['took']]);
  // The page still holds what was typed: the next keep leaves it alone, the one after reads it.
  r.actor.keep('queue', { kind: 'workflow', ...BETA });
  expect(r.ui.act.drafts['add-ticket']).toEqual({ force: 'on' });
  r.fields['add-ticket'] = 'FAKE-10';
  r.actor.keep('queue', { kind: 'workflow', ...BETA });
  expect(r.ui.act.drafts['add-ticket']).toEqual({ ticket: 'FAKE-10', force: 'on' });
  r.fields['add-force'] = '';
  r.actor.act('add-ticket', BETA);
  expect(r.posts[1]).toEqual({ path: '/api/repos/beta/queues/wf/add', body: { ticketKey: 'FAKE-10' } });
});

test('an add that was only waiting keeps what was typed, since the watcher has not taken it', async () => {
  const r = rig(undefined, queueIndex);
  r.fields['add-ticket'] = 'FAKE-9';
  r.actor.act('add-ticket', BETA);
  await r.answer(202, { waiting: 'not yet' });
  expect([r.ui.act.drafts['add-ticket'], r.effects, r.toasts]).toEqual([
    { ticket: 'FAKE-9' },
    [],
    ['ok add beta / wf: not yet'],
  ]);
});

test('an action the queue does not offer for an item is not carried out', () => {
  const r = rig(undefined, queueIndex);
  r.actor.act('requeue-item', { ...BETA, item: 'ticket:FAKE-5' });
  r.actor.act('drop-item', { ...BETA, item: 'ticket:FAKE-9' });
  r.actor.act('poll-queue', { repo: 'beta', workflow: 'other' });
  expect([r.posts, r.ui.act.pending]).toEqual([[], undefined]);
});

const watchIndex = [
  {
    name: 'beta',
    runs: [],
    queues: [],
    offers: {
      watch: on,
      unwatch: on,
      workflows: { wf: { unwatch: on }, side: { watch: on } },
    },
  },
] as unknown as IndexRepo[];

test('a watch posts the workflow at once and reads watching… until the answer, which is a toast', async () => {
  const r = rig(undefined, watchIndex);
  r.actor.act('watch', { repo: 'beta', workflow: 'side' });
  expect(r.posts).toEqual([{ path: '/api/repos/beta/watch', body: { workflows: ['side'] } }]);
  expect([r.ui.underway, r.ui.act.pending]).toEqual([{ 'watch:beta/side': 'watching…' }, undefined]);
  await r.answer(200, { message: 'sail watch: it watches side' });
  expect([r.toasts, r.ui.underway]).toEqual([['ok watch beta / side: sail watch: it watches side'], {}]);
  r.actor.act('watch', { repo: 'beta' });
  expect(r.posts[1]).toEqual({ path: '/api/repos/beta/watch', body: { workflows: [] } });
  expect(r.ui.underway).toEqual({ 'watch:beta': 'watching…' });
  await r.answer(202, {});
  expect(r.toasts.at(-1)).toBe('ok watch all beta: asked');
});

test('an unwatch arms on a first click, any other action disarms it, and a second click posts it', async () => {
  const r = rig(undefined, watchIndex);
  r.actor.act('unwatch', { repo: 'beta', workflow: 'wf' });
  expect([
    r.posts,
    r.actor.armed('unwatch', { repo: 'beta', workflow: 'wf' }),
    r.actor.armed('unwatch', { repo: 'beta' }),
  ]).toEqual([[], true, false]);
  r.actor.act('watch', { repo: 'beta', workflow: 'side' });
  expect(r.ui.act.pending).toBeUndefined();
  r.actor.act('unwatch', { repo: 'beta' });
  r.actor.act('unwatch', { repo: 'beta' });
  expect(r.posts.at(-1)).toEqual({ path: '/api/repos/beta/unwatch', body: { workflows: [] } });
  await r.answer(200, { message: 'watching side' });
  await r.answer(409, { error: 'sail unwatch: nothing to do' });
  expect(r.toasts).toEqual([
    'ok watch beta / side: watching side',
    'bad unwatch all beta: sail unwatch: nothing to do',
  ]);
});

test('a watch of a workflow the repository does not offer it for is not sent', () => {
  const r = rig(undefined, watchIndex);
  r.actor.act('watch', { repo: 'beta', workflow: 'wf' });
  r.actor.act('unwatch', { repo: 'other' });
  expect(r.posts).toEqual([]);
});

test('each subject keeps its own word under way: a poll answered while a watch is out leaves the watch reading watching…, and a run answer for a run no longer open touches neither', async () => {
  const both = [{ ...queueIndex[0], offers: watchIndex[0]?.offers }] as unknown as IndexRepo[];
  const r = rig(RESTART, both);
  r.actor.act('poll-queue', BETA);
  r.actor.act('watch', { repo: 'beta' });
  await r.answer(200, { message: 'polls wf now' });
  expect([r.ui.underway, r.toasts]).toEqual([{ 'watch:beta': 'watching…' }, ['ok poll beta / wf: polls wf now']]);
  r.actor.act('stop-run', {});
  r.actor.act('stop-run', {});
  await r.answer(200, { message: 'sail watch: it watches all' });
  expect(resultOf(r.ui.act, 'run')).toBe('stopping R1…');
  r.open = { repo: 'alpha', runId: 'OTHER' };
  await r.answer(200, { message: 'stopped' });
  expect([resultOf(r.ui.act, 'run'), r.ui.underway, r.toasts]).toEqual([
    undefined,
    {},
    ['ok poll beta / wf: polls wf now', 'ok watch all beta: sail watch: it watches all'],
  ]);
});

test('a poll, drop, requeue or move that took leaves the add field as typed: only an add that took empties it', async () => {
  const r = rig(undefined, queueIndex);
  r.fields['add-ticket'] = 'FAKE-1';
  r.actor.act('poll-queue', BETA);
  r.actor.act('requeue-item', { ...BETA, item: 'ticket:FAKE-6' });
  r.actor.act('move-item', { ...BETA, key: 'ticket:FAKE-5', dir: 'up', target: 'ticket:FAKE-4' });
  r.actor.act('drop-item', { ...BETA, item: 'ticket:FAKE-5' });
  r.actor.act('drop-item', { ...BETA, item: 'ticket:FAKE-5' });
  for (let each = 0; each < 4; each++) await r.answer(200, { message: 'took' });
  r.fields['add-ticket'] = 'FAKE-12';
  r.actor.keep('queue', { kind: 'workflow', ...BETA });
  expect([r.posts.length, r.effects, r.ui.act.drafts['add-ticket']]).toEqual([4, [], { ticket: 'FAKE-12' }]);
});

test('a run action is ignored until the run action out is answered, though an unwatch armed or the run forgotten took its pending slot', async () => {
  const r = rig(RESTART, watchIndex);
  r.actor.act('clean-run', {});
  r.actor.act('clean-run', {});
  r.actor.act('unwatch', { repo: 'beta' });
  r.actor.disarm();
  r.actor.act('stop-run', {});
  r.actor.act('stop-run', {});
  r.actor.forget('run');
  r.actor.act('stop-run', {});
  r.actor.act('stop-run', {});
  expect(r.posts).toEqual([{ path: '/api/repos/alpha/runs/R1/clean', body: {} }]);
  await r.answer(409, { error: 'no' });
  r.actor.act('stop-run', {});
  r.actor.act('stop-run', {});
  expect(r.posts.at(-1)).toEqual({ path: '/api/repos/alpha/runs/R1/stop', body: { now: false } });
});

test('the inert actor, the store holds until the shell wires the real one, does nothing and finds nothing armed', () => {
  const actor = inertActor();
  expect(actor.act('stop-run', {})).toBeUndefined();
  expect(actor.disarm()).toBe(false);
  expect(actor.armed('stop-run', {})).toBe(false);
  expect(actor.keep('run')).toBeUndefined();
  expect(actor.forget('run')).toBeUndefined();
  expect(actor.clearResult('run')).toBeUndefined();
});
