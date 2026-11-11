// The registry of the page's actions: its entries, what each posts, what each answer means and where each reads
// its availability from the server's offers.
import { expect, test } from 'bun:test';
import type { RunActions } from '../../../src/dashboard/actions';
import type { IndexRepo } from '../../../src/dashboard/files';
import {
  ACTIONS,
  actionOf,
  answerField,
  type OfferSource,
  refusal,
  type Subject,
  severalHead,
  subjectName,
  subjectOf,
  underwayId,
} from '../../../src/dashboard/page/action-registry';

const RUN: Subject = { kind: 'run', repo: 'alpha', runId: 'FAKE-1-RUN' };
const ITEM: Subject = { kind: 'item', repo: 'alpha', workflow: 'wf', item: 'ticket:FAKE-5' };
const WORKFLOW: Subject = { kind: 'workflow', repo: 'alpha', workflow: 'wf' };
const REPO: Subject = { kind: 'repo', repo: 'alpha' };
const NONE: Subject = { kind: 'none' };

const on = { enabled: true };
const off = { enabled: false, why: 'because' };

const runActions: RunActions = {
  resume: { ...on, spentUsd: 2.5, budget: { maxUsd: 5 }, raise: 'usd' },
  restart: {
    ...on,
    stage: 'tests',
    stages: [
      { stage: 'spec', runsAgain: 'spec' },
      { stage: 'tests', runsAgain: 'tests' },
    ],
    budget: { maxUsd: 10 },
  },
  stop: on,
  clean: { ...on, removes: ['its worktree', 'its branch'], archive: '/m/failed-runs/x' },
} as unknown as RunActions;

const index = (repo: Record<string, unknown>) =>
  [{ name: 'alpha', runs: [], queues: [], ...repo }] as unknown as IndexRepo[];
const source = (extra: Partial<OfferSource> = {}): OfferSource => ({ run: runActions, index: [], ...extra });
const def = (id: string) => {
  const found = actionOf(id);
  if (found === undefined) throw new Error(`no action ${id}`);
  return found;
};
const request = (id: string, subject: Subject, values: Record<string, string> = {}, from = source()) =>
  def(id).request?.(subject, values, from);

test('ACTIONS has exactly the fifteen ids, each with a label, appliesTo, a tier and a request and answer or a local run', () => {
  expect(ACTIONS.map((each) => each.id).sort()).toEqual(
    [
      'resume-run',
      'restart-run',
      'stop-run',
      'stop-run-now',
      'clean-run',
      'drop-item',
      'requeue-item',
      'move-item',
      'poll-queue',
      'release-hold',
      'add-ticket',
      'add-ticket-force',
      'watch',
      'unwatch',
      'clear-attention',
    ].sort(),
  );
  for (const each of ACTIONS) {
    expect(each.appliesTo.length).toBeGreaterThan(0);
    expect(each.label(RUN)).not.toBe('');
    expect(each.key).toBeUndefined();
    if (each.id === 'clear-attention')
      expect([each.run, each.request, each.answer]).toEqual(['clear-attention', undefined, undefined]);
    else expect([typeof each.request, typeof each.answer, each.run]).toEqual(['function', 'function', undefined]);
  }
  expect(ACTIONS.filter((each) => each.tier === 'confirmed').map((each) => each.id)).toEqual([
    'resume-run',
    'restart-run',
    'stop-run',
    'stop-run-now',
    'clean-run',
    'drop-item',
    'release-hold',
    'add-ticket-force',
  ]);
  expect(ACTIONS.filter((each) => each.tier === 'undoable').map((each) => each.id)).toEqual([
    'unwatch',
    'clear-attention',
  ]);
});

