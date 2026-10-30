// The rail, drawn from the index model: each repository with its workflows, each with its queue row and its runs, failed
// and completed runs folded into counted sections that open when asked or when they hold the open run, repositories and
// workflows closing when asked unless they hold it, and every run a delegated `select-run` action.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { index } from '../../../src/dashboard/files';
import { type RailRepo, type RailRun, railRepos } from '../../../src/dashboard/page/index-model';
import { renderRail } from '../../../src/dashboard/page/rail-view';
import { initialUi, pillOf } from '../../../src/dashboard/page/ui-state';
import {
  FAKE_2_ID,
  FAKE_3_ID,
  GOLDEN_RUN_ID,
  type Machine,
  RUNNING_ID,
  runningCopy,
  seedFixtures,
} from '../../helpers/dashboard';

let m: Machine;
beforeEach(() => {
  m = seedFixtures();
});
afterEach(() => m.remove());

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const rail = (fields = {}) =>
  renderRail(railRepos(index(m.registryDir), NOW), { ...initialUi(0), ...fields }, NOW).value;
/** The runs the rail shows, in order, each marked when selected. */
const shown = (markup: string) =>
  [
    ...markup.matchAll(/<button class="run( sel)?" data-action="select-run" data-repo="(\w+)" data-run="([\w-]+)">/g),
  ].map(([, sel, repo, run]) => `${repo} ${run}${sel ? ' *' : ''}`);

test("the rail shows alpha's failed FAKE-2 in its opened failed section, its closed completed section still showing the selected golden run, and beta's FAKE-3 suspended on budget_exceeded with its title escaped", () => {
  const markup = rail({ repo: 'alpha', runId: GOLDEN_RUN_ID, open: ['alpha/ticket-to-pr:failed'] });
  expect(shown(markup)).toEqual([`alpha ${FAKE_2_ID}`, `alpha ${GOLDEN_RUN_ID} *`, `beta ${FAKE_3_ID}`]);
  expect(markup).toContain(
    '<button class="subgrp-h open" data-action="toggle-section" data-section="alpha/ticket-to-pr:failed"><span class="caret">›</span><span class="sw p-fail"></span><span>failed</span><span class="n">1</span></button>',
  );
  expect(markup.indexOf('data-section="alpha/ticket-to-pr:failed"')).toBeLessThan(
    markup.indexOf('data-section="alpha/ticket-to-pr:completed"'),
  );
  expect(markup).toContain('<span class="nm">alpha</span>');
  expect(markup).toContain('<div class="lgrp-r">https://example.com/beta.git</div>');
  expect(markup).toContain(
    '<button class="subgrp-h" data-action="toggle-section" data-section="alpha/ticket-to-pr:completed"><span class="caret">›</span><span class="sw p-pass"></span><span>completed</span><span class="n">1</span></button>',
  );
  expect(markup).toContain(
    '<span class="r-title">Escape &lt;b&gt;this&lt;/b&gt; &amp; &quot;that&quot;</span><span class="r-sub">suspended · <span class="why">budget_exceeded</span> · 6.2s · $1.06</span>',
  );
  expect(markup).toContain('failed · <span class="why">stage_error</span> · 4.9s · $0.36');
  expect(markup).toContain('<div class="rail-h"><span>repositories</span><span class="c">4 runs</span></div>');
});

