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
  /** The values of the dialog's fields, by name, as a browser holds them while it is open. */
  dialogFields: Record<string, string>;
  /** The markup of each redraw of the open dialog. */
  redraws: string[];
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
    dialogFields: {} as Record<string, string>,
    redraws: [] as string[],
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
      closeDialog: () => {
        state.dialogs.push('closed');
        state.dialogFields = {};
      },
      dialogValue: (name) => state.dialogFields[name],
      redrawDialog: (html) => state.redraws.push(html),
    },
    ui: state.ui,
    source: (subject) => ({
      run: subject?.kind === 'run' && subject.runId !== state.open?.runId ? state.others[subject.runId] : state.run,
      index,
      ...(state.ui.start === undefined ? {} : { start: state.ui.start }),
    }),
    openRun: () => state.open,
    effects: {
      reopen: (repo, runId, keepMenu) => state.effects.push(`reopen ${repo}/${runId}${keepMenu ? ' keep' : ''}`),
      open: (repo, runId) => state.effects.push(`open ${repo}/${runId}`),
      leave: () => state.effects.push('leave'),
      took: () => state.effects.push('took'),
      toast: (kind, head, text, undo, label) => {
        state.toasts.push(`${kind} ${head}: ${text}${undo === undefined ? '' : ` (${label ?? 'undo'})`}`);
        if (undo !== undefined) state.undos.push(undo);
      },
      local: {
        'clear-attention': () => {
          state.effects.push('cleared');
          return { text: '3 hidden', undo: () => state.effects.push('uncleared') };
        },
        'dismiss-attention': (data) => {
          state.effects.push(`dismissed ${data.item}`);
          return { text: `${data.item} hidden`, undo: () => state.effects.push('undismissed') };
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

test("the restart dialog's runs again line follows the stage chosen, and confirm posts that stage", async () => {
  const r = rig(RESTART);
  r.actor.act('restart-run', {});
  expect([r.posts, r.ui.dialog, r.actor.dialogFor()]).toEqual([
    [],
    {
      title: 'restart R1',
      lines: ['runs again: t', 'budget $10.00', 'starts a new run seeded from R1'],
      verb: 'restart',
    },
    R1,
  ]);
  expect(r.dialogs[0]).toContain('<select name="stage" autofocus>');
  expect(r.dialogs[0]).toContain('<option value="tests" title="t" selected>tests</option>');
  r.dialogFields.stage = 'spec';
  r.actor.changed();
  expect(r.ui.dialog?.lines).toEqual(['runs again: s', 'budget $10.00', 'starts a new run seeded from R1']);
  expect(r.redraws).toHaveLength(1);
  expect(r.redraws[0]).toContain('<li>runs again: s</li>');
  expect(r.redraws[0]).toContain('<option value="spec" title="s" selected>spec</option>');
  r.actor.confirm();
  expect(r.posts).toEqual([{ path: '/api/repos/alpha/runs/R1/restart', body: { stage: 'spec' } }]);
  expect(r.ui.underway).toEqual({ 'run:alpha/R1': 'restarting…' });
  await r.answer(202, { runId: 'NEW' });
  expect([r.effects, r.ui.underway, r.toasts]).toEqual([['open alpha/NEW'], {}, ['ok restart R1: started NEW']]);
});

test('the restart dialog draws this stage only and from the base unticked, a change redraws its lines, and confirm posts what is ticked', () => {
  const r = rig(RESTART);
  r.actor.act('restart-run', {});
  expect(r.dialogs[0]).toContain('<input type="checkbox" name="only"> this stage only');
  expect(r.dialogs[0]).toContain('<input type="checkbox" name="base"> from the base');
  expect(r.dialogs[0]).not.toContain('checked');
  r.dialogFields.only = 'on';
  r.dialogFields.base = 'on';
  r.actor.changed();
  expect(r.ui.dialog?.lines).toEqual([
    'runs tests alone, then the new run is suspended',
    "starts from R1's base, without the commits it made",
    'budget $10.00',
    'starts a new run seeded from R1',
  ]);
  expect(r.redraws[0]).toContain('<input type="checkbox" name="only" checked> this stage only');
  r.actor.confirm();
  expect(r.posts).toEqual([
    { path: '/api/repos/alpha/runs/R1/restart', body: { stage: 'tests', continue: false, fromBase: true } },
  ]);
});

test('a restart confirmed without a change posts the offer stage', () => {
  const r = rig(RESTART);
  r.actor.act('restart-run', {});
  r.actor.confirm();
  expect(r.posts).toEqual([{ path: '/api/repos/alpha/runs/R1/restart', body: { stage: 'tests' } }]);
});

test('a stage the command menu has asked is not asked again: the dialog draws no field and confirm posts it', () => {
  const r = rig(RESTART);
  r.actor.act('restart-run', {}, { stage: 'spec' });
  expect(r.ui.dialog?.lines).toEqual(['runs again: s', 'budget $10.00', 'starts a new run seeded from R1']);
  expect(r.dialogs[0]).not.toContain('<select');
  r.actor.confirm();
  expect(r.posts).toEqual([{ path: '/api/repos/alpha/runs/R1/restart', body: { stage: 'spec' } }]);
});

const NEEDS_RAISE = 'give the dollars to raise the budget by: at least 0.01';

test('a Resume that needs a raise asks it in the dialog: none typed keeps the dialog open with the refusal and posts nothing', () => {
  const r = rig(RESTART);
  r.actor.act('resume-run', {});
  expect([r.posts, r.toasts, r.ui.dialog?.lines]).toEqual([[], [], ['spent $1.00 of $2.00']]);
  expect(r.dialogs[0]).toContain(
    '<input class="num" type="number" name="raise" min="0.01" step="any" value="" autofocus>',
  );
  r.actor.confirm();
  expect([r.posts, r.toasts, r.actor.dialogFor()]).toEqual([[], [], R1]);
  expect(r.redraws).toHaveLength(1);
  expect(r.redraws[0]).toContain(`<span class="dlg-bad" role="alert">${NEEDS_RAISE}</span>`);
  r.dialogFields.raise = '0.001';
  r.actor.confirm();
  expect([r.posts, r.toasts, r.actor.dialogFor()]).toEqual([[], [], R1]);
  expect(r.redraws).toHaveLength(2);
  expect(r.redraws[1]).toContain(NEEDS_RAISE);
  expect(r.redraws[1]).toContain('value="0.001"');
});

test('a raise typed in the dialog is read at confirm and posted once', async () => {
  const r = rig(RESTART);
  r.actor.act('resume-run', {});
  r.dialogFields.raise = '5';
  r.actor.changed();
  expect(r.ui.dialog).toEqual({
    title: 'resume R1',
    lines: ['spent $1.00 of $2.00', 'raises the budget by $5.00'],
    verb: 'resume',
  });
  expect(r.redraws).toHaveLength(1);
  expect(r.redraws[0]).toContain('<li>raises the budget by $5.00</li>');
  expect(r.redraws[0]).not.toContain('dlg-bad');
  r.actor.confirm();
  r.actor.confirm();
  expect(r.posts).toEqual([{ path: '/api/repos/alpha/runs/R1/resume', body: { raise: { usd: 5 } } }]);
  await r.answer(200, {});
  expect([r.effects, r.toasts.at(-1)]).toEqual([['reopen alpha/R1'], 'ok resume R1: resumed']);
});

test('a refusal is cleared by the next change, and a value read at confirm counts without one', () => {
  const r = rig(RESTART);
  r.actor.act('resume-run', {});
  r.actor.confirm();
  r.dialogFields.raise = '3';
  r.actor.changed();
  expect(r.redraws.at(-1)).not.toContain('dlg-bad');
  // A change event that was missed: the confirm still reads the field.
  r.dialogFields.raise = '4';
  r.actor.confirm();
  expect(r.posts).toEqual([{ path: '/api/repos/alpha/runs/R1/resume', body: { raise: { usd: 4 } } }]);
});

test('a cancelled dialog keeps nothing typed', () => {
  const r = rig(RESTART);
  r.actor.act('resume-run', {});
  r.dialogFields.raise = '5';
  r.actor.changed();
  r.actor.cancel();
  r.actor.act('resume-run', {});
  expect(r.ui.dialog?.lines).toEqual(['spent $1.00 of $2.00']);
  expect(r.dialogs.at(-1)).toContain('name="raise" min="0.01" step="any" value="" autofocus');
  r.actor.cancel();
  r.actor.act('restart-run', {});
  r.dialogFields.stage = 'spec';
  r.actor.changed();
  r.actor.cancel();
  r.actor.act('restart-run', {});
  expect(r.ui.dialog?.lines[0]).toBe('runs again: t');
  expect(r.ui.act.drafts).toEqual({});
  expect(r.posts).toEqual([]);
});

test('a parameter asked in the dialog is not read into the drafts by keep', () => {
  const r = rig(RESTART);
  r.fields.raise = '5';
  r.fields.stage = 'spec';
  r.actor.keep('run');
  expect(r.ui.act.drafts).toEqual({});
});

test('a change with no dialog open, or one with no asked parameter, redraws nothing', () => {
  const r = rig(RESTART);
  r.actor.changed();
  r.actor.act('clean-run', {});
  r.actor.changed();
  expect(r.redraws).toEqual([]);
});

test('a resume of minutes says the raise in minutes, and a resume with no raise has only what was spent', () => {
  const minutes = rig({
    resume: { ...on, spentMinutes: 4, budget: { maxMinutes: 10 }, raise: 'minutes' },
  } as unknown as RunActions);
  minutes.actor.act('resume-run', {});
  expect(minutes.ui.dialog?.lines).toEqual(['spent 4 min of 10 min']);
  minutes.dialogFields.raise = '30';
  minutes.actor.changed();
  expect(minutes.ui.dialog?.lines).toEqual(['spent 4 min of 10 min', 'raises the budget by 30 min']);
  minutes.actor.confirm();
  expect(minutes.posts).toEqual([{ path: '/api/repos/alpha/runs/R1/resume', body: { raise: { minutes: 30 } } }]);
  const plain = rig({ resume: { ...on, spentUsd: 0.5, budget: {} } } as unknown as RunActions);
  plain.actor.act('resume-run', {});
  expect(plain.ui.dialog?.lines).toEqual(['spent $0.50']);
  expect(plain.dialogs[0]).not.toContain('<input');
});

test('a refused resume is a red toast quoting the refusal and performs no effect', async () => {
  const r = rig({ resume: { ...on, spentUsd: 0, budget: {} } } as unknown as RunActions);
  r.actor.act('resume-run', {});
  r.actor.confirm();
  await r.answer(409, { error: 'run is running' });
  expect([r.effects, r.toasts, r.ui.underway]).toEqual([[], ['bad resume R1: run is running'], {}]);
});

test('Stop posts { now: false } after a dialog that reads stops at its next call boundary', async () => {
  const r = rig(RESTART);
  // A field named now, as an older page drew, changes nothing.
  r.fields.now = 'on';
  r.actor.act('stop-run', {});
  expect(r.ui.dialog).toEqual({
    title: 'stop R1',
    lines: ['stops at its next call boundary', 'the run fails as stopped'],
    verb: 'stop',
  });
  expect(r.posts).toEqual([]);
  r.actor.confirm();
  expect(r.posts).toEqual([{ path: '/api/repos/alpha/runs/R1/stop', body: { now: false } }]);
  expect(r.ui.underway).toEqual({ 'run:alpha/R1': 'stopping…' });
  await r.answer(200, { message: 'stopping R1' });
  expect([r.effects, r.toasts, r.ui.act.drafts]).toEqual([['reopen alpha/R1 keep'], ['ok stop R1: stopping R1'], {}]);
});

test('Stop now posts { now: true } after a dialog that reads ends its running call now', async () => {
  const r = rig(RESTART);
  r.actor.act('stop-run-now', {});
  expect(r.ui.dialog).toEqual({
    title: 'stop R1 now',
    lines: ['ends its running call now', 'the run fails as stopped'],
    verb: 'stop now',
  });
  expect(r.posts).toEqual([]);
  r.actor.confirm();
  expect(r.posts).toEqual([{ path: '/api/repos/alpha/runs/R1/stop', body: { now: true } }]);
  await r.answer(200, { message: 'ending R1' });
  expect([r.effects, r.toasts, r.ui.act.drafts]).toEqual([['reopen alpha/R1 keep'], ['ok stop now R1: ending R1'], {}]);
});

test('the stop actions read the stop offer: neither is carried out for a run that offers none', () => {
  const r = rig({ stop: { enabled: false, why: 'no' } } as unknown as RunActions);
  r.actor.act('stop-run-now', {});
  r.actor.act('stop-run', {});
  expect([r.posts, r.ui.dialog]).toEqual([[], undefined]);
});

test('a first click on Clean opens a dialog with a removes line per thing and the archive, and its confirm posts once, leaves the run and toasts the message', async () => {
  const r = rig(RESTART);
  r.actor.act('clean-run', {});
  expect([r.posts, r.ui.dialog]).toEqual([
    [],
    { title: 'clean R1', lines: ['removes a', 'moves its run directory to /x'], verb: 'clean' },
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
  r.registry.push({
    id: 'poke-run',
    label: () => 'poke',
    appliesTo: ['run'],
    tier: 'instant',
    place: 'run',
    params: () => [{ name: 'note', dom: 'note', label: 'note', type: 'text' }],
    available: () => ({ offered: true, enabled: true }),
    request: () => undefined,
  });
  r.fields = { note: 'hello' };
  r.actor.keep('run');
  expect(r.ui.act.drafts).toEqual({ 'poke-run': { note: 'hello' } });
  r.actor.forget('run');
  expect(r.ui.act.drafts).toEqual({});
  r.actor.keep('run');
  expect(r.ui.act.drafts).toEqual({});
  r.actor.keep('run');
  expect(r.ui.act.drafts).toEqual({ 'poke-run': { note: 'hello' } });
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

test('a local effect receives the data of the click that ran it', () => {
  const r = rig();
  r.actor.act('dismiss-attention', { item: 'the-row' });
  expect([r.effects, r.posts, r.toasts]).toEqual([['dismissed the-row'], [], ['ok dismiss: the-row hidden (undo)']]);
  r.undos[0]?.();
  expect(r.effects).toEqual(['dismissed the-row', 'undismissed']);
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

const ADD = '/api/repos/beta/queues/wf/add';

test('Add ticket posts { ticketKey } at once, whatever a field named force holds, and an empty key posts nothing and opens no dialog', () => {
  const r = rig(undefined, queueIndex);
  r.actor.act('add-ticket', BETA);
  r.fields['add-ticket'] = '   ';
  r.actor.act('add-ticket', BETA);
  expect([r.posts, r.dialogs]).toEqual([[], []]);
  r.fields['add-ticket'] = ' FAKE-9 ';
  r.fields['add-force'] = 'on';
  r.actor.act('add-ticket', BETA);
  expect(r.posts).toEqual([{ path: ADD, body: { ticketKey: 'FAKE-9' } }]);
  expect([r.dialogs, r.ui.dialog]).toEqual([[], undefined]);
});

test('Add ticket, skipping its checks posts { ticketKey, force: true } after its dialog names the checks it skips', async () => {
  const r = rig(undefined, queueIndex);
  r.actor.act('add-ticket-force', BETA);
  r.fields['add-ticket'] = '  ';
  r.actor.act('add-ticket-force', BETA);
  expect([r.posts, r.dialogs, r.ui.dialog]).toEqual([[], [], undefined]);
  r.fields['add-ticket'] = ' FAKE-9 ';
  r.actor.act('add-ticket-force', BETA);
  expect(r.posts).toEqual([]);
  expect(r.ui.dialog).toEqual({
    title: 'add FAKE-9, skipping its checks',
    lines: [
      "adds FAKE-9 to beta / wf's queue",
      'skips its checks: the ticket need not be designated or in a pick-up state',
    ],
    verb: 'add',
  });
  expect(r.actor.dialogFor()).toEqual({ kind: 'workflow', ...BETA });
  r.actor.confirm();
  r.actor.confirm();
  expect(r.posts).toEqual([{ path: ADD, body: { ticketKey: 'FAKE-9', force: true } }]);
  await r.answer(200, { message: 'queued' });
  expect(r.toasts).toEqual(['ok add, skipping its checks beta / wf: queued']);
});

test('a cancelled skipping add sends nothing and keeps the typed key', () => {
  const r = rig(undefined, queueIndex);
  r.fields['add-ticket'] = 'FAKE-9';
  r.actor.act('add-ticket-force', BETA);
  r.actor.cancel();
  expect([r.posts, r.actor.dialogFor(), r.ui.act.drafts]).toEqual([
    [],
    undefined,
    { 'add-ticket': { ticket: 'FAKE-9' } },
  ]);
});

test('a forced add that took empties the ticket field', async () => {
  const r = rig(undefined, queueIndex);
  r.fields['add-ticket'] = 'FAKE-9';
  r.actor.act('add-ticket-force', BETA);
  r.actor.confirm();
  expect(r.ui.act.drafts).toEqual({ 'add-ticket': { ticket: 'FAKE-9' } });
  await r.answer(200, { message: 'queued' });
  expect([r.ui.act.drafts['add-ticket'], r.effects]).toEqual([{}, ['took']]);
  // The page still holds what was typed: the next keep leaves it alone, the one after reads it.
  r.actor.keep('queue', { kind: 'workflow', ...BETA });
  expect(r.ui.act.drafts['add-ticket']).toEqual({});
  r.fields['add-ticket'] = 'FAKE-10';
  r.actor.keep('queue', { kind: 'workflow', ...BETA });
  expect(r.ui.act.drafts['add-ticket']).toEqual({ ticket: 'FAKE-10' });
  expect(JSON.stringify(r.ui.act.drafts)).not.toContain('force');
});

test("the page's state holds no stopNow, addForce, raise or restartStage", () => {
  const keys = Object.keys(initialUi(0));
  for (const gone of ['stopNow', 'addForce', 'raise', 'restartStage']) expect(keys).not.toContain(gone);
});

test('an add that was only waiting keeps what was typed, since the watcher has not taken it', async () => {
  const r = rig(undefined, queueIndex);
  r.fields['add-ticket'] = 'FAKE-9';
  r.actor.act('add-ticket', BETA);
  await r.answer(202, { waiting: 'not yet' });
  expect([r.ui.act.drafts['add-ticket'], r.effects, r.toasts]).toEqual([
    { ticket: 'FAKE-9' },
    [],
    ['ok add a ticket… beta / wf: not yet'],
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
  expect([actor.dialogFor(), actor.dialogAction(), actor.confirm(), actor.cancel()]).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
  expect([actor.actSeveral('clean-run', []), actor.changed()]).toEqual([false, undefined]);
});

const runOf = (runId: string, repo = 'alpha') => ({ kind: 'run', repo, runId }) as const;
const cleanable = (...removes: string[]) =>
  ({ clean: { ...on, removes, archive: `/m/${removes[0] ?? 'x'}` } }) as unknown as RunActions;
const refused = { clean: { enabled: false, why: 'ticket:FAKE-9 names the run' } } as unknown as RunActions;

test("confirming a clean of several posts each run's clean in order, one toast per answer, and a refusal stops no other run", async () => {
  const r = rig(undefined);
  r.open = { repo: 'alpha', runId: 'R2' };
  r.actor.actSeveral('clean-run', [
    { subject: runOf('R1'), offers: cleanable('a') },
    { subject: runOf('R3'), offers: refused },
    { subject: runOf('R2'), offers: cleanable('b') },
    { subject: runOf('R4'), offers: cleanable('c') },
  ]);
  expect(r.posts).toEqual([]);
  expect(r.ui.dialog?.title).toBe('clean 4 runs');
  expect(r.ui.dialog?.lines).toEqual([
    'R1: removes a; run directory → /m/a',
    'skips R3: ticket:FAKE-9 names the run',
    'R2: removes b; run directory → /m/b',
    'R4: removes c; run directory → /m/c',
  ]);
  expect(r.actor.dialogFor()).toEqual({ kind: 'none' });
  r.actor.confirm();
  r.actor.confirm();
  expect(r.posts).toEqual([{ path: '/api/repos/alpha/runs/R1/clean', body: {} }]);
  expect(r.ui.underway['run:alpha/R1']).toBe('cleaning…');
  await r.answer(409, { error: 'ticket:FAKE-1 names it' });
  expect(r.posts.map((p) => p.path)).toEqual(['/api/repos/alpha/runs/R1/clean', '/api/repos/alpha/runs/R2/clean']);
  expect(r.ui.underway).toEqual({ 'run:alpha/R2': 'cleaning…' });
  await r.answer(200, { message: 'cleaned R2' });
  expect(r.effects).toEqual(['leave']);
  await r.answer(200, { message: 'cleaned R4' });
  expect(r.posts.map((p) => p.path)).toEqual([
    '/api/repos/alpha/runs/R1/clean',
    '/api/repos/alpha/runs/R2/clean',
    '/api/repos/alpha/runs/R4/clean',
  ]);
  expect(r.toasts).toEqual([
    'bad clean R1: ticket:FAKE-1 names it',
    'ok clean R2: cleaned R2',
    'ok clean R4: cleaned R4',
  ]);
  expect(r.ui.underway).toEqual({});
});

test('a run cleaned from a selection that is not the open one only toasts', async () => {
  const r = rig(undefined);
  r.actor.actSeveral('clean-run', [{ subject: runOf('R9'), offers: cleanable('a') }]);
  r.actor.confirm();
  await r.answer(200, { message: 'cleaned R9' });
  expect([r.effects, r.toasts]).toEqual([[], ['ok clean R9: cleaned R9']]);
});

test('a selection with no run to clean opens no dialog and toasts the reasons', () => {
  const r = rig(undefined);
  r.actor.actSeveral('clean-run', [
    { subject: runOf('R1'), offers: refused },
    { subject: runOf('R2'), offers: { why: 'run R2 completed' } },
    { subject: runOf('R3'), offers: undefined },
  ]);
  expect([r.posts, r.dialogs, r.actor.dialogFor()]).toEqual([[], [], undefined]);
  expect(r.toasts).toEqual([
    'bad clean 3 runs: R1: ticket:FAKE-9 names the run; R2: run R2 completed; R3: what it offers could not be read',
  ]);
});

test('cancelling the dialog of a clean of several posts nothing, and an unknown action or one with no several form is ignored', () => {
  const r = rig(undefined);
  r.actor.actSeveral('clean-run', [{ subject: runOf('R1'), offers: cleanable('a') }]);
  r.actor.cancel();
  r.actor.confirm();
  expect([r.posts, r.actor.dialogFor()]).toEqual([[], undefined]);
  r.actor.actSeveral('no-such-action', [{ subject: runOf('R1'), offers: cleanable('a') }]);
  r.actor.actSeveral('stop-run', [{ subject: runOf('R1'), offers: cleanable('a') }]);
  expect([r.dialogs.filter((d) => d !== 'closed').length, r.toasts]).toEqual([1, []]);
});

test('a clean of several while a run request is out opens no dialog, toasts why and says it took nothing (review R3)', async () => {
  const r = rig(undefined);
  expect(r.actor.actSeveral('clean-run', [{ subject: runOf('R1'), offers: cleanable('a') }])).toBe(true);
  r.actor.confirm();
  expect(r.posts).toHaveLength(1);
  expect(r.actor.actSeveral('clean-run', [{ subject: runOf('R2'), offers: cleanable('b') }])).toBe(false);
  expect([r.actor.dialogFor(), r.posts.length]).toEqual([undefined, 1]);
  expect(r.toasts).toEqual(['bad clean 1 run: another run action is under way: try again once it is answered']);
  await r.answer(200, { message: 'cleaned R1' });
  expect(r.actor.actSeveral('clean-run', [{ subject: runOf('R2'), offers: cleanable('b') }])).toBe(true);
  expect(r.actor.dialogFor()).toEqual({ kind: 'none' });
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
  expect(r.ui.dialog).toEqual({
    title: 'clean R2',
    lines: ['removes b', 'moves its run directory to /y'],
    verb: 'clean',
  });
  r.actor.confirm();
  expect(r.posts).toEqual([{ path: '/api/repos/alpha/runs/R2/clean', body: {} }]);
});

test('a Restart or Resume of a run that is not open opens the run it started or resumed, and a stop or clean of one leaves the open run', async () => {
  const r = rig(RESTART);
  r.others.R2 = RESTART;
  const other = { repo: 'alpha', run: 'R2' };
  r.actor.act('restart-run', other);
  r.actor.confirm();
  await r.answer(200, { runId: 'R3' });
  r.actor.act('resume-run', other, { raise: '2' });
  r.actor.confirm();
  await r.answer(200, {});
  r.actor.act('stop-run', other);
  r.actor.confirm();
  await r.answer(200, { message: 'stopped' });
  r.actor.act('clean-run', other);
  r.actor.confirm();
  await r.answer(200, {});
  expect(r.effects).toEqual(['open alpha/R3', 'open alpha/R2']);
});

// Start a run (ADW-524): the check, the dialog with the roster, the start that opens the run, and start anyway.
const STARTABLE = [
  {
    name: 'alpha',
    runs: [],
    queues: [],
    offers: {
      watch: { enabled: true },
      workflows: {},
      start: { enabled: true, workflows: ['review', 'ticket-to-pr'], defaultWorkflow: 'ticket-to-pr' },
    },
  },
] as unknown as IndexRepo[];
const ALPHA = { repo: 'alpha' };
const CHECKED = {
  roster: 'ticket-to-pr@1 on FAKE-1: T (Todo)\ndry run: nothing was written',
  key: 'FAKE-1',
  forced: [],
  start: { source: 'FAKE-1', workflow: 'ticket-to-pr', until: 'spec' },
};
const ASKED = { workflow: 'ticket-to-pr', source: 'FAKE-1', until: 'spec' };

test('a start is checked, shown in the dialog with its roster and no toast, and confirmed it posts the start and opens the run it answers with', async () => {
  const r = rig(undefined, STARTABLE);
  r.actor.act('start-run', ALPHA, ASKED);
  expect(r.posts).toEqual([{ path: '/api/repos/alpha/starts/check', body: ASKED }]);
  expect(r.ui.underway['watch:alpha']).toBe('checking…');
  await r.answer(200, CHECKED);
  expect([r.toasts, r.ui.underway['watch:alpha'], r.dialogs.length]).toEqual([[], undefined, 1]);
  const dialog = r.dialogs[0] ?? '';
  expect(dialog).toContain('<h2 id="dialog-title">start a run of ticket-to-pr on FAKE-1</h2>');
  expect(dialog).toContain('<li>stops after spec</li>');
  expect(dialog).toContain(
    '<pre class="dlg-pre">ticket-to-pr@1 on FAKE-1: T (Todo)\ndry run: nothing was written</pre>',
  );
  expect(r.posts).toHaveLength(1);
  r.actor.confirm();
  expect(r.posts.at(-1)).toEqual({
    path: '/api/repos/alpha/starts',
    body: { source: 'FAKE-1', workflow: 'ticket-to-pr', until: 'spec', key: 'FAKE-1' },
  });
  await r.answer(202, { runId: 'FAKE-1-ABC' });
  expect(r.effects).toEqual(['open alpha/FAKE-1-ABC']);
  expect(r.toasts).toEqual(['ok start a run…: started FAKE-1-ABC']);
});

test('a cancelled start dialog starts nothing', async () => {
  const r = rig(undefined, STARTABLE);
  r.actor.act('start-run', ALPHA, ASKED);
  await r.answer(200, CHECKED);
  r.actor.cancel();
  expect([r.posts.length, r.effects]).toEqual([1, []]);
});

test('a check an undesignated ticket fails is a red toast with a start anyway button, remembered so the command can start it, and the confirmed go names what it overrides', async () => {
  const r = rig(undefined, STARTABLE);
  const line = 'sail FAKE-3: the ticket is not designated. --force runs it anyway';
  r.actor.act('start-run', ALPHA, { workflow: 'ticket-to-pr', source: 'FAKE-3', until: '' });
  expect(r.posts.at(-1)?.body).toEqual({ workflow: 'ticket-to-pr', source: 'FAKE-3' });
  await r.answer(409, { error: line, override: 'force', start: { source: 'FAKE-3', workflow: 'ticket-to-pr' } });
  expect(r.toasts).toEqual([`bad start a run… alpha: ${line} (start anyway (--force))`]);
  expect(r.ui.start).toEqual({ repo: 'alpha', source: 'FAKE-3', workflow: 'ticket-to-pr', override: 'force' });
  expect(r.dialogs).toEqual([]);
  r.undos[0]?.();
  expect(r.posts.at(-1)).toEqual({
    path: '/api/repos/alpha/starts/check',
    body: { source: 'FAKE-3', workflow: 'ticket-to-pr', force: true },
  });
  await r.answer(200, {
    roster: 'r\n  forced    designation',
    key: 'FAKE-3',
    forced: ['designation'],
    start: { source: 'FAKE-3', workflow: 'ticket-to-pr', force: true },
  });
  const dialog = r.dialogs[0] ?? '';
  expect(dialog).toContain('<h2 id="dialog-title">start FAKE-3 anyway</h2>');
  expect(dialog).toContain('<li>overrides: designation (--force)</li>');
  r.actor.confirm();
  expect(r.posts.at(-1)).toEqual({
    path: '/api/repos/alpha/starts',
    body: { source: 'FAKE-3', workflow: 'ticket-to-pr', force: true, key: 'FAKE-3' },
  });
  await r.answer(202, { runId: 'FAKE-3-XYZ' });
  expect(r.ui.start).toBeUndefined();
  expect(r.effects).toEqual(['open alpha/FAKE-3-XYZ']);
});

test('a refusal with no override forgets an earlier start anyway and has no button', async () => {
  const r = rig(undefined, STARTABLE);
  r.ui.start = { repo: 'alpha', source: 'FAKE-3', override: 'force' };
  r.actor.act('start-run', ALPHA, { workflow: 'review', source: '#4', until: '' });
  await r.answer(409, { error: "sail #4: a draft. --force doesn't change that", start: { source: '#4' } });
  expect(r.toasts).toEqual(["bad start a run… alpha: sail #4: a draft. --force doesn't change that"]);
  expect(r.ui.start).toBeUndefined();
});

test('an empty source posts nothing and is a red toast in the words of the registry', () => {
  const r = rig(undefined, STARTABLE);
  r.actor.act('start-run', ALPHA, { workflow: 'review', source: '', until: '' });
  expect([r.posts, r.toasts]).toEqual([
    [],
    ['bad start a run… alpha: give a ticket key or a pull request, such as ADW-1 or #12'],
  ]);
});

test('a repository that offers no start, or a disabled one, is not started', () => {
  const none = rig(undefined, [
    { name: 'alpha', runs: [], queues: [], offers: { watch: { enabled: true }, workflows: {} } },
  ] as unknown as IndexRepo[]);
  none.actor.act('start-run', ALPHA, ASKED);
  const off = rig(undefined, [
    {
      name: 'alpha',
      runs: [],
      queues: [],
      offers: { watch: { enabled: true }, workflows: {}, start: { enabled: false, why: 'gone', workflows: [] } },
    },
  ] as unknown as IndexRepo[]);
  off.actor.act('start-run', ALPHA, ASKED);
  expect([none.posts.length, off.posts.length]).toEqual([0, 0]);
});

const NAMED = {
  clean: {
    ...on,
    removes: ['a'],
    archive: '/x',
    item: { workflow: 'wf', dedupKey: 'ticket:FAKE-1', state: 'parked' },
  },
} as unknown as RunActions;

test('a clean whose offer names a queue item asks requeue or drop in its dialog, redraws the line at a change and posts the choice', async () => {
  const r = rig(NAMED);
  r.actor.act('clean-run', {});
  expect(r.ui.dialog?.lines).toEqual([
    'removes a',
    'moves its run directory to /x',
    "requeues ticket:FAKE-1 in wf's queue",
  ]);
  expect(r.dialogs[0]).toContain('<select name="clean-item" autofocus>');
  expect(r.dialogs[0]).toContain('<option value="requeue" selected>requeue</option>');
  expect(r.dialogs[0]).toContain('<option value="drop">drop</option>');
  r.dialogFields['clean-item'] = 'drop';
  r.actor.changed();
  expect(r.ui.dialog?.lines.at(-1)).toBe(
    "drops ticket:FAKE-1 from wf's queue and takes the watcher's label off its ticket",
  );
  r.actor.confirm();
  expect(r.posts).toEqual([{ path: '/api/repos/alpha/runs/R1/clean', body: { item: 'drop' } }]);
  await r.answer(200, { message: 'cleaned R1', problems: ['R1: queue item still names it'] });
  expect([r.effects, r.toasts]).toEqual([['leave'], ['bad clean R1: cleaned R1\nR1: queue item still names it']]);
});

test('cancelling the clean dialog of a run a queue item names posts nothing', () => {
  const r = rig(NAMED);
  r.actor.act('clean-run', {});
  r.actor.cancel();
  expect(r.posts).toEqual([]);
});

const failedRepos = (withItem: boolean): IndexRepo[] =>
  [
    {
      name: 'alpha',
      runs: [],
      queues: [],
      offers: {
        watch: on,
        workflows: {},
        clean: {
          ...on,
          runs: [
            { runId: 'R1' },
            { runId: 'R2', ...(withItem ? { item: { workflow: 'wf', dedupKey: 'ticket:R2', state: 'parked' } } : {}) },
          ],
        },
      },
    },
    {
      name: 'beta',
      runs: [],
      queues: [],
      offers: { watch: on, workflows: {}, clean: { ...on, runs: [{ runId: 'B1' }] } },
    },
  ] as unknown as IndexRepo[];

test('clean all failed opens one dialog with no field when no listed run has a queue item, posts the listed runs and gives the answer as one toast', async () => {
  const r = rig(undefined, failedRepos(false));
  r.actor.act('clean-failed', {});
  expect(r.ui.dialog).toEqual({
    title: 'clean every failed run',
    lines: ['cleans 3 failed runs', 'alpha: R1', 'alpha: R2', 'beta: B1'],
    verb: 'clean',
  });
  expect(r.dialogs[0]).not.toContain('<select');
  r.actor.confirm();
  expect(r.posts).toEqual([
    {
      path: '/api/clean-failed',
      body: {
        runs: [
          { repo: 'alpha', runId: 'R1' },
          { repo: 'alpha', runId: 'R2' },
          { repo: 'beta', runId: 'B1' },
        ],
        items: 'skip',
      },
    },
  ]);
  expect(r.ui.underway).toEqual({ 'clean:*': 'cleaning…' });
  await r.answer(200, { message: 'cleaned 3 of 3 failed runs\nalpha: cleaned R1', left: 0, failed: 0, runs: [] });
  expect([r.toasts, r.ui.underway]).toEqual([
    ['ok clean all failed: cleaned 3 of 3 failed runs\nalpha: cleaned R1'],
    {},
  ]);
});

test('clean all failed for a repository asks skip, requeue or drop when a run has a queue item, redraws at a change and posts the choice', () => {
  const r = rig(undefined, failedRepos(true));
  r.actor.act('clean-failed', { repo: 'alpha' });
  expect(r.ui.dialog?.title).toBe('clean all failed runs of alpha');
  expect(r.dialogs[0]).toContain('<select name="clean-items" autofocus>');
  expect(r.dialogs[0]).toContain('<option value="skip" selected>skip</option>');
  expect(r.ui.dialog?.lines).toEqual([
    'cleans 1 failed run',
    'leaves 1 a queue item names',
    'R1',
    'R2 · queue item ticket:R2 of wf: skipped',
  ]);
  r.dialogFields['clean-items'] = 'requeue';
  r.actor.changed();
  expect(r.ui.dialog?.lines).toEqual(['cleans 2 failed runs', 'R1', 'R2 · queue item ticket:R2 of wf: requeued']);
  expect(r.redraws[0]).toContain('<li>cleans 2 failed runs</li>');
  r.actor.confirm();
  expect(r.posts).toEqual([
    {
      path: '/api/repos/alpha/clean-failed',
      body: {
        runs: [
          { repo: 'alpha', runId: 'R1' },
          { repo: 'alpha', runId: 'R2' },
        ],
        items: 'requeue',
      },
    },
  ]);
  expect(r.ui.underway).toEqual({ 'clean:alpha': 'cleaning…' });
});

test('a clean all failed that left a run is a red toast that stays, and one that cleaned the open run leaves it', async () => {
  const r = rig(undefined, failedRepos(false));
  r.actor.act('clean-failed', { repo: 'alpha' });
  r.actor.confirm();
  await r.answer(200, {
    message: 'cleaned 1 of 2 failed runs, left 1',
    left: 1,
    failed: 0,
    runs: [
      { repo: 'alpha', runId: 'R1', cleaned: true, lines: [] },
      { repo: 'alpha', runId: 'R2', cleaned: false, lines: [] },
    ],
  });
  // The open run is alpha/R1, which the answer says is gone.
  expect([r.effects, r.toasts]).toEqual([
    ['leave'],
    ['bad clean all failed alpha: cleaned 1 of 2 failed runs, left 1'],
  ]);
  expect(r.marks.flat()).toEqual(expect.arrayContaining(['sidebar', 'inspector', 'status']));
});

test('a clean all failed that cleaned a run other than the open one leaves the open run alone', async () => {
  const r = rig(undefined, failedRepos(false));
  r.open = { repo: 'alpha', runId: 'OTHER' };
  r.actor.act('clean-failed', { repo: 'alpha' });
  r.actor.confirm();
  await r.answer(200, {
    message: 'cleaned 2 of 2 failed runs',
    left: 0,
    failed: 0,
    runs: [{ repo: 'alpha', runId: 'R1', cleaned: true, lines: [] }],
  });
  expect([r.effects, r.toasts]).toEqual([[], ['ok clean all failed alpha: cleaned 2 of 2 failed runs']]);
});

test('a refused clean all failed is a red toast with the server words, and cancelling its dialog posts nothing', async () => {
  const r = rig(undefined, failedRepos(false));
  r.actor.act('clean-failed', {});
  r.actor.cancel();
  expect(r.posts).toEqual([]);
  r.actor.act('clean-failed', {});
  r.actor.confirm();
  await r.answer(409, { error: 'a clean of every failed run is already under way' });
  expect(r.toasts).toEqual(['bad clean all failed: a clean of every failed run is already under way']);
});
