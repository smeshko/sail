// The centre's empty state: its headline per view, its counts (singular, plural, a zero part left out), the view's
// empty words when it has no row, and no counts line before the first index.
import { describe, expect, test } from 'bun:test';
import type { AttentionItem } from '../../../src/dashboard/page/attention';
import { renderEmpty } from '../../../src/dashboard/page/empty-view';
import type { ListRepo, ListRun } from '../../../src/dashboard/page/index-model';
import { groupsOf, shownGroups, type ViewName } from '../../../src/dashboard/page/list-model';
import { initialUi } from '../../../src/dashboard/page/ui-state';

const CLOCK = { now: Date.parse('2026-10-01T12:00:00.000Z'), tz: 0 };
const run = (runId: string, status: string, startedAt = '2026-10-01T10:00:00Z'): ListRun => ({
  runId,
  status,
  startedAt,
  workflow: 'flow@1',
});
const repo = (name: string, runs: ListRun[], waiting?: number[]): ListRepo => ({
  name,
  remote: null,
  live: false,
  runs,
  workflows: (waiting ?? []).map((n, i) => ({ name: `wf${i}`, runs: [], queue: { waiting: n } })),
});
const items: AttentionItem[] = [
  {
    repo: 'alpha',
    runId: 'r1',
    kind: 'failed',
    about: 'r1',
    title: 't',
    detail: '',
    opens: { repo: 'alpha', runId: 'r1' },
  },
  {
    repo: 'alpha',
    runId: 'r2',
    kind: 'error',
    about: 'r2',
    title: 't2',
    detail: '',
    opens: { repo: 'alpha', runId: 'r2' },
  },
  { repo: 'alpha', workflow: 'wf0', kind: 'parked', about: 'X-1', title: 'p', detail: '' },
  { repo: 'beta', kind: 'problem', about: 'beta', title: 'q', detail: '' },
];
const repos = [
  repo('alpha', [run('a1', 'suspended'), run('a2', 'running'), run('a3', 'running'), run('a4', 'failed')], [2, 0]),
  repo('beta', [run('b1', 'completed'), run('b2', 'completed')]),
];
const draw = (view: ViewName, list = repos, filter?: string, inbox = items) =>
  renderEmpty(view, groupsOf(view, list, filter, CLOCK, inbox)).value;

const KEYS = '<kbd>J</kbd> <kbd>K</kbd> move · <kbd>↵</kbd> open · <kbd>⌘K</kbd> commands';

describe('audit 2: rows say what they are (ADW-543)', () => {
  test('a machine with no repository shows the first run state: what to do, the command to copy, and no keys', () => {
    const markup = renderEmpty('active', [], initialUi(0), 0).value;
    expect(markup).toContain('<div class="empty-t">No repository yet</div>');
    expect(markup).toContain('<code>sail watch</code>');
    expect(markup).toContain('data-action="copy" data-text="sail watch">copy</button>');
    expect(markup).not.toContain('No run selected');
    expect(markup).not.toContain('<kbd>');
    const copied = renderEmpty('active', [], { ...initialUi(0), copied: { text: 'sail watch', ok: true } }, 0).value;
    expect(copied).toContain('data-text="sail watch">copied</button>');
  });

  test('the counts are what the list shows: a filter narrows them, and one that hides every row reads nothing matches', () => {
    const shown = (view: ViewName, fields: Partial<ReturnType<typeof initialUi>>) => {
      const ui = { ...initialUi(0), ...fields };
      return renderEmpty(view, shownGroups(view, repos, ui, CLOCK.now, items), ui, repos.length).value;
    };
    expect(shown('active', { listFilter: 'a2' })).toContain('<div class="empty-c">1 running</div>');
    expect(shown('history', { historyStatus: 'failed' })).toContain('<div class="empty-c">1 failed</div>');
    const none = shown('active', { listFilter: 'nothing like it' });
    expect(none).toContain('<div class="empty-c">nothing matches</div>');
    expect(shown('history', { historyWorkflow: 'other' })).toContain('<div class="empty-c">nothing matches</div>');
  });

  test('keys that move and open are left out while the list shows no row; the menu key stays', () => {
    const markup = renderEmpty('active', [], initialUi(0), 2).value;
    expect(markup).toContain('<div class="empty-c">no live run</div>');
    expect(markup).toContain('<div class="empty-k"><kbd>⌘K</kbd> commands</div>');
  });
});

test('Active says No run selected with its waiting and running counts and the three keys', () => {
  const markup = draw('active');
  expect(markup).toContain('<div class="empty-t">No run selected</div>');
  expect(markup).toContain('<div class="empty-c">1 waiting on you · 2 running</div>');
  expect(markup).toContain(`<div class="empty-k">${KEYS}</div>`);
});

test('Queues says No queue selected and counts its queues and what waits, singular at one', () => {
  expect(draw('queues')).toContain('<div class="empty-t">No queue selected</div>');
  expect(draw('queues')).toContain('<div class="empty-c">2 queues · 2 waiting</div>');
  expect(draw('queues', [repo('alpha', [], [1])])).toContain('<div class="empty-c">1 queue · 1 waiting</div>');
});

test('Inbox counts its runs, parked items and problems, leaving a zero part out', () => {
  expect(draw('inbox')).toContain('<div class="empty-c">2 runs · 1 parked · 1 problem</div>');
  expect(draw('inbox', repos, undefined, [items[0] as AttentionItem])).toContain('<div class="empty-c">1 run</div>');
});

test('History counts its failed and done runs', () => {
  expect(draw('history')).toContain('<div class="empty-t">No run selected</div>');
  expect(draw('history')).toContain('<div class="empty-c">1 failed · 2 done</div>');
});

test('the counts follow the repository filter', () => {
  expect(draw('active', repos, 'beta')).toContain('<div class="empty-c">no live run</div>');
  expect(draw('history', repos, 'beta')).toContain('<div class="empty-c">2 done</div>');
});

test('a view with no row reads its empty words in place of counts', () => {
  expect(draw('inbox', [], undefined, [])).toContain('<div class="empty-c">nothing needs attention</div>');
  expect(draw('queues', [])).toContain('<div class="empty-c">no queue</div>');
  expect(draw('history', [])).toContain('<div class="empty-c">no finished run</div>');
});

test('before the first index the headline and keys stand alone, with no counts line', () => {
  const markup = renderEmpty('active', undefined).value;
  expect(markup).toContain('No run selected');
  expect(markup).not.toContain('empty-c');
});