test('every entry posts what its handler posted', () => {
  // Stop never reads a field: whatever a value named `now` holds, Stop posts false and Stop now true.
  expect(request('stop-run', RUN, { now: 'on' })).toEqual({
    path: '/api/repos/alpha/runs/FAKE-1-RUN/stop',
    body: { now: false },
  });
  expect(request('stop-run', RUN)).toEqual({
    path: '/api/repos/alpha/runs/FAKE-1-RUN/stop',
    body: { now: false },
  });
  expect(request('stop-run-now', RUN)).toEqual({
    path: '/api/repos/alpha/runs/FAKE-1-RUN/stop',
    body: { now: true },
  });
  expect(request('clean-run', RUN)).toEqual({ path: '/api/repos/alpha/runs/FAKE-1-RUN/clean', body: {} });
  expect(request('restart-run', RUN, { stage: 'spec' })).toEqual({
    path: '/api/repos/alpha/runs/FAKE-1-RUN/restart',
    body: { stage: 'spec' },
  });
  expect(request('resume-run', RUN, { raise: '5' })).toEqual({
    path: '/api/repos/alpha/runs/FAKE-1-RUN/resume',
    body: { raise: { usd: 5 } },
  });
  expect(
    request('resume-run', RUN, {}, source({ run: { resume: { ...on, raise: undefined } } as unknown as RunActions })),
  ).toEqual({
    path: '/api/repos/alpha/runs/FAKE-1-RUN/resume',
    body: {},
  });
  expect(request('move-item', ITEM, { dir: 'up', target: 'ticket:FAKE-4' })).toEqual({
    path: '/api/repos/alpha/queues/wf/move',
    body: { dedupKey: 'ticket:FAKE-5', before: 'ticket:FAKE-4' },
  });
  expect(request('move-item', ITEM, { dir: 'down', target: 'ticket:FAKE-6' })).toEqual({
    path: '/api/repos/alpha/queues/wf/move',
    body: { dedupKey: 'ticket:FAKE-5', after: 'ticket:FAKE-6' },
  });
  expect(request('poll-queue', WORKFLOW)).toEqual({ path: '/api/repos/alpha/queues/wf/poll', body: {} });
  expect(request('requeue-item', ITEM)).toEqual({
    path: '/api/repos/alpha/queues/wf/requeue',
    body: { dedupKey: 'ticket:FAKE-5' },
  });
  expect(request('drop-item', ITEM)).toEqual({
    path: '/api/repos/alpha/queues/wf/drop',
    body: { dedupKey: 'ticket:FAKE-5' },
  });
  expect(request('add-ticket', WORKFLOW, { ticket: ' FAKE-9 ' })).toEqual({
    path: '/api/repos/alpha/queues/wf/add',
    body: { ticketKey: 'FAKE-9' },
  });
  expect(request('add-ticket', WORKFLOW, { ticket: 'FAKE-9', force: 'on' })).toEqual({
    path: '/api/repos/alpha/queues/wf/add',
    body: { ticketKey: 'FAKE-9' },
  });
  expect(request('add-ticket-force', WORKFLOW, { ticket: ' FAKE-9 ' })).toEqual({
    path: '/api/repos/alpha/queues/wf/add',
    body: { ticketKey: 'FAKE-9', force: true },
  });
  expect(request('add-ticket-force', WORKFLOW, { ticket: ' ' })).toBeUndefined();
  expect(request('watch', REPO)).toEqual({ path: '/api/repos/alpha/watch', body: { workflows: [] } });
  expect(request('watch', WORKFLOW)).toEqual({ path: '/api/repos/alpha/watch', body: { workflows: ['wf'] } });
  expect(request('unwatch', WORKFLOW)).toEqual({ path: '/api/repos/alpha/unwatch', body: { workflows: ['wf'] } });
});

test('a repository, run or workflow name with a slash is encoded in the path', () => {
  expect(request('watch', { kind: 'repo', repo: 'a/b' })).toMatchObject({ path: '/api/repos/a%2Fb/watch' });
});

test('a resume that needs a raise refuses an empty, zero or non-numeric one in the unit of the raise, and an empty ticket gives no request', () => {
  const dollars = { invalid: 'give the dollars to raise the budget by: at least 0.01' };
  for (const raise of [undefined, '', '  ', '0', '0.001', 'abc']) {
    expect(request('resume-run', RUN, raise === undefined ? {} : { raise })).toEqual(dollars);
  }
  const minutes = source({ run: { resume: { ...on, raise: 'minutes' } } as unknown as RunActions });
  expect(request('resume-run', RUN, { raise: '0' }, minutes)).toEqual({
    invalid: 'give the minutes to raise the budget by: at least 0.01',
  });
  expect(request('resume-run', RUN, { raise: '0.01' }, minutes)).toMatchObject({ body: { raise: { minutes: 0.01 } } });
  expect(request('add-ticket', WORKFLOW, { ticket: '   ' })).toBeUndefined();
  expect(request('add-ticket', WORKFLOW, {})).toBeUndefined();
});

