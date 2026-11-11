// The list, drawn from hand-made repositories: its head and counts, its groups and rows, the run menu under a row, the
// folded group, and the Queues view's watch buttons.
import { expect, test } from 'bun:test';
import type { ListRepo, ListRun } from '../../../src/dashboard/page/index-model';
import { renderList } from '../../../src/dashboard/page/list-view';
import { initialUi, pillOf } from '../../../src/dashboard/page/ui-state';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const run = (runId: string, status: string, startedAt: string, extra: Partial<ListRun> = {}): ListRun => ({
  runId,
  status,
  startedAt,
  workflow: 'flow@1',
  ...extra,
});
const repo = (name: string, runs: ListRun[], extra: Partial<ListRepo> = {}): ListRepo => ({
  name,
  remote: null,
  live: false,
  runs,
  workflows: [],
  ...extra,
});

const repos: ListRepo[] = [
  repo(
    'alpha',
    [
      run('a-run', 'running', '2026-10-01T10:00:00Z', {
        ticketKey: 'ADW-1',
        title: 'Fix the parser',
        durationMs: 65_000,
        costUsd: 1.5,
      }),
      run('a-susp', 'suspended', '2026-10-01T09:00:00Z', { stopReason: 'usage_limit' }),
      run('a-bad', 'unknown', '2026-10-01T08:00:00Z', { problem: 'run.json is not a run header' }),
      run('a-fail', 'failed', '2026-10-01T07:00:00Z'),
    ],
    { watching: ['flow'], workflows: [{ name: 'flow', runs: [], queue: { waiting: 3 } }] },
  ),
  repo('beta', [run('b-done', 'completed', '2026-10-01T06:00:00Z', { title: 'Done work' })]),
];

const ui = (fields = {}) => ({ ...initialUi(0), ...fields });
const draw = (view: 'active' | 'queues' | 'history', fields = {}, offers = undefined as never) =>
  renderList(view, repos, ui(fields), NOW, offers).value;
const heads = (markup: string) =>
  [
    ...markup.matchAll(
      /data-action="toggle-list-group" data-group="([^"]+)"[^>]*><span class="lcaret">›<\/span><span class="nm">([^<]*)<\/span><span class="c">(\d+)/g,
    ),
  ].map(([, id, label, n]) => `${id} ${label} ${n}`);

test('the Active list is headed Active with its count, then waiting on you and running with theirs', () => {
  const markup = draw('active');
  expect(markup).toContain('<span class="lh-t">Active</span><span class="c">3</span>');
  expect(heads(markup)).toEqual(['active:waiting waiting on you 2', 'active:running running 1']);
  expect(markup.match(/data-action="select-run"/g)).toHaveLength(3);
  expect(markup.indexOf('a-susp')).toBeLessThan(markup.indexOf('data-run="a-run"'));
});

test('a run row holds its status, id, title, repository › workflow, duration, cost and stop reason, and a problem inside the row', () => {
  const markup = draw('active');
  const row = markup.match(/<div class="run lrow" data-row="run:alpha\/a-run">.*?<\/button>/s)?.[0] ?? '';
  expect(row).toContain(
    '<span class="st p-run"></span><span class="r-id">ADW-1</span><span class="r-title">Fix the parser</span><span class="r-wf">alpha › flow</span>',
  );
  expect(row).toContain('<span class="r-el">1m 5s</span><span class="r-cost">$1.50</span>');
  const susp = markup.match(/data-row="run:alpha\/a-susp">.*?<\/button>/s)?.[0] ?? '';
  expect(susp).toContain('<span class="why">usage_limit</span>');
  const bad = markup.match(/data-row="run:alpha\/a-bad">.*?<\/button>/s)?.[0] ?? '';
  expect(bad).toContain('<span class="r-problem">run.json is not a run header</span>');
});

test('the filter field narrows the list and the head reads n of m', () => {
  const markup = draw('active', { listFilter: 'parser' });
  expect(markup).toContain('<span class="c">1 of 3</span>');
  expect(markup).toContain('name="list-filter"');
  expect(markup).toContain('value="parser"');
  expect(markup.match(/data-action="select-run"/g)).toHaveLength(1);
  expect(draw('active', { listFilter: 'zzz' })).toContain('nothing matches');
});

test('a repository filter narrows the list to that repository', () => {
  const markup = draw('history', { repoFilter: 'beta' });
  expect(markup).toContain('<span class="lh-t">History</span><span class="c">1</span>');
  expect(markup).not.toContain('a-fail');
});

test('a folded group draws its header and no row', () => {
  const markup = draw('active', { listFolded: ['active:waiting'] });
  expect(heads(markup)).toEqual(['active:waiting waiting on you 2', 'active:running running 1']);
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).not.toContain('a-susp"');
  expect(markup).toContain('data-run="a-run"');
});

