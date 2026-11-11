// The executor of the registry's actions (src/dashboard/page/act.ts): a first click arms a confirmed action and a second
// sends it, an instant action is sent at once, an invalid request arms nothing, the answer is the registry's meaning
// and the shell's effects are performed, with the one state `ui.act`.
import { expect, test } from 'bun:test';
import type { RunActions } from '../../../src/dashboard/actions';
import type { IndexRepo } from '../../../src/dashboard/files';
import { type Actor, createActor, inertActor } from '../../../src/dashboard/page/act';
import type { ActionDef, OfferSource } from '../../../src/dashboard/page/action-registry';
import { ACTIONS } from '../../../src/dashboard/page/action-registry';
import { actionControl } from '../../../src/dashboard/page/action-view';
import { initialUi } from '../../../src/dashboard/page/ui-state';

const on = { enabled: true };

interface Rig {
  actor: Actor;
  ui: ReturnType<typeof initialUi>;
  posts: { path: string; body: unknown }[];
  fields: Record<string, string>;
  effects: string[];
  toasts: string[];
  undos: (() => void)[];
  dialogs: string[];
  marks: string[][];
  answer(status: number, body: unknown): Promise<void>;
  open: { repo: string; runId: string } | undefined;
  stopped: boolean;
  run: RunActions | undefined;
  /** The offers of runs that are not the open one, by run id, as the shell reads them. */
  others: Record<string, RunActions>;
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
    undos: [] as (() => void)[],
    dialogs: [] as string[],
    marks: [] as string[][],
    open: { repo: 'alpha', runId: 'R1' } as Rig['open'],
    stopped: false,
    run,
    others: {} as Record<string, RunActions>,
    registry: [...ACTIONS],
  };
  const actor = createActor({
    host: {
      post: (path, body) => {
        state.posts.push({ path, body });
        return new Promise((resolve) => waiting.push(resolve));
      },
      value: (name) => state.fields[name],
      openDialog: (html) => state.dialogs.push(html),
      closeDialog: () => state.dialogs.push('closed'),
    },
    ui: state.ui,
    source: (subject) => ({
      run: subject?.kind === 'run' && subject.runId !== state.open?.runId ? state.others[subject.runId] : state.run,
      index,
    }),
    openRun: () => state.open,
    effects: {
      reopen: (repo, runId, keepMenu) => state.effects.push(`reopen ${repo}/${runId}${keepMenu ? ' keep' : ''}`),
      open: (repo, runId) => state.effects.push(`open ${repo}/${runId}`),
      leave: () => state.effects.push('leave'),
      took: () => state.effects.push('took'),
      toast: (kind, head, text, undo) => {
        state.toasts.push(`${kind} ${head}: ${text}${undo === undefined ? '' : ' (undo)'}`);
        if (undo !== undefined) state.undos.push(undo);
      },
      local: {
        'clear-attention': () => {
          state.effects.push('cleared');
          return { text: '3 hidden', undo: () => state.effects.push('uncleared') };
        },
      },
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

const R1 = { kind: 'run', repo: 'alpha', runId: 'R1' } as const;

test('a first click on Restart opens a dialog naming the chosen stage and the budget and posts nothing; confirm posts { stage } and opens the run the answer names', async () => {
  const r = rig(RESTART);
  r.fields.stage = 'spec';
  r.actor.act('restart-run', {});
  expect([r.posts, r.ui.dialog, r.actor.dialogFor()]).toEqual([
    [],
    {
      title: 'restart R1',
      lines: ['runs again: s', 'budget $10.00', 'starts a new run seeded from R1'],
      verb: 'restart',
    },
    R1,
  ]);
  r.actor.confirm();
  expect(r.posts).toEqual([{ path: '/api/repos/alpha/runs/R1/restart', body: { stage: 'spec' } }]);
  expect(r.ui.underway).toEqual({ 'run:alpha/R1': 'restarting…' });
  await r.answer(202, { runId: 'NEW' });
  expect([r.effects, r.ui.underway, r.toasts]).toEqual([['open alpha/NEW'], {}, ['ok restart R1: started NEW']]);
});

test('a Resume that needs a raise with none typed is a red toast and opens no dialog; with 5 typed its dialog reads raises the budget by $5.00, and its confirm posts the raise and reopens the run', async () => {
  const r = rig(RESTART);
  r.actor.act('resume-run', {});
  expect([r.posts, r.ui.dialog, r.dialogs, r.toasts]).toEqual([
    [],
    undefined,
    [],
    ['bad resume R1: give the dollars to raise the budget by: at least 0.01'],
  ]);
  r.fields.raise = '5';
  r.actor.act('resume-run', {});
  expect([r.posts, r.ui.dialog]).toEqual([
    [],
    { title: 'resume R1', lines: ['spent $1.00 of $2.00', 'raises the budget by $5.00'], verb: 'resume' },
  ]);
  r.actor.confirm();
  expect(r.posts).toEqual([{ path: '/api/repos/alpha/runs/R1/resume', body: { raise: { usd: 5 } } }]);
  await r.answer(200, {});
  expect([r.effects, r.toasts.at(-1)]).toEqual([['reopen alpha/R1'], 'ok resume R1: resumed']);
});

test('a resume of minutes says the raise in minutes, and a resume with no raise has only what was spent', () => {
  const minutes = rig({
    resume: { ...on, spentMinutes: 4, budget: { maxMinutes: 10 }, raise: 'minutes' },
  } as unknown as RunActions);
  minutes.fields.raise = '30';
  minutes.actor.act('resume-run', {});
  expect(minutes.ui.dialog?.lines).toEqual(['spent 4 min of 10 min', 'raises the budget by 30 min']);
  const plain = rig({ resume: { ...on, spentUsd: 0.5, budget: {} } } as unknown as RunActions);
  plain.actor.act('resume-run', {});
  expect(plain.ui.dialog?.lines).toEqual(['spent $0.50']);
});

test('a refused resume is a red toast quoting the refusal and performs no effect', async () => {
  const r = rig({ resume: { ...on, spentUsd: 0, budget: {} } } as unknown as RunActions);
  r.actor.act('resume-run', {});
  r.actor.confirm();
  await r.answer(409, { error: 'run is running' });
  expect([r.effects, r.toasts, r.ui.underway]).toEqual([[], ['bad resume R1: run is running'], {}]);
});

test('Stop now ticked is what the dialog reads and its confirm sends, and the answer reopens the run keeping its menu, with its message', async () => {
  const r = rig(RESTART);
  r.actor.act('stop-run', {});
  expect(r.ui.dialog).toEqual({
    title: 'stop R1',
    lines: ['stops at its next call boundary', 'the run fails as stopped'],
    verb: 'stop',
  });
  r.actor.cancel();
  r.fields.now = 'on';
  r.actor.act('stop-run', {});
  expect(r.ui.dialog?.lines).toEqual(['ends its running call now', 'the run fails as stopped']);
  expect(r.posts).toEqual([]);
  r.actor.confirm();
  expect(r.posts).toEqual([{ path: '/api/repos/alpha/runs/R1/stop', body: { now: true } }]);
  expect(r.ui.underway).toEqual({ 'run:alpha/R1': 'stopping…' });
  await r.answer(200, { message: 'stopping R1' });
  expect([r.effects, r.toasts]).toEqual([['reopen alpha/R1 keep'], ['ok stop R1: stopping R1']]);
});

test('a first click on Clean opens a dialog with a removes line per thing and the archive, and its confirm posts once, leaves the run and toasts the message', async () => {
  const r = rig(RESTART);
  r.actor.act('clean-run', {});
  expect([r.posts, r.ui.dialog]).toEqual([
    [],
    { title: 'clean R1', lines: ['removes a', 'run directory → /x'], verb: 'clean' },
  ]);
  r.actor.confirm();
  r.actor.confirm();
  expect(r.posts).toEqual([{ path: '/api/repos/alpha/runs/R1/clean', body: {} }]);
  await r.answer(200, { message: 'cleaned R1' });
  expect([r.effects, r.toasts]).toEqual([['leave'], ['ok clean R1: cleaned R1']]);
  expect(r.marks.flat()).toEqual(expect.arrayContaining(['list', 'sidebar', 'main', 'inspector', 'status']));
});

test('a clean that removes nothing and has no archive says removes nothing', () => {
  const r = rig({ clean: { ...on, removes: [] } } as unknown as RunActions);
  r.actor.act('clean-run', {});
  expect(r.ui.dialog?.lines).toEqual(['removes nothing']);
});

test('the same action on another run opens its own dialog, and a dialog for a run is closed by forget', () => {
  const r = rig(RESTART);
  r.actor.act('stop-run', {});
  r.actor.cancel();
  r.others.R2 = { stop: on } as unknown as RunActions;
  r.actor.act('stop-run', { repo: 'alpha', run: 'R2' });
  expect(r.actor.dialogFor()).toEqual({ kind: 'run', repo: 'alpha', runId: 'R2' });
  r.actor.forget('run');
  expect([r.actor.dialogFor(), r.ui.dialog, r.dialogs.at(-1), r.posts]).toEqual([undefined, undefined, 'closed', []]);
});

test('a second run action clicked while one is out is ignored, and a disabled offer stops the click before its request', async () => {
  const r = rig(RESTART);
  r.actor.act('stop-run', {});
  r.actor.confirm();
  r.actor.act('clean-run', {});
  expect([r.posts.length, r.ui.dialog]).toEqual([1, undefined]);
  await r.answer(200, {});
  r.actor.act('clean-run', {});
  expect(r.ui.dialog?.title).toBe('clean R1');
  const off = rig({ stop: { enabled: false, why: 'no' }, clean: undefined } as unknown as RunActions);
  off.actor.act('stop-run', {});
  expect([off.posts, off.ui.dialog]).toEqual([[], undefined]);
  const none = rig(undefined);
  none.actor.act('stop-run', {});
  expect(none.ui.dialog).toBeUndefined();
});

test('an answer for a run no longer open performs no run effect but still toasts, and one after the page stopped is dropped', async () => {
  const r = rig(RESTART);
  r.actor.act('stop-run', {});
  r.actor.confirm();
  r.open = { repo: 'alpha', runId: 'OTHER' };
  await r.answer(200, { message: 'stopped' });
  expect([r.effects, r.toasts]).toEqual([[], ['ok stop R1: stopped']]);
  const s = rig(RESTART);
  s.actor.act('clean-run', {});
  s.actor.confirm();
  s.stopped = true;
  await s.answer(200, {});
  expect([s.effects, s.toasts]).toEqual([[], []]);
});

test('no open run and no data means a run action does nothing, and an unknown action is ignored', () => {
  const r = rig(RESTART);
  r.open = undefined;
  r.actor.act('stop-run', {});
  r.actor.act('no-such-action', {});
  expect([r.ui.dialog, r.posts]).toEqual([undefined, []]);
});

test('forget drops what a run left: its drafts, and the next keep leaves the page fields alone', () => {
  const r = rig(RESTART);
  r.fields = { raise: '3', stage: 'spec', now: 'on' };
  r.actor.keep('run');
  expect(r.ui.act.drafts).toEqual({
    'resume-run': { raise: '3' },
    'restart-run': { stage: 'spec' },
    'stop-run': { now: 'on' },
  });
  r.actor.forget('run');
  expect(r.ui.act.drafts).toEqual({});
  r.actor.keep('run');
  expect(r.ui.act.drafts).toEqual({});
  r.actor.keep('run');
  expect(r.ui.act.drafts).toEqual({
    'resume-run': { raise: '3' },
    'restart-run': { stage: 'spec' },
    'stop-run': { now: 'on' },
  });
});

test('an action added as one entry is drawn, sent and answered in a toast', async () => {
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
    answer: (status, body) => ({ text: `poked: ${status} ${body}` }),
  };
  const r = rig(RESTART);
  r.registry.push(poke);
  expect(actionControl(poke, R1, r.ui.act, { index: [] }).toString()).toContain('data-action="poke-run">poke</button>');
  r.fields.note = 'hello';
  r.actor.act('poke-run', {});
  expect(r.posts).toEqual([{ path: '/api/repos/alpha/runs/R1/poke', body: { note: 'hello' } }]);
  await r.answer(200, 'ok');
  expect(r.toasts).toEqual(['ok poke R1: poked: 200 ok']);
});

test('a local action performs its effect and posts nothing, and its toast carries the undo the effect gave', () => {
  const r = rig();
  r.actor.act('clear-attention', {});
  expect([r.effects, r.posts, r.toasts]).toEqual([['cleared'], [], ['ok all clear: 3 hidden (undo)']]);
  r.undos[0]?.();
  expect(r.effects).toEqual(['cleared', 'uncleared']);
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

test('a poll clicked while the drop dialog is open leaves it open, and the drop is posted once on confirm, its answer a toast', async () => {
  const r = rig(undefined, queueIndex);
  r.actor.act('drop-item', { ...BETA, item: 'ticket:FAKE-5' });
  r.actor.act('poll-queue', BETA);
  expect([r.posts, r.actor.dialogFor()?.kind]).toEqual([
    [{ path: '/api/repos/beta/queues/wf/poll', body: {} }],
    'item',
  ]);
  await r.answer(202, { waiting: 'the watcher has not taken it' });
  r.actor.confirm();
  expect(r.posts[1]).toEqual({ path: '/api/repos/beta/queues/wf/drop', body: { dedupKey: 'ticket:FAKE-5' } });
  expect(r.ui.underway).toEqual({ 'item:beta/wf/ticket:FAKE-5': 'dropping…' });
  await r.answer(200, { message: 'ticket:FAKE-5 dropped' });
  expect([r.toasts, r.ui.underway, r.effects]).toEqual([
    ['ok poll beta / wf: the watcher has not taken it', 'ok drop ticket:FAKE-5: ticket:FAKE-5 dropped'],
    {},
    [],
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

test('a first click on drop opens a dialog naming the item and posts nothing; confirm posts the dedup key once, and a second confirm does nothing', async () => {
  const r = rig(undefined, queueIndex);
  r.actor.act('drop-item', { ...BETA, item: 'ticket:FAKE-5' });
  expect([r.posts, r.ui.dialog, r.actor.dialogFor()]).toEqual([
    [],
    { title: 'drop ticket:FAKE-5', lines: ["removes ticket:FAKE-5 from beta / wf's queue"], verb: 'drop' },
    { kind: 'item', repo: 'beta', workflow: 'wf', item: 'ticket:FAKE-5' },
  ]);
  expect(r.dialogs).toHaveLength(1);
  r.actor.confirm();
  r.actor.confirm();
  expect([r.posts, r.ui.dialog, r.actor.dialogFor(), r.dialogs.at(-1)]).toEqual([
    [{ path: '/api/repos/beta/queues/wf/drop', body: { dedupKey: 'ticket:FAKE-5' } }],
    undefined,
    undefined,
    'closed',
  ]);
});

test('cancelling the dialog sends nothing and a cancel with none open does nothing', () => {
  const r = rig(undefined, queueIndex);
  r.actor.cancel();
  expect(r.dialogs).toEqual([]);
  r.actor.act('drop-item', { ...BETA, item: 'ticket:FAKE-5' });
  r.actor.cancel();
  r.actor.confirm();
  expect([r.posts, r.ui.dialog, r.dialogs.at(-1)]).toEqual([[], undefined, 'closed']);
});

test('the drop dialog adds the item state and attempts when the index lists the item', () => {
  const listed = structuredClone(queueIndex) as unknown as {
    queues: { queue?: unknown }[];
  }[];
  const [first] = listed;
  if (first?.queues[0] !== undefined)
    first.queues[0].queue = { items: [{ dedupKey: 'ticket:FAKE-6', state: 'parked', attempts: 2 }] };
  const r = rig(undefined, listed as unknown as IndexRepo[]);
  r.actor.act('drop-item', { ...BETA, item: 'ticket:FAKE-6' });
  expect(r.ui.dialog?.lines).toEqual(["removes ticket:FAKE-6 from beta / wf's queue", 'it is parked after 2 attempts']);
});

test('an action the queue does not offer for an item is not carried out', () => {
  const r = rig(undefined, queueIndex);
  r.actor.act('requeue-item', { ...BETA, item: 'ticket:FAKE-5' });
  r.actor.act('drop-item', { ...BETA, item: 'ticket:FAKE-9' });
  r.actor.act('poll-queue', { repo: 'beta', workflow: 'other' });
  expect(r.posts).toEqual([]);
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
  expect(r.ui.underway).toEqual({ 'watch:beta/side': 'watching…' });
  await r.answer(200, { message: 'sail watch: it watches side' });
  expect([r.toasts, r.ui.underway]).toEqual([['ok watch beta / side: sail watch: it watches side'], {}]);
  r.actor.act('watch', { repo: 'beta' });
  expect(r.posts[1]).toEqual({ path: '/api/repos/beta/watch', body: { workflows: [] } });
  expect(r.ui.underway).toEqual({ 'watch:beta': 'watching…' });
  await r.answer(202, {});
  expect(r.toasts.at(-1)).toBe('ok watch all beta: asked');
});

test('an unwatch posts at once, its ok toast carries an undo that posts the watch with the same workflow, and the undo answers in a toast of its own', async () => {
  const r = rig(undefined, watchIndex);
  r.actor.act('unwatch', { repo: 'beta', workflow: 'wf' });
  expect([r.posts, r.ui.dialog, r.ui.underway]).toEqual([
    [{ path: '/api/repos/beta/unwatch', body: { workflows: ['wf'] } }],
    undefined,
    { 'watch:beta/wf': 'unwatching…' },
  ]);
  await r.answer(200, { message: 'sail unwatch: done' });
  expect([r.toasts, r.undos.length]).toEqual([['ok unwatch beta / wf: sail unwatch: done (undo)'], 1]);
  r.undos[0]?.();
  expect(r.posts[1]).toEqual({ path: '/api/repos/beta/watch', body: { workflows: ['wf'] } });
  await r.answer(200, { message: 'sail watch: it watches wf' });
  expect(r.toasts.at(-1)).toBe('ok watch beta / wf: sail watch: it watches wf');
});

test('Unwatch all undoes with the workflows the index listed as watched at the click, whatever the index says by then', async () => {
  const watched = structuredClone(watchIndex) as unknown as { watching?: unknown }[];
  if (watched[0] !== undefined) watched[0].watching = { pid: 7, workflows: ['wf', 'side'] };
  const r = rig(undefined, watched as unknown as IndexRepo[]);
  r.actor.act('unwatch', { repo: 'beta' });
  expect(r.posts).toEqual([{ path: '/api/repos/beta/unwatch', body: { workflows: [] } }]);
  await r.answer(200, { message: 'sail unwatch: all' });
  watched[0] = { ...(watched[0] as object), watching: undefined };
  r.undos[0]?.();
  expect(r.posts[1]).toEqual({ path: '/api/repos/beta/watch', body: { workflows: ['wf', 'side'] } });
});

test('a refused unwatch is a red toast with no undo, and a refused undo is a red toast quoting sail', async () => {
  const r = rig(undefined, watchIndex);
  r.actor.act('unwatch', { repo: 'beta' });
  await r.answer(409, { error: 'sail unwatch: nothing to do' });
  expect([r.toasts, r.undos.length]).toEqual([['bad unwatch all beta: sail unwatch: nothing to do'], 0]);
  r.actor.act('unwatch', { repo: 'beta', workflow: 'wf' });
  await r.answer(200, { message: 'done' });
  r.undos[0]?.();
  await r.answer(409, { error: 'sail watch: no workflow declares a watch' });
  expect(r.toasts.at(-1)).toBe('bad watch beta / wf: sail watch: no workflow declares a watch');
});

test('an undo after the page stopped does nothing more', async () => {
  const r = rig(undefined, watchIndex);
  r.actor.act('unwatch', { repo: 'beta', workflow: 'wf' });
  await r.answer(200, {});
  r.undos[0]?.();
  r.stopped = true;
  await r.answer(200, {});
  expect(r.toasts).toHaveLength(1);
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
  r.actor.confirm();
  await r.answer(200, { message: 'sail watch: it watches all' });
  expect(r.ui.underway).toEqual({ 'run:alpha/R1': 'stopping…' });
  r.open = { repo: 'alpha', runId: 'OTHER' };
  await r.answer(200, { message: 'stopped' });
  expect([r.ui.underway, r.toasts]).toEqual([
    {},
    ['ok poll beta / wf: polls wf now', 'ok watch all beta: sail watch: it watches all', 'ok stop R1: stopped'],
  ]);
});

test('a poll, drop, requeue or move that took leaves the add field as typed: only an add that took empties it', async () => {
  const r = rig(undefined, queueIndex);
  r.fields['add-ticket'] = 'FAKE-1';
  r.actor.act('poll-queue', BETA);
  r.actor.act('requeue-item', { ...BETA, item: 'ticket:FAKE-6' });
  r.actor.act('move-item', { ...BETA, key: 'ticket:FAKE-5', dir: 'up', target: 'ticket:FAKE-4' });
  r.actor.act('drop-item', { ...BETA, item: 'ticket:FAKE-5' });
  r.actor.confirm();
  for (let each = 0; each < 4; each++) await r.answer(200, { message: 'took' });
  r.fields['add-ticket'] = 'FAKE-12';
  r.actor.keep('queue', { kind: 'workflow', ...BETA });
  expect([r.posts.length, r.effects, r.ui.act.drafts['add-ticket']]).toEqual([4, [], { ticket: 'FAKE-12' }]);
});

test('a run action is ignored until the run action out is answered, though the run was forgotten meanwhile', async () => {
  const r = rig(RESTART, watchIndex);
  r.actor.act('clean-run', {});
  r.actor.confirm();
  r.actor.act('unwatch', { repo: 'beta' });
  r.actor.act('stop-run', {});
  r.actor.forget('run');
  r.actor.act('stop-run', {});
  r.actor.confirm();
  expect(r.posts.map((post) => post.path)).toEqual(['/api/repos/alpha/runs/R1/clean', '/api/repos/beta/unwatch']);
  await r.answer(409, { error: 'no' });
  r.actor.act('stop-run', {});
  r.actor.confirm();
  expect(r.posts.at(-1)).toEqual({ path: '/api/repos/alpha/runs/R1/stop', body: { now: false } });
});

test('the inert actor, the store holds until the shell wires the real one, does nothing and has no dialog', () => {
  const actor = inertActor();
  expect(actor.act('stop-run', {})).toBeUndefined();
  expect(actor.keep('run')).toBeUndefined();
  expect(actor.forget('run')).toBeUndefined();
  expect([actor.dialogFor(), actor.confirm(), actor.cancel()]).toEqual([undefined, undefined, undefined]);
});

test('values given with the act are read before the page fields', async () => {
  const r = rig(RESTART);
  r.fields.raise = '9';
  r.actor.act('resume-run', {}, { raise: '2' });
  expect(r.ui.dialog?.lines).toEqual(['spent $1.00 of $2.00', 'raises the budget by $2.00']);
  r.actor.confirm();
  expect(r.posts).toEqual([{ path: '/api/repos/alpha/runs/R1/resume', body: { raise: { usd: 2 } } }]);
});

test('a run that is not open is acted on with its own offers', () => {
  const r = rig(RESTART);
  const other = { repo: 'alpha', run: 'R2' };
  r.actor.act('clean-run', other);
  expect([r.ui.dialog, r.dialogs]).toEqual([undefined, []]);
  r.others.R2 = { clean: { ...on, removes: ['b'], archive: '/y' } } as unknown as RunActions;
  r.actor.act('clean-run', other);
  expect(r.ui.dialog).toEqual({ title: 'clean R2', lines: ['removes b', 'run directory → /y'], verb: 'clean' });
  r.actor.confirm();
  expect(r.posts).toEqual([{ path: '/api/repos/alpha/runs/R2/clean', body: {} }]);
});