test('each answer means what it meant: resume reopens, restart opens the run named, stop reopens with its message, clean leaves into the list', () => {
  expect(def('resume-run').answer?.(200, '{}', RUN)).toEqual({ effect: 'reopen', text: 'resumed' });
  expect(def('restart-run').answer?.(200, '{"runId":"NEW"}', RUN)).toEqual({
    effect: { open: 'NEW' },
    text: 'started NEW',
  });
  expect(def('restart-run').answer?.(200, '{}', RUN)).toEqual({});
  expect(def('stop-run').answer?.(200, '{"message":"stopped"}', RUN)).toEqual({
    effect: 'reopen',
    keepMenu: true,
    text: 'stopped',
  });
  expect(def('clean-run').answer?.(200, '{"message":"cleaned"}', RUN)).toEqual({
    effect: 'leave',
    text: 'cleaned',
  });
  expect(def('clean-run').answer?.(200, '{}', RUN)).toEqual({ effect: 'leave' });
});

test('a queue change shows a 200 message and took, a 202 waiting, and any other status its refusal', () => {
  const answer = (id: string, status: number, body: string) => def(id).answer?.(status, body, ITEM);
  expect(answer('drop-item', 200, '{"message":"gone"}')).toEqual({ text: 'gone', effect: 'took' });
  expect(answer('poll-queue', 202, '{"waiting":"not yet"}')).toEqual({ text: 'not yet' });
  expect(answer('poll-queue', 202, '{"message":"x"}')).toEqual({});
  expect(answer('move-item', 409, '{"error":"no watcher"}')).toEqual({
    text: 'no watcher',
    refused: true,
  });
  expect(answer('add-ticket', 500, 'oops')).toEqual({
    text: 'the add was refused (500)',
    refused: true,
  });
});

test('release-hold posts the harness key its row gives to the queue release route, confirmed in the dialog', () => {
  expect(request('release-hold', WORKFLOW, { harness: 'pi:openai-codex' })).toEqual({
    path: '/api/repos/alpha/queues/wf/release',
    body: { harnessKey: 'pi:openai-codex' },
  });
  expect(def('release-hold').tier).toBe('confirmed');
  expect(def('release-hold').dialog?.(WORKFLOW, { harness: 'pi:openai-codex' }, source())).toEqual({
    title: 'release the usage-limit hold on pi:openai-codex',
    lines: ["releasing ends every watcher's hold on pi:openai-codex, and dispatch resumes"],
    verb: 'release',
  });
  expect(def('release-hold').available(WORKFLOW, source())).toEqual({ offered: true, enabled: true });
  const answer = (status: number, body: string) => def('release-hold').answer?.(status, body, WORKFLOW);
  expect(answer(200, '{"message":"released the usage-limit hold on k"}')).toEqual({
    text: 'released the usage-limit hold on k',
    effect: 'took',
  });
  expect(answer(409, '{"error":"no"}')).toEqual({ text: 'no', refused: true });
  expect(answer(0, '')).toEqual({
    text: 'the release could not be sent: the dashboard did not answer',
    refused: true,
  });
});

test('watch shows its message or waiting under the repository, and any other status its refusal', () => {
  expect(def('watch').answer?.(200, '{"message":"m","waiting":"w"}', REPO)).toEqual({ text: 'm' });
  expect(def('watch').answer?.(202, '{"waiting":"w"}', REPO)).toEqual({ text: 'w' });
  expect(def('watch').answer?.(202, '{}', REPO)).toEqual({});
  expect(def('unwatch').answer?.(409, '{"error":"nope"}', REPO)).toEqual({
    text: 'nope',
    refused: true,
  });
  expect(def('unwatch').answer?.(0, '', REPO)).toEqual({
    text: 'the unwatch could not be sent: the dashboard did not answer',
    refused: true,
  });
});