test('the open run draws its ⋯ menu under its row with the run controls, and the cursor marks one entry', () => {
  const offers = { stop: { now: true } } as never;
  const markup = draw(
    'active',
    { repo: 'alpha', runId: 'a-run', runMenu: 'a-run', listCursor: 'run:alpha/a-run' },
    offers,
  );
  expect(markup).toContain('class="run lrow sel cur" data-row="run:alpha/a-run"');
  expect(markup).toContain(
    'data-action="run-menu" data-repo="alpha" data-run="a-run" aria-label="actions for a-run" aria-expanded="true"',
  );
  expect(markup).toMatch(/<\/div><div class="r-menu"><div class="acts">/);
  expect(markup.match(/ cur"/g)).toHaveLength(1);
  const reading = draw('active', { repo: 'alpha', runId: 'a-run', runMenu: 'a-run' });
  expect(reading).toContain('<div class="r-menu"><span class="act-why">reading what the run offers…</span></div>');
});

test('a completed run has no ⋯', () => {
  expect(draw('history')).toContain('data-run="b-done"');
  expect(draw('history')).not.toContain('data-action="run-menu" data-repo="beta"');
  expect(draw('history')).toContain('data-action="run-menu" data-repo="alpha" data-run="a-fail"');
});

test('History lists failed then done and Queues one row per queue under its repository, with Watch all on each header row', () => {
  const history = draw('history');
  expect(heads(history)).toEqual(['history:failed failed 1', 'history:done done 1']);
  const queues = draw('queues');
  expect(queues).toContain('<span class="lh-t">Queues</span><span class="c">1</span>');
  expect(queues.match(/data-action="select-queue" data-queue="alpha\/flow"/g)).toHaveLength(1);
  expect(queues).toContain('<span class="nm">alpha › flow</span><span class="n">3 waiting</span>');
  expect(queues.match(/data-action="watch-set" data-repo="(\w+)" data-op="watch">watch all/g)).toHaveLength(2);
  expect(queues.match(/data-op="unwatch">unwatch all</g)).toHaveLength(1);
  expect(queues).toContain('data-repo="alpha" data-op="unwatch">unwatch all');
});

test('an armed unwatch reads click again, and the watch notice and a problem show on the repository row', () => {
  const markup = renderList(
    'queues',
    [{ ...repos[0], problem: 'cannot read' } as ListRepo, repos[1] as ListRepo],
    ui({ armedWatch: 'alpha', watchNotice: { repo: 'alpha', text: 'watching flow' } }),
    NOW,
  ).value;
  expect(markup).toContain('unwatch all? click again');
  expect(markup).toContain('<div class="lgrp-p">cannot read</div><div class="lgrp-p">watching flow</div>');
});

test('an empty view says what it lacks', () => {
  expect(renderList('active', [repo('x', [])], ui(), NOW).value).toContain('no live run');
  expect(renderList('history', [repo('x', [])], ui(), NOW).value).toContain('no finished run');
  expect(renderList('active', [], ui(), NOW).value).toContain('no repository is registered yet: run sail watch in one');
});

test('a title, a repository name and a notice that are HTML are escaped', () => {
  const hostile = [
    repo('<b>r</b>', [run('x', 'running', '2026-10-01T10:00:00Z', { title: '<img src=x onerror=alert(1)>' })]),
  ];
  const markup = renderList('active', hostile, ui({ indexNotice: '<script>1</script>' }), NOW).value;
  expect(markup).not.toContain('<img');
  expect(markup).not.toContain('<script');
  expect(markup).not.toContain('<b>');
  expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
});

test('a stalled running run names its stalled key in its row, and a stalled mark on a run that is not running is not drawn (review R11)', () => {
  const stalled = (status: string) =>
    renderList(
      'active',
      [repo('alpha', [run('a-stall', status, '2026-10-01T10:00:00Z', { stalled: 'spec#1' })])],
      ui(),
      NOW,
      undefined as never,
    ).value;
  expect(stalled('running')).toContain(
    '<span class="r-wf">alpha › flow</span><span class="stalled">stalled spec#1</span>',
  );
  expect(stalled('suspended')).not.toContain('class="stalled"');
});

test('a pull-request run reads PR #<n>, with its run id leading the title in its tooltip (review R11)', () => {
  const id = 'pr-12-01M00000000000000000000000';
  const markup = renderList(
    'active',
    [repo('alpha', [run(id, 'running', '2026-10-01T10:00:00Z', { pr: 12, title: 'Fix it', ticketKey: 'ADW-9' })])],
    ui(),
    NOW,
    undefined as never,
  ).value;
  expect(markup).toContain('<span class="r-id">PR #12</span>');
  expect(markup).toContain(`title="${id} · Fix it"`);
  expect(markup).not.toContain('ADW-9');
});

test('each run status draws its own pill colour in its row (review R11)', () => {
  const states = ['completed', 'failed', 'running', 'suspended'];
  const markup = renderList(
    'history',
    [
      repo(
        'alpha',
        states.map((status, at) => run(`r-${status}`, status, `2026-10-01T0${at}:00:00Z`)),
      ),
    ],
    ui(),
    NOW,
    undefined as never,
  ).value;
  const active = renderList(
    'active',
    [
      repo(
        'alpha',
        states.map((status, at) => run(`r-${status}`, status, `2026-10-01T0${at}:00:00Z`)),
      ),
    ],
    ui(),
    NOW,
    undefined as never,
  ).value;
  const pill = (from: string, id: string) =>
    new RegExp(`data-run="${id}"><span class="r-line"><span class="st ([^"]+)">`).exec(from)?.[1];
  expect([
    pill(markup, 'r-completed'),
    pill(markup, 'r-failed'),
    pill(active, 'r-running'),
    pill(active, 'r-suspended'),
  ]).toEqual(['p-pass', 'p-fail', 'p-run', 'p-warn']);
  const all = [
    'completed',
    'passed',
    'done',
    'failed',
    'error',
    'running',
    'suspended',
    'blocked',
    'pending',
    undefined,
    'skipped',
  ];
  expect(all.map(pillOf)).toEqual([
    'p-pass',
    'p-pass',
    'p-pass',
    'p-fail',
    'p-fail',
    'p-run',
    'p-warn',
    'p-warn',
    'p-pend',
    'p-pend',
    'p-skip',
  ]);
});