test('the failed and completed sections stay closed unless opened or holding the selection', () => {
  expect(shown(rail())).toEqual([`beta ${FAKE_3_ID}`]);
  expect(rail()).toContain(
    '<button class="subgrp-h" data-action="toggle-section" data-section="alpha/ticket-to-pr:failed">',
  );
  expect(rail()).toContain(
    '<button class="subgrp-h" data-action="toggle-section" data-section="alpha/ticket-to-pr:completed">',
  );
  expect(shown(rail({ repo: 'alpha', runId: FAKE_2_ID }))).toEqual([`alpha ${FAKE_2_ID} *`, `beta ${FAKE_3_ID}`]);
  const states = [
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
  ];
  expect([...states, 'skipped'].map(pillOf)).toEqual([
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
  expect(shown(rail({ open: ['alpha/ticket-to-pr:completed'] }))).toEqual([
    `alpha ${GOLDEN_RUN_ID}`,
    `beta ${FAKE_3_ID}`,
  ]);
});

test("each repository lists its workflows by name: beta's review and ticket-to-pr, the watched one with its queue row", () => {
  const markup = rail();
  const groups = [...markup.matchAll(/data-action="toggle-group" data-group="([^"]+)"/g)].map(([, group]) => group);
  expect(groups).toEqual(['alpha', 'alpha/ticket-to-pr', 'beta', 'beta/review', 'beta/ticket-to-pr']);
  expect(markup).toContain(
    '<button class="wf-h open" data-action="toggle-group" data-group="alpha/ticket-to-pr"><span class="caret">›</span><span class="nm">ticket-to-pr</span><span class="counts"><span class="f">✗ 1</span><span>2</span></span></button>',
  );
  expect(markup).toContain(
    '<button class="wf-q" data-action="select-queue" data-queue="beta/ticket-to-pr"><span class="qd"></span><span>queue</span><span class="n">1 waiting · polled 7d ago</span></button>',
  );
  expect(markup.match(/data-action="select-queue"/g)).toHaveLength(2);
  expect(markup).toContain('data-section="beta/review:completed"');
});

test("a closed repository or workflow folds, keeping only the open run's row or the open queue's row in sight, and an open queue unmarks the run", () => {
  const closed = rail({ closed: ['alpha', 'beta/ticket-to-pr'] });
  expect(closed).toContain('<button class="lgrp-h" data-action="toggle-group" data-group="alpha">');
  expect(closed).not.toContain('data-group="alpha/ticket-to-pr"');
  expect(closed).toContain('<button class="wf-h" data-action="toggle-group" data-group="beta/ticket-to-pr">');
  expect([shown(closed), closed.includes('class="wf-q"')]).toEqual([[], false]);
  const holding = rail({ closed: ['alpha', 'alpha/ticket-to-pr'], repo: 'alpha', runId: GOLDEN_RUN_ID });
  expect(shown(holding)).toEqual([`alpha ${GOLDEN_RUN_ID} *`, `beta ${FAKE_3_ID}`]);
  const queued = rail({
    closed: ['beta', 'beta/ticket-to-pr'],
    repo: 'beta',
    runId: FAKE_3_ID,
    queue: 'beta/ticket-to-pr',
  });
  expect(queued).toContain('<button class="wf-q sel" data-action="select-queue" data-queue="beta/ticket-to-pr">');
  expect(shown(queued)).toEqual([]);
  const repoClosed = rail({ closed: ['beta'], repo: 'beta', runId: FAKE_3_ID });
  expect(shown(repoClosed)).toEqual([`beta ${FAKE_3_ID} *`]);
  expect(repoClosed).not.toContain('data-group="beta/ticket-to-pr"');
});

const liveRows = (markup: string) =>
  [
    ...markup.matchAll(
      /<button class="run live-run( sel)?"[^>]*data-action="select-run" data-repo="(\w+)" data-run="([\w-]+)"/g,
    ),
  ].map(([, sel, repo, run]) => `${repo} ${run}${sel ? ' *' : ''}`);

const handMade = (runs: Partial<RailRun>[], waiting = 0): RailRepo[] => [
  {
    name: 'gamma',
    remote: null,
    live: false,
    runs: runs.map((run, i) => ({ runId: `run-${i}`, status: 'completed', ...run })),
    workflows: [
      {
        name: 'flow',
        runs: runs.map((run, i) => ({ runId: `run-${i}`, status: 'completed', ...run })),
        queue: { waiting },
      },
    ],
  },
];

test('the running block lists every live run across repositories, newest first, and is absent when none is live', () => {
  runningCopy(m, 5);
  const markup = rail();
  expect(liveRows(markup)).toEqual([`alpha ${RUNNING_ID}`, `beta ${FAKE_3_ID}`]);
  expect(markup).toContain('<div class="rail-h"><span>running</span><span class="c">2</span></div>');
  expect(markup).toContain('beta › ticket-to-pr · 6.2s · $1.06 · <span class="why">budget_exceeded</span>');
  expect(markup).toContain('title="Escape &lt;b&gt;this&lt;/b&gt; &amp; &quot;that&quot;"');
  const none = renderRail(handMade([{ status: 'failed' }, { status: 'completed' }]), initialUi(0), NOW).value;
  expect(none).not.toContain('<span>running</span>');
  expect(none).not.toContain('live-run');
});

test('the queued block lists only workflows with work waiting, and is absent when none waits', () => {
  const markup = rail();
  const block = markup.slice(markup.indexOf('<span>queued</span>'));
  expect(markup).toContain('<div class="rail-h"><span>queued</span><span class="c">1</span></div>');
  expect(markup).toContain(
    '<button class="q-row" title="polled 7d ago" data-action="select-queue" data-queue="beta/ticket-to-pr"><span class="qd"></span><span class="nm">beta › ticket-to-pr</span><span class="n">1 waiting</span></button>',
  );
  expect(block.match(/class="q-row/g)).toHaveLength(1);
  expect(rail({ queue: 'beta/ticket-to-pr' })).toContain('<button class="q-row sel" title="polled 7d ago"');
  expect(renderRail(handMade([{}], 0), initialUi(0), NOW).value).not.toContain('<span>queued</span>');
  expect(renderRail(handMade([{}], 3), initialUi(0), NOW).value).toContain('<span class="n">3 waiting</span>');
});

test('a pull-request run reads PR #<n> with its run id in the tooltip', () => {
  const id = 'pr-12-01M00000000000000000000000';
  const markup = renderRail(
    handMade([{ runId: id, status: 'running', pr: 12, title: 'Fix it', workflow: 'flow' }]),
    initialUi(0),
    NOW,
  ).value;
  expect(markup).toContain('<span class="r-id">PR #12</span>');
  expect(markup).toContain(`title="${id} · Fix it"`);
});

test('a run selected from the running block is marked sel', () => {
  runningCopy(m, 5);
  const markup = rail({ repo: 'alpha', runId: RUNNING_ID });
  expect(markup).toContain(`<button class="run live-run sel"`);
  expect(liveRows(markup)).toEqual([`alpha ${RUNNING_ID} *`, `beta ${FAKE_3_ID}`]);
});