test('a toast names its subject: a run by its id, an item by its key, a workflow with its repository, a repository', () => {
  expect([
    subjectName({ kind: 'run', repo: 'a', runId: 'R1' }),
    subjectName({ kind: 'item', repo: 'a', workflow: 'w', item: 'ticket:X-1' }),
    subjectName({ kind: 'workflow', repo: 'a', workflow: 'w' }),
    subjectName({ kind: 'repo', repo: 'a' }),
    subjectName({ kind: 'none' }),
  ]).toEqual(['R1', 'ticket:X-1', 'a / w', 'a', '']);
});

test('the word under way is kept by subject, a workflow of a watch apart from the workflow of a poll', () => {
  const workflow: Subject = { kind: 'workflow', repo: 'a', workflow: 'w' };
  expect([
    underwayId(def('poll-queue'), workflow),
    underwayId(def('watch'), workflow),
    underwayId(def('unwatch'), { kind: 'repo', repo: 'a' }),
    underwayId(def('requeue-item'), { kind: 'item', repo: 'a', workflow: 'w', item: 'k' }),
    underwayId(def('stop-run'), { kind: 'run', repo: 'a', runId: 'R1' }),
    underwayId(def('clear-attention'), { kind: 'none' }),
  ]).toEqual(['queue:a/w', 'watch:a/w', 'watch:a', 'item:a/w/k', 'run:a/R1', '']);
  expect(
    ['poll-queue', 'add-ticket', 'move-item', 'requeue-item', 'drop-item', 'watch', 'unwatch'].map(
      (id) => def(id).underway,
    ),
  ).toEqual(['polling…', 'adding…', 'moving…', 'requeuing…', 'dropping…', 'watching…', 'unwatching…']);
});

test('a run action that is refused says why, by its own noun', () => {
  expect(def('resume-run').answer?.(409, '{"error":"busy"}', RUN)).toEqual({ text: 'busy', refused: true });
  expect(def('stop-run').answer?.(500, 'x', RUN)).toEqual({ text: 'the stop was refused (500)', refused: true });
  expect(refusal(404, '[]', 'clean')).toBe('the clean was refused (404)');
  expect(answerField('{"a":""}', 'a')).toBeUndefined();
  expect(answerField('nope', 'a')).toBeUndefined();
});

test('a confirmed run action opens a dialog naming the run and each consequence, built from the offers', () => {
  const dialog = (id: string, values: Record<string, string> = {}) => def(id).dialog?.(RUN, values, source());
  expect(dialog('resume-run', { raise: '5' })).toEqual({
    title: 'resume FAKE-1-RUN',
    lines: ['spent $2.50 of $5.00', 'raises the budget by $5.00'],
    verb: 'resume',
  });
  expect(dialog('resume-run')?.lines).toEqual(['spent $2.50 of $5.00']);
  expect(dialog('restart-run', { stage: 'spec' })).toEqual({
    title: 'restart FAKE-1-RUN',
    lines: ['runs again: spec', 'budget $10.00', 'starts a new run seeded from FAKE-1-RUN'],
    verb: 'restart',
  });
  expect(dialog('restart-run', { stage: 'gone' })?.lines[0]).toBe('runs again: tests');
  expect(dialog('stop-run')).toEqual({
    title: 'stop FAKE-1-RUN',
    lines: ['stops at its next call boundary', 'the run fails as stopped'],
    verb: 'stop',
  });
  expect(dialog('stop-run', { now: 'on' })?.lines[0]).toBe('stops at its next call boundary');
  expect(dialog('stop-run-now')).toEqual({
    title: 'stop FAKE-1-RUN now',
    lines: ['ends its running call now', 'the run fails as stopped'],
    verb: 'stop now',
  });
  expect([def('stop-run').label(RUN), def('stop-run-now').label(RUN)]).toEqual(['stop', 'stop now']);
  expect([def('stop-run').params(RUN, source()), def('stop-run-now').params(RUN, source())]).toEqual([[], []]);
  expect(dialog('clean-run')).toEqual({
    title: 'clean FAKE-1-RUN',
    lines: ['removes its worktree', 'removes its branch', 'run directory → /m/failed-runs/x'],
    verb: 'clean',
  });
});

test('the drop dialog names the item and its queue', () => {
  expect(def('drop-item').dialog?.(ITEM, {}, source())).toEqual({
    title: 'drop ticket:FAKE-5',
    lines: ["removes ticket:FAKE-5 from alpha / wf's queue"],
    verb: 'drop',
  });
  expect(def('drop-item').dialog?.(WORKFLOW, {}, source())).toEqual({ title: 'drop', lines: [], verb: 'drop' });
});

