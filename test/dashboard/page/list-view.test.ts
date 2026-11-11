// The list, drawn from hand-made repositories: its head and counts, its groups and rows, the run menu under a row, the
// folded group, and the Queues view's watch buttons.
import { describe, expect, test } from 'bun:test';
import type { AttentionItem } from '../../../src/dashboard/page/attention';
import type { ListRepo, ListRun, ListWorkflow } from '../../../src/dashboard/page/index-model';
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
    {
      watching: ['flow'],
      workflows: [{ name: 'flow', runs: [], queue: { waiting: 3 } }],
      offers: { watch: { enabled: true }, unwatch: { enabled: true }, workflows: {} },
    },
  ),
  repo('beta', [run('b-done', 'completed', '2026-09-30T06:00:00Z', { title: 'Done work' })], {
    offers: { watch: { enabled: true }, workflows: {} },
  }),
];

const ui = (fields = {}) => ({ ...initialUi(0), ...fields });
const drawHistoryHead = (list: ListRepo[], fields = {}) => renderList('history', list, ui(fields), NOW).value;
const draw = (view: 'active' | 'queues' | 'history', fields = {}, offers = undefined as never) =>
  renderList(view, repos, ui(fields), NOW, offers).value;
const heads = (markup: string) =>
  [
    ...markup.matchAll(
      /data-action="toggle-list-group" data-group="([^"]+)"[^>]*><span class="lcaret">›<\/span><span class="nm">([^<]*)<\/span><span class="c">(\d+)/g,
    ),
  ].map(([, id, label, n]) => `${id} ${label} ${n}`);

describe('audit 2: rows say what they are (ADW-543)', () => {
  const PATH = '/private/var/T/sail-dashboard-x/alpha/.sail-runs/a-bad/STATUS holds "x", not one of running';
  const unreadable = [repo('alpha', [run('a-bad', 'unknown', '2026-10-01T08:00:00Z', { problem: PATH })])];

  test('an Inbox row leads with what it is about, then what happened, then its detail', () => {
    const items: AttentionItem[] = [
      { repo: 'alpha', runId: 'r', kind: 'failed', about: 'PR #12', title: 'failed: stage_error', detail: 'broke' },
      {
        repo: 'alpha',
        workflow: 'flow',
        kind: 'parked',
        about: 'ADW-9',
        title: 'parked after 2 attempts',
        detail: 'x',
      },
      { repo: 'alpha', runId: 'a-bad', kind: 'problem', about: 'a-bad', title: 'run', detail: PATH },
    ];
    const markup = renderList('inbox', repos, ui(), NOW, undefined, items).value;
    expect(markup).toContain(
      '<span class="r-line"><span class="r-id">PR #12</span><b class="r-title">failed: stage_error</b><span class="r-detail" title="broke">broke</span></span>',
    );
    expect(markup).toContain('<span class="r-id">ADW-9</span><b class="r-title">parked after 2 attempts</b>');
    expect(markup).toContain('<span class="r-id">a-bad</span><b class="r-title">run</b></span><span class="r-problem"');
    expect(markup).toContain('>.sail-runs/a-bad/STATUS holds &quot;x&quot;, not one of running</span>');
  });

  test("the all clear button says the registry's label as its text and its title, with its key", () => {
    const markup = renderList('inbox', repos, ui(), NOW, undefined, [
      { repo: 'alpha', runId: 'a-bad', kind: 'problem', about: 'a-bad', title: 'run', detail: 'x' },
    ]).value;
    expect(markup).toContain('data-action="clear-attention" title="all clear (⇧E)">all clear</button>');
    expect(markup).not.toContain('dismiss all');
  });

  test("a run row's problem shows its path from the clone, the whole of it in its tooltip", () => {
    const markup = renderList('active', unreadable, ui(), NOW).value;
    expect(markup).toContain(
      `<span class="r-problem" title="${PATH.replaceAll('"', '&quot;')}">.sail-runs/a-bad/STATUS holds &quot;x&quot;, not one of running</span>`,
    );
  });

  test('a stop reason is amber on a suspended run and red only on a failed one', () => {
    const list = [
      repo('alpha', [
        run('s', 'suspended', '2026-10-01T08:00:00Z', { stopReason: 'budget_exceeded' }),
        run('f', 'failed', '2026-10-01T07:00:00Z', { stopReason: 'stage_error' }),
      ]),
    ];
    expect(renderList('active', list, ui(), NOW).value).toContain('<span class="why">budget_exceeded</span>');
    expect(renderList('history', list, ui(), NOW).value).toContain('<span class="why fail">stage_error</span>');
  });

  test("History's head is two lines: name, count and filter, then its controls, which a Selection's count and buttons take", () => {
    const list = [
      repo('alpha', [run('f', 'failed', '2026-10-01T07:00:00Z')], {
        offers: { watch: { enabled: true }, workflows: {}, clean: { enabled: true, runs: [{ runId: 'f' }] } },
      }),
    ];
    const head = (fields = {}) =>
      /<div class="list-h">(.*?)<\/div><div class="lgrp">/s.exec(drawHistoryHead(list, fields))?.[1] ?? '';
    const plain = head();
    expect(plain).toContain(
      '<span class="lh-end"><button class="btn" data-action="clean-failed">clean all failed</button>',
    );
    expect(plain).toMatch(
      /^<div class="lh-row"><span class="lh-t">History<\/span><span class="c">1<\/span><input class="list-f"[^>]*><\/div><div class="lh-row lh-ctl"><select class="list-s" name="list-status"/,
    );
    expect(plain).not.toContain('lh-sel');
    const picked = head({ listSelected: ['run:alpha/f'] });
    expect(picked).toContain('<div class="lh-row lh-ctl"><span class="lh-sel">1 selected</span>');
    expect(picked).not.toContain('clean-failed');
    expect(picked).not.toContain('list-s');
    expect(renderList('active', repos, ui(), NOW).value).not.toContain('lh-ctl');
  });

  test("a picked row carries a tick, and a Queues group's long repository name its whole in a tooltip", () => {
    const markup = renderList('history', repos, ui({ listSelected: ['run:alpha/a-fail'] }), NOW).value;
    expect(markup.match(/<span class="r-tick" aria-hidden="true">✓<\/span>/g)).toHaveLength(1);
    expect(draw('queues')).toContain('<span class="nm" title="alpha">alpha</span>');
  });
});