test('every confirmed action has a dialog, and unwatch and all clear are the undoable ones', () => {
  for (const each of ACTIONS)
    expect([each.id, typeof each.dialog]).toEqual([each.id, each.tier === 'confirmed' ? 'function' : 'undefined']);
  expect(ACTIONS.filter((each) => each.tier === 'undoable').map((each) => each.id)).toEqual([
    'unwatch',
    'clear-attention',
  ]);
  expect(ACTIONS.filter((each) => each.tier === 'confirmed').map((each) => each.id)).toEqual([
    'resume-run',
    'restart-run',
    'stop-run',
    'stop-run-now',
    'clean-run',
    'drop-item',
    'release-hold',
    'add-ticket-force',
  ]);
});

test('an unwatch of a workflow undoes with a watch of it, and of a repository with a watch of what the index lists as watched', () => {
  const watching = [
    { name: 'alpha', runs: [], queues: [], watching: { pid: 1, workflows: ['wf', 'other'] } },
  ] as unknown as IndexRepo[];
  const undo = (subject: Subject) => def('unwatch').undo?.(subject, source({ index: watching }));
  expect(undo(WORKFLOW)).toEqual({ action: 'watch', path: '/api/repos/alpha/watch', body: { workflows: ['wf'] } });
  expect(undo(REPO)).toEqual({ action: 'watch', path: '/api/repos/alpha/watch', body: { workflows: ['wf', 'other'] } });
  expect(def('unwatch').undo?.(REPO, source())).toEqual({
    action: 'watch',
    path: '/api/repos/alpha/watch',
    body: { workflows: [] },
  });
});

test('available() reads a run action from the open run, an item from its queue, a queue from its offers and watch from the repository', () => {
  const repo = index({
    queues: [
      {
        workflow: 'wf',
        offers: { poll: on, add: off, items: { 'ticket:FAKE-5': { drop: on, move: off } } },
      },
    ],
    offers: { watch: on, unwatch: off, workflows: { wf: { unwatch: on }, other: { watch: off } } },
  });
  const from = source({ index: repo });
  const at = (id: string, subject: Subject) => def(id).available(subject, from);
  expect(at('stop-run', RUN)).toMatchObject({ offered: true, enabled: true });
  expect(at('resume-run', RUN)).toMatchObject({ offered: true, enabled: true });
  expect(def('stop-run').available(RUN, source({ run: {} }))).toEqual({ offered: false });
  expect(at('drop-item', ITEM)).toMatchObject({ offered: true, enabled: true });
  expect(at('move-item', ITEM)).toMatchObject({ offered: true, enabled: false });
  expect(at('requeue-item', ITEM)).toEqual({ offered: false });
  expect(at('poll-queue', WORKFLOW)).toMatchObject({ enabled: true });
  expect(at('add-ticket', WORKFLOW)).toMatchObject({ enabled: false });
  expect(at('watch', REPO)).toMatchObject({ enabled: true });
  expect(at('unwatch', REPO)).toMatchObject({ enabled: false });
  expect(at('unwatch', WORKFLOW)).toMatchObject({ offered: true, enabled: true });
  expect(at('watch', WORKFLOW)).toEqual({ offered: false });
  expect(at('watch', { kind: 'workflow', repo: 'alpha', workflow: 'other' })).toMatchObject({
    enabled: false,
    why: 'because',
  });
  expect(at('clear-attention', NONE)).toMatchObject({ offered: true, enabled: true });
});

test('an index with no offers, and an item keyed __proto__ that has none, offer nothing', () => {
  const bare = source({ index: index({ queues: [{ workflow: 'wf' }] }) });
  for (const id of ['drop-item', 'requeue-item', 'move-item'])
    expect(def(id).available(ITEM, bare)).toEqual({ offered: false });
  for (const id of ['poll-queue', 'add-ticket']) expect(def(id).available(WORKFLOW, bare)).toEqual({ offered: false });
  for (const id of ['watch', 'unwatch']) {
    expect(def(id).available(REPO, bare)).toEqual({ offered: false });
    expect(def(id).available(WORKFLOW, bare)).toEqual({ offered: false });
  }
  const proto: Subject = { ...ITEM, item: '__proto__' };
  const empty = source({
    index: index({
      queues: [{ workflow: 'wf', offers: { poll: on, add: on, items: {} } }],
      offers: { watch: on, workflows: {} },
    }),
  });
  expect(def('drop-item').available(proto, empty)).toEqual({ offered: false });
  const named = JSON.parse(
    '{"workflow":"wf","offers":{"poll":{"enabled":true},"add":{"enabled":true},"items":{"__proto__":{"drop":{"enabled":true}}}}}',
  );
  expect(def('drop-item').available(proto, source({ index: index({ queues: [named] }) }))).toMatchObject({
    offered: true,
  });
  expect(def('move-item').available(proto, source({ index: index({ queues: [named] }) }))).toEqual({ offered: false });
});

test('subjectOf takes the first kind a click names, the open run when none is named, and an item key from data-item or data-key', () => {
  const open = { repo: 'alpha', runId: 'R' };
  expect(subjectOf(['run'], {}, open)).toEqual({ kind: 'run', repo: 'alpha', runId: 'R' });
  expect(subjectOf(['run'], { repo: 'beta', run: 'S' }, open)).toEqual({ kind: 'run', repo: 'beta', runId: 'S' });
  expect(subjectOf(['run'], {})).toBeUndefined();
  expect(subjectOf(['item'], { repo: 'a', workflow: 'w', item: 'i' })).toEqual({
    kind: 'item',
    repo: 'a',
    workflow: 'w',
    item: 'i',
  });
  expect(subjectOf(['item'], { repo: 'a', workflow: 'w', key: 'k' })).toEqual({
    kind: 'item',
    repo: 'a',
    workflow: 'w',
    item: 'k',
  });
  expect(subjectOf(['item'], { repo: 'a', workflow: 'w' })).toBeUndefined();
  expect(subjectOf(['workflow', 'repo'], { repo: 'a', workflow: 'w' })).toEqual({
    kind: 'workflow',
    repo: 'a',
    workflow: 'w',
  });
  expect(subjectOf(['workflow', 'repo'], { repo: 'a' })).toEqual({ kind: 'repo', repo: 'a' });
  expect(subjectOf(['workflow', 'repo'], {})).toBeUndefined();
  expect(subjectOf(['none'], {})).toEqual({ kind: 'none' });
});

test('actionOf finds an entry by id in a registry given, and none that is not there', () => {
  expect(actionOf('stop-run')?.id).toBe('stop-run');
  expect(actionOf('nope')).toBeUndefined();
  expect(actionOf('stop-run', [])).toBeUndefined();
});

test("clean of several opens one dialog with a line per run that goes and a skips line per run that can't", () => {
  const runOf = (runId: string): Subject => ({ kind: 'run', repo: 'alpha', runId });
  const several = def('clean-run').several;
  expect(
    several?.dialog(
      [
        { subject: runOf('R-a'), offers: runActions },
        {
          subject: runOf('R-b'),
          offers: { clean: { enabled: false, why: 'ticket:FAKE-9 names it' } } as unknown as RunActions,
        },
        { subject: runOf('R-c'), offers: { why: 'run R-c completed: there is nothing to start again' } },
        { subject: runOf('R-d'), offers: undefined },
      ],
      source(),
    ),
  ).toEqual({
    title: 'clean 4 runs',
    lines: [
      'R-a: removes its worktree, its branch; run directory → /m/failed-runs/x',
      'skips R-b: ticket:FAKE-9 names it',
      'skips R-c: run R-c completed: there is nothing to start again',
      'skips R-d: what it offers could not be read',
    ],
    verb: 'clean',
  });
  expect(
    several?.dialog(
      [{ subject: runOf('R-e'), offers: { clean: { ...on, removes: [] } } as unknown as RunActions }],
      source(),
    ),
  ).toEqual({ title: 'clean 1 run', lines: ['R-e: removes nothing'], verb: 'clean' });
  expect(severalHead(def('clean-run'), 3)).toBe('clean 3 runs');
  expect(severalHead(def('clean-run'), 1)).toBe('clean 1 run');
  expect(def('stop-run').several).toBeUndefined();
});