describe("a run's row leads with its title, its ID under it (ADW-550)", () => {
  const rowOf = (extra: Partial<ListRun>, status = 'running', fields = {}) => {
    const view = status === 'completed' || status === 'failed' ? 'history' : 'active';
    const list = [repo('alpha', [run('r-1', status, '2026-10-01T10:00:00Z', { durationMs: 65_000, ...extra })])];
    const markup = renderList(view, list, ui(fields), NOW, undefined as never).value;
    return markup.match(/<div class="run lrow.*?<\/button>/s)?.[0] ?? '';
  };
  const inner = (row: string) => row.slice(row.indexOf('<span class="r-line">'), -'</button>'.length);

  test("a ticket's run: the title on the first line with the duration, the ticket key alone on the second", () => {
    expect(inner(rowOf({ ticketKey: 'ADW-1', title: 'Fix the parser' }))).toBe(
      '<span class="r-line"><span class="st p-run"></span><span class="r-title">Fix the parser</span><span class="r-el">1m 5s</span></span><span class="r-sub"><span class="r-id">ADW-1</span></span>',
    );
  });

  test("a pull request's run shows the pull request's title, with PR #n under it and the whole title in its tooltip", () => {
    const row = rowOf({ pr: 305, title: 'feat(dashboard): the command menu is a listbox' });
    expect(inner(row)).toBe(
      '<span class="r-line"><span class="st p-run"></span><span class="r-title">feat(dashboard): the command menu is a listbox</span><span class="r-el">1m 5s</span></span><span class="r-sub"><span class="r-id">PR #305</span></span>',
    );
    expect(row).toContain('title="r-1 · feat(dashboard): the command menu is a listbox"');
  });

  test('a run with no title leads with its ID on the first line and has no second line', () => {
    const row = rowOf({ pr: 305 });
    expect(inner(row)).toBe(
      '<span class="r-line"><span class="st p-run"></span><span class="r-title">PR #305</span><span class="r-el">1m 5s</span></span>',
    );
    expect(inner(rowOf({ ticketKey: 'COACH-180' }))).toContain('<span class="r-title">COACH-180</span>');
    expect(inner(rowOf({}))).toContain('<span class="r-title">r-1</span>');
    expect(row).not.toContain('r-sub');
    expect(row).not.toContain('r-id');
    expect(row).not.toContain('<span class="r-title"></span>');
  });

  test('the stalled mark and the stop reason sit at the right of the second line, and of the one line of a run with no title', () => {
    expect(inner(rowOf({ ticketKey: 'ADW-1', title: 'T', stalled: 'spec#1' }))).toBe(
      '<span class="r-line"><span class="st p-run"></span><span class="r-title">T</span><span class="r-el">1m 5s</span></span><span class="r-sub"><span class="r-id">ADW-1</span><span class="stalled">stalled spec#1</span></span>',
    );
    expect(inner(rowOf({ ticketKey: 'ADW-1', title: 'T', stopReason: 'stage_error' }, 'failed'))).toBe(
      '<span class="r-line"><span class="st p-fail"></span><span class="r-title">T</span><span class="r-el">1m 5s</span></span><span class="r-sub"><span class="r-id">ADW-1</span><span class="why fail">stage_error</span></span>',
    );
    expect(inner(rowOf({ ticketKey: 'ADW-1', stalled: 'spec#1' }))).toBe(
      '<span class="r-line"><span class="st p-run"></span><span class="r-title">ADW-1</span><span class="stalled">stalled spec#1</span><span class="r-el">1m 5s</span></span>',
    );
    expect(inner(rowOf({ ticketKey: 'ADW-1', stopReason: 'usage_limit' }, 'suspended'))).toBe(
      '<span class="r-line"><span class="st p-warn"></span><span class="r-title">ADW-1</span><span class="r-el">1m 5s</span><span class="why">usage_limit</span></span>',
    );
  });

  test("an unreadable run's problem goes under its two lines, and a picked row's tick leads its first", () => {
    expect(inner(rowOf({ ticketKey: 'ADW-1', title: 'T', problem: 'summary.json is not a summary' }, 'unknown'))).toBe(
      '<span class="r-line"><span class="st p-skip"></span><span class="r-title">T</span><span class="r-el">1m 5s</span></span><span class="r-sub"><span class="r-id">ADW-1</span></span><span class="r-problem" title="summary.json is not a summary">summary.json is not a summary</span>',
    );
    const picked = rowOf({ ticketKey: 'ADW-1', title: 'T' }, 'completed', { listSelected: ['run:alpha/r-1'] });
    expect(picked).toContain('<div class="run lrow picked" data-row="run:alpha/r-1" aria-selected="true"');
    expect(inner(picked)).toStartWith(
      '<span class="r-line"><span class="r-tick" aria-hidden="true">✓</span><span class="st p-pass"></span><span class="r-title">T</span>',
    );
  });

  test('the open row and the cursor are drawn on a two-line row as on any other, with its ⋯ beside it', () => {
    const list = [repo('alpha', [run('r-1', 'running', '2026-10-01T10:00:00Z', { ticketKey: 'ADW-1', title: 'T' })])];
    const markup = renderList(
      'active',
      list,
      ui({ repo: 'alpha', runId: 'r-1', listCursor: 'run:alpha/r-1' }),
      NOW,
      undefined as never,
    ).value;
    expect(markup).toContain('<div class="run lrow sel cur" data-row="run:alpha/r-1"');
    expect(markup).toContain(
      '<span class="r-sub"><span class="r-id">ADW-1</span></span></button><button class="r-more" type="button" data-action="run-menu"',
    );
  });
});

test('the Active list is headed Active with its count, then waiting on you and running with theirs', () => {
  const markup = draw('active');
  expect(markup).toContain('<span class="lh-t">Active</span><span class="c">3</span>');
  expect(heads(markup)).toEqual(['active:waiting waiting on you 2', 'active:running running 1']);
  expect(markup.match(/data-action="select-run"/g)).toHaveLength(3);
  expect(markup.indexOf('a-susp')).toBeLessThan(markup.indexOf('data-run="a-run"'));
});

test('a run row holds its status, id, title, repository › workflow, duration, cost and stop reason, and a problem inside the row', () => {
  const markup = draw('active');
  const row = markup.match(/<div class="run lrow" data-row="run:alpha\/a-run"[^>]*>.*?<\/button>/s)?.[0] ?? '';
  expect(row).toContain(
    '<span class="r-line"><span class="st p-run"></span><span class="r-title">Fix the parser</span><span class="r-el">1m 5s</span></span><span class="r-sub"><span class="r-id">ADW-1</span></span>',
  );
  expect(row).not.toContain('r-wf');
  expect(row).not.toContain('r-cost');
  const susp = markup.match(/data-row="run:alpha\/a-susp"[^>]*>.*?<\/button>/s)?.[0] ?? '';
  expect(susp).toContain('<span class="why">usage_limit</span>');
  const bad = markup.match(/data-row="run:alpha\/a-bad"[^>]*>.*?<\/button>/s)?.[0] ?? '';
  expect(bad).toContain(
    '<span class="r-problem" title="run.json is not a run header">run.json is not a run header</span>',
  );
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
    { repo: 'alpha', runId: 'a-run', runMenu: { runId: 'a-run', at: 'row' as const }, listCursor: 'run:alpha/a-run' },
    offers,
  );
  expect(markup).toContain(
    'class="run lrow sel cur" data-row="run:alpha/a-run" data-subject="run" data-repo="alpha" data-run="a-run"',
  );
  expect(markup).toContain(
    'data-action="run-menu" data-repo="alpha" data-run="a-run" aria-label="actions for a-run" aria-expanded="true"',
  );
  expect(markup).toMatch(/<\/button><div class="r-menu"><div class="acts">/);
  expect(markup.match(/ cur"/g)).toHaveLength(1);
  const reading = draw('active', { repo: 'alpha', runId: 'a-run', runMenu: { runId: 'a-run', at: 'row' as const } });
  expect(reading).toContain('<div class="r-menu"><span class="act-why">reading what the run offers…</span></div>');
});

test("a run's menu opened from its header draws no row menu, and the row's ⋯ stays shut", () => {
  const markup = draw('active', { repo: 'alpha', runId: 'a-run', runMenu: { runId: 'a-run', at: 'header' as const } }, {
    stop: { now: true },
  } as never);
  expect(markup).not.toContain('class="r-menu"');
  expect(markup).toContain('aria-expanded="false"');
});

test("a row's menu is drawn inside its row", () => {
  const markup = draw('active', { repo: 'alpha', runId: 'a-run', runMenu: { runId: 'a-run', at: 'row' as const } }, {
    stop: { now: true },
  } as never);
  const row = markup.slice(markup.indexOf('data-row="run:alpha/a-run"'));
  expect(row).toContain('</button><div class="r-menu"><div class="acts"><span class="act">');
  expect(row).toContain('<button class="btn" disabled>stop</button>');
  expect(row).not.toContain('</div><div class="r-menu">');
});

test('a completed run has a ⋯, and its open menu draws restart', () => {
  expect(draw('history')).toContain('data-action="run-menu" data-repo="beta" data-run="b-done"');
  expect(draw('history')).toContain('data-action="run-menu" data-repo="alpha" data-run="a-fail"');
  const markup = draw('history', { repo: 'beta', runId: 'b-done', runMenu: { runId: 'b-done', at: 'row' as const } }, {
    restart: { enabled: true, stages: [{ stage: 'spec', runsAgain: 'spec#1 and everything after it' }], stage: 'spec' },
  } as never);
  expect(markup).toContain('data-action="restart-run"');
});

test('a run that offers Rebuild alone draws its menu with a rebuild button', () => {
  const markup = draw('history', { repo: 'beta', runId: 'b-done', runMenu: { runId: 'b-done', at: 'row' as const } }, {
    rebuild: { enabled: true, problem: 'summary.json is not a sail.summary.v1' },
  } as never);
  expect(markup).toContain(
    '<div class="r-menu"><div class="acts"><span class="act"><button class="btn" data-action="rebuild-run">rebuild</button></span></div></div>',
  );
});

test('History lists one group per start day and Queues one row per queue under its repository, with Watch all on each header row', () => {
  const history = draw('history');
  expect(heads(history)).toEqual(['history:2026-10-01 Today 1', 'history:2026-09-30 Yesterday 1']);
  expect(history).not.toContain('history:failed');
  expect(history).not.toContain('history:done');
  const queues = draw('queues');
  expect(queues).toContain('<span class="lh-t">Queues</span><span class="c">1</span>');
  expect(queues.match(/data-action="select-queue" data-queue="alpha\/flow"/g)).toHaveLength(1);
  expect(queues).toContain('<span class="nm">alpha › flow</span><span class="n">3 waiting</span>');
  expect(queues.match(/data-action="watch" data-repo="(\w+)">watch all/g)).toHaveLength(2);
  expect(queues.match(/data-action="unwatch" data-repo="\w+">unwatch all</g)).toHaveLength(1);
  expect(queues).toContain('data-action="unwatch" data-repo="alpha">unwatch all');
});

test('unwatch all is never armed, and a problem shows on the repository row with no answer beside it', () => {
  const markup = renderList(
    'queues',
    [{ ...repos[0], problem: 'cannot read' } as ListRepo, repos[1] as ListRepo],
    ui(),
    NOW,
  ).value;
  expect(markup).toContain('data-action="unwatch" data-repo="alpha">unwatch all</button>');
  expect(markup).not.toContain('armed');
  expect(markup.match(/class="lgrp-p"/g)).toHaveLength(1);
  expect(markup).toContain('<div class="lgrp-p">cannot read</div>');
});

test("while a watch request is out a repository's watch buttons read the word under way", () => {
  const markup = draw('queues', { underway: { 'watch:alpha': 'unwatching…' } });
  expect(markup).toContain('<span class="busy">unwatching…</span>');
  expect(markup).not.toContain('data-action="unwatch" data-repo="alpha">unwatch all');
  expect(draw('queues')).not.toContain('busy');
});

test('while a request for a run is out its row reads the word under way in place of the status dot', () => {
  const markup = draw('active', { underway: { 'run:alpha/a-run': 'stopping…' } });
  expect(markup).toContain(
    '<span class="r-line"><span class="busy">stopping…</span><span class="r-title">Fix the parser</span>',
  );
  expect(draw('active')).not.toContain('busy');
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
  expect(stalled('running')).toContain('<span class="stalled">stalled spec#1</span>');
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
  expect(markup).toContain(
    '<span class="r-title">Fix it</span><span class="r-el">—</span></span><span class="r-sub"><span class="r-id">PR #12</span></span>',
  );
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

test("History's head holds a status and a workflow control and the count reads n of m; Active and Queues hold neither", () => {
  const history = draw('history');
  expect(history).toContain(
    '<select class="list-s" name="list-status" aria-label="filter by status"><option value="" selected>any status</option><option value="failed">failed</option><option value="completed">done</option></select>',
  );
  expect(history).toContain(
    '<select class="list-s" name="list-workflow" aria-label="filter by workflow"><option value="" selected>any workflow</option><option value="flow">flow</option></select>',
  );
  expect(history).toContain('<span class="lh-t">History</span><span class="c">2</span>');
  const failed = draw('history', { historyStatus: 'failed' });
  expect(failed).toContain('<option value="failed" selected>failed</option>');
  expect(failed).toContain('<span class="c">1 of 2</span>');
  expect(failed).not.toContain('data-row="run:beta/b-done"');
  const wf = draw('history', { historyWorkflow: 'flow' });
  expect(wf).toContain('<option value="flow" selected>flow</option>');
  expect(wf).toContain('<span class="c">2 of 2</span>');
  const gone = draw('history', { historyWorkflow: 'old' });
  expect(gone).toContain('<option value="old" selected>old</option>');
  expect(gone).toContain('nothing matches');
  expect(gone).toContain('<span class="c">0 of 2</span>');
  expect(draw('active')).not.toContain('<select');
  expect(draw('queues')).not.toContain('<select');
});

test("a selected row is drawn picked and History's head counts the selection with a clear button", () => {
  const none = draw('history');
  expect(none).not.toContain('lh-sel');
  expect(none).not.toContain('picked');
  const one = draw('history', { listSelected: ['run:alpha/a-fail', 'run:gone/zz'] });
  expect(one).toContain('<span class="lh-sel">1 selected</span>');
  expect(one).toContain('<button class="btn" data-action="clear-selection">clear</button>');
  expect(one).toContain('class="run lrow picked" data-row="run:alpha/a-fail" aria-selected="true"');
  expect(one).not.toContain('data-row="run:beta/b-done" aria-selected');
  expect(draw('active', { listSelected: ['run:alpha/a-run'] })).not.toContain('lh-sel');
});

test("the head's clean button is replaced by checking… while the selection's offers are read", () => {
  const picked = { listSelected: ['run:alpha/a-fail'] };
  expect(draw('history', picked)).toContain(
    '<span class="lh-sel">1 selected</span><button class="btn" data-action="clean-selected">clean</button><button class="btn" data-action="clear-selection">clear</button>',
  );
  const busy = draw('history', { ...picked, underway: { selection: 'checking 1 run…' } });
  expect(busy).toContain('<span class="busy">checking 1 run…</span>');
  expect(busy).not.toContain('data-action="clean-selected"');
});

const inboxItems: AttentionItem[] = [
  {
    repo: 'alpha',
    runId: 'a-run',
    key: 'build#1',
    kind: 'error',
    about: 'ADW-7',
    title: 'build#1 ended in error',
    detail: 'it broke',
    opens: { repo: 'alpha', runId: 'a-run', key: 'build#1' },
  },
  { repo: 'alpha', workflow: 'flow', kind: 'parked', about: 'ADW-9', title: 'parked', detail: 'no tests' },
  { repo: 'beta', kind: 'problem', about: 'beta', title: 'repository', detail: 'cannot <b>read</b>' },
];
const inbox = (fields = {}, items = inboxItems) => renderList('inbox', repos, ui(fields), NOW, undefined, items).value;

test('the Inbox is headed Inbox with its count, and each row holds its title, where it is and its detail', () => {
  const markup = inbox();
  expect(markup).toContain('<span class="lh-t">Inbox</span><span class="c">3</span>');
  expect(heads(markup)).toEqual(['inbox:runs runs 1', 'inbox:parked parked 1', 'inbox:problems problems 1']);
  expect(markup).toContain(
    '<span class="r-id">ADW-7</span><b class="r-title">build#1 ended in error</b><span class="r-detail"',
  );
  expect(markup).not.toContain('r-wf');
  expect(markup).toContain('title="it broke">it broke</span>');
  expect(markup).toContain(
    '<span class="r-problem" title="cannot &lt;b&gt;read&lt;/b&gt;">cannot &lt;b&gt;read&lt;/b&gt;</span>',
  );
});

test('an Inbox row opens its run at its call, or its queue, or nothing', () => {
  const markup = inbox();
  expect(markup).toContain('data-action="open" data-repo="alpha" data-run="a-run" data-key="build#1"');
  expect(markup).toContain('data-action="select-queue" data-queue="alpha/flow"');
  const problem = markup.match(/<div class="lrow in-row in-problem[^>]*>.*?<\/div><\/div>/s)?.[0] ?? '';
  expect(problem).toContain('<div class="r-open">');
  expect(problem.split('<button class="r-dismiss"')[0]).not.toContain('data-action');
});

test('the open run marks its Inbox row selected, and so does the open queue', () => {
  expect(inbox({ repo: 'alpha', runId: 'a-run' })).toMatch(/class="lrow in-row in-error sel" data-row/);
  expect(inbox({ queue: 'alpha/flow' })).toMatch(/class="lrow in-row in-parked sel" data-row/);
  expect(inbox()).not.toContain(' sel"');
});

test('the Inbox says nothing needs attention with no item', () => {
  expect(inbox({}, [])).toContain('<div class="qempty">nothing needs attention</div>');
  expect(inbox({}, [])).toContain('<span class="c">0</span>');
});

test('each Inbox row carries a dismiss button naming its identity, beside its opener', () => {
  const markup = inbox();
  expect(
    markup.match(/<button class="r-dismiss" type="button" data-action="dismiss-attention" data-item="/g),
  ).toHaveLength(3);
  expect(markup).toContain('aria-label="dismiss" title="dismiss (E)">✕</button>');
  expect(markup).toContain(
    `data-item="${JSON.stringify(['beta', 'problem', null, null, null, 'beta', 'repository', 'cannot <b>read</b>']).replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}"`,
  );
  expect(draw('active')).not.toContain('r-dismiss');
});

// A queue's row: counts, last poll, pause, hold and the buttons beside its open button.
type Queue = NonNullable<ListWorkflow['queue']>;
const queueRowOf = (queue: Queue, fields = {}, watch?: ListWorkflow['watch'], repoOffers?: ListRepo['offers']) => {
  const only = repo('alpha', [], {
    workflows: [{ name: 'flow', runs: [], queue, ...(watch === undefined ? {} : { watch }) }],
    ...(repoOffers === undefined ? {} : { offers: repoOffers }),
  });
  const markup = renderList('queues', [only], ui(fields), NOW).value;
  const row = markup.match(/<div class="q-row[^"]*" data-row="queue:alpha\/flow"[^>]*>.*?<\/div><\/div>/s)?.[0] ?? '';
  const open = row.match(/<button class="q-open".*?<\/button>/s)?.[0] ?? '';
  return { row, open, after: row.slice(row.indexOf(open) + open.length) };
};
const POLL_OFFERS = { poll: { enabled: true }, add: { enabled: true }, items: {} };

test('a queue row draws waiting always and running, failed and parked only above 0', () => {
  const { open } = queueRowOf({ waiting: 3, running: 1, parked: 2 });
  expect(open).toContain('<span class="n">3 waiting</span>');
  expect(open).toContain('<span class="q-c running">1 running</span>');
  expect(open).toContain('<span class="q-c parked">2 parked</span>');
  expect(open).not.toContain('failed');
  const bare = queueRowOf({ waiting: 0 }).open;
  expect(bare).toContain('0 waiting');
  expect(bare).not.toMatch(/running|failed|parked/);
});

test('a queue row says when it was polled, or never, as text and not as a title', () => {
  const polled = queueRowOf({ waiting: 1, lastPolledAt: '2026-10-01T11:56:00.000Z' }).row;
  expect(polled).toContain('<span class="q-polled">polled 4m ago</span>');
  const never = queueRowOf({ waiting: 1 }).row;
  expect(never).toContain('<span class="q-polled">never polled</span>');
  expect(polled).not.toContain('title="polled');
  expect(never).not.toContain('title="polled');
});

test('a queue row shows its pause and its hold with or without a time, escaping the message', () => {
  const both = queueRowOf({
    waiting: 0,
    paused: { port: 'ticketSource', adapter: 'linear', message: '503 <b>' },
    held: { until: '2026-10-01T12:00:00.000Z', reason: 'usage limit' },
  }).open;
  expect(both).toContain('<span class="warnchip">ticket polls paused — linear: 503 &lt;b&gt;</span>');
  expect(both).toContain('<span class="warnchip">held until 12:00 — usage limit</span>');
  expect(queueRowOf({ waiting: 0, held: { reason: 'needs a newer sail' } }).open).toContain(
    '<span class="warnchip">held — needs a newer sail</span>',
  );
  const pr = queueRowOf({ waiting: 0, paused: { port: 'codeHost', adapter: 'github', message: 'down' } }).open;
  expect(pr).toContain('<span class="warnchip">pull request polls paused — github: down</span>');
  const other = queueRowOf({ waiting: 0, paused: { port: 'jev', adapter: 'x', message: 'down' } }).open;
  expect(other).toContain('<span class="warnchip">jev polls paused — x: down</span>');
});

test("a queue row carries poll and unwatch after its open button, with the workflow's repo and name", () => {
  const { open, after } = queueRowOf(
    { waiting: 1, offers: POLL_OFFERS },
    {},
    { state: 'watched' },
    { watch: { enabled: true }, workflows: { flow: { unwatch: { enabled: true } } } },
  );
  expect(open).toContain('data-action="select-queue" data-queue="alpha/flow"');
  expect(open).not.toContain('data-action="poll-queue"');
  expect(open).not.toContain('title=');
  expect(after).toContain('data-action="poll-queue" data-repo="alpha" data-workflow="flow"');
  expect(after).toContain('data-action="unwatch" data-repo="alpha" data-workflow="flow"');
});

test("a queue row's poll is disabled with the server's reason as its title when the workflow isn't watched", () => {
  const why = "no watcher is running for 'alpha': sail watch flow first";
  const { after } = queueRowOf(
    { waiting: 1, offers: { ...POLL_OFFERS, poll: { enabled: false, why } } },
    {},
    { state: 'watcher not running', why },
    { watch: { enabled: true }, workflows: { flow: { watch: { enabled: true } } } },
  );
  expect(after).toContain(
    '<button class="wf-act" disabled title="no watcher is running for &#39;alpha&#39;: sail watch flow first">poll</button>',
  );
  expect(after).not.toContain('data-action="poll-queue"');
  expect(after).toContain('data-action="watch" data-repo="alpha" data-workflow="flow"');
});

test('a queue row with no queue offers has no poll, and a watched one with an unwatch offer has unwatch', () => {
  const { after } = queueRowOf(
    { waiting: 0 },
    {},
    { state: 'watched' },
    {
      watch: { enabled: true },
      workflows: { flow: { unwatch: { enabled: true } } },
    },
  );
  expect(after).not.toContain('poll');
  expect(after).toContain('data-action="unwatch"');
});

test('while a poll or a watch request is out the row reads the word under way in place of its buttons', () => {
  const repoOffers = { watch: { enabled: true }, workflows: { flow: { unwatch: { enabled: true } } } };
  const polling = queueRowOf(
    { waiting: 0, offers: POLL_OFFERS },
    { underway: { 'queue:alpha/flow': 'polling…' } },
    { state: 'watched' },
    repoOffers,
  );
  expect(polling.after).toContain('<span class="busy">polling…</span>');
  expect(polling.after).not.toContain('data-action="poll-queue"');
  expect(polling.after).toContain('data-action="unwatch"');
  const watching = queueRowOf(
    { waiting: 0, offers: POLL_OFFERS },
    { underway: { 'watch:alpha/flow': 'unwatching…' } },
    { state: 'watched' },
    repoOffers,
  );
  expect(watching.after).toContain('<span class="busy">unwatching…</span>');
  expect(watching.after).not.toContain('data-action="unwatch"');
  expect(watching.after).toContain('data-action="poll-queue"');
});

test('an unreadable queue row keeps its problem and buttons, with no counts or last poll', () => {
  const { row, open, after } = queueRowOf(
    { problem: "queue.json can't be read", offers: POLL_OFFERS },
    {},
    { state: 'watched' },
    {
      watch: { enabled: true },
      workflows: { flow: { unwatch: { enabled: true } } },
    },
  );
  expect(row).toContain('class="q-row bad"');
  expect(open).toContain(
    '<span class="n">unreadable</span><span class="r-problem" title="queue.json can&#39;t be read">queue.json can&#39;t be read</span>',
  );
  expect(row).not.toContain('polled');
  expect(row).not.toContain('waiting');
  expect(after).toContain('data-action="poll-queue"');
  expect(after).toContain('data-action="unwatch"');
});

test("the selected queue's row and the cursor's carry sel and cur on the div, which holds one select-queue button", () => {
  const { row } = queueRowOf({ waiting: 0 }, { queue: 'alpha/flow', listCursor: 'queue:alpha/flow' });
  expect(row).toStartWith(
    '<div class="q-row sel cur" data-row="queue:alpha/flow" data-subject="workflow" data-repo="alpha" data-workflow="flow">',
  );
  expect(row.match(/data-action="select-queue"/g)).toHaveLength(1);
});

const failing = (name: string, ids: string[]): ListRepo =>
  repo(name, [], {
    offers: {
      watch: { enabled: true },
      workflows: {},
      clean: { enabled: true, runs: ids.map((runId) => ({ runId })) },
    },
  });
const drawHistory = (list: ListRepo[], fields = {}) => renderList('history', list, ui(fields), NOW).value;
const CLEAN_BUTTON = /<button class="btn" data-action="clean-failed"([^>]*)>clean all failed<\/button>/;

test("History's head draws clean all failed for every repository with no filter, and for the repository alone with one", () => {
  const list = [failing('alpha', ['A-1']), failing('beta', ['B-1'])];
  const all = CLEAN_BUTTON.exec(drawHistory(list));
  expect(all?.[1]).toBe('');
  const one = CLEAN_BUTTON.exec(drawHistory(list, { repoFilter: 'beta' }));
  expect(one?.[1]).toBe(' data-repo="beta"');
});

test("History's head draws no clean all failed when no listed repository offers it, or the filtered one doesn't", () => {
  expect(drawHistory([repo('alpha', []), repo('beta', [])])).not.toContain('clean-failed');
  const list = [failing('alpha', ['A-1']), repo('beta', [])];
  expect(drawHistory(list, { repoFilter: 'beta' })).not.toContain('clean-failed');
  expect(renderList('active', list, ui(), NOW).value).not.toContain('clean-failed');
});

test('while a clean of every failed run is out, the word under way takes the clean all failed button place', () => {
  const list = [failing('alpha', ['A-1'])];
  const markup = drawHistory(list, { underway: { 'clean:*': 'cleaning…' } });
  expect(markup).toContain('<span class="busy">cleaning…</span>');
  expect(markup).not.toContain('clean all failed');
  const scoped = drawHistory(list, { repoFilter: 'alpha', underway: { 'clean:*': 'cleaning…' } });
  expect(scoped).toContain('clean all failed');
});
