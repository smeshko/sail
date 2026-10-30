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
const ALL = ['alpha', 'alpha/ticket-to-pr', 'beta', 'beta/review', 'beta/ticket-to-pr'];
/** The rail with every repository and workflow expanded, unless a field says otherwise. */
const rail = (fields = {}) =>
  renderRail(railRepos(index(m.registryDir), NOW), { ...initialUi(0), expanded: ALL, ...fields }, NOW).value;
const folded = (fields = {}) =>
  renderRail(railRepos(index(m.registryDir), NOW), { ...initialUi(0), ...fields }, NOW).value;
/** The finished runs the rail shows as history rows, in order, each marked when selected. */
const shown = (markup: string) =>
  [
    ...markup.matchAll(
      /<button class="run hist-run( sel)?" title="[^"]*" data-action="select-run" data-repo="(\w+)" data-run="([\w-]+)">/g,
    ),
  ].map(([, sel, repo, run]) => `${repo} ${run}${sel ? ' *' : ''}`);

test('repository headers are one line with the remote as the tooltip and counts omitted at 0, with no diamond, live dot or remote line', () => {
  const markup = rail();
  expect(markup).toContain(
    '<button class="lgrp-h open" title="https://example.com/alpha.git" data-action="toggle-group" data-group="alpha"><span class="caret">›</span><span class="nm">alpha</span><span class="counts"><span class="f">✗ 1</span><span>2</span></span></button>',
  );
  expect(markup).toContain(
    '<button class="lgrp-h open" title="https://example.com/beta.git" data-action="toggle-group" data-group="beta"><span class="caret">›</span><span class="nm">beta</span><span class="counts"><span class="r">▶ 1</span><span>2</span></span></button>',
  );
  for (const gone of ['lgrp-r', '◆', 'class="live"', 'class="ic"']) expect(markup).not.toContain(gone);
  const bare = renderRail(handMade([]), { ...initialUi(0), expanded: ['gamma'] }, NOW).value;
  expect(bare).toContain(
    '<button class="lgrp-h open" data-action="toggle-group" data-group="gamma"><span class="caret">›</span><span class="nm">gamma</span><span class="counts"></span></button>',
  );
});

test('each repository lists its workflows by name, the watched one with a warn queue badge that opens its queue and the others with none', () => {
  const markup = rail();
  const groups = [...markup.matchAll(/data-action="toggle-group" data-group="([^"]+)"/g)].map(([, group]) => group);
  expect(groups).toEqual(['alpha', 'alpha/ticket-to-pr', 'beta', 'beta/review', 'beta/ticket-to-pr']);
  expect(markup).toContain(
    '<div class="wf-h"><button class="wf-t open" data-action="toggle-group" data-group="beta/ticket-to-pr"><span class="caret">›</span><span class="nm">ticket-to-pr</span></button><button class="qbadge warn" title="polled 7d ago" data-action="select-queue" data-queue="beta/ticket-to-pr">1 queued</button><span class="counts"><span class="r">▶ 1</span><span>1</span></span></div>',
  );
  expect(markup).toContain(
    '<div class="wf-h"><button class="wf-t open" data-action="toggle-group" data-group="alpha/ticket-to-pr"><span class="caret">›</span><span class="nm">ticket-to-pr</span></button><span class="counts"><span class="f">✗ 1</span><span>2</span></span></div>',
  );
  expect(markup.match(/class="qbadge/g)).toHaveLength(1);
  const idle = renderRail(handMade([{}], 0), { ...initialUi(0), expanded: ['gamma', 'gamma/flow'] }, NOW).value;
  expect(idle).toContain(
    '<button class="qbadge idle" data-action="select-queue" data-queue="gamma/flow">queue</button>',
  );
  const open = rail({ queue: 'beta/ticket-to-pr' });
  expect(open).toContain('<button class="qbadge warn sel" title="polled 7d ago"');
});

test('an open workflow lists no live run and its history line toggles its failed and completed runs as one-line rows', () => {
  const markup = rail();
  expect(markup).toContain(
    '<div class="hist"><button class="hist-t" data-action="toggle-section" data-section="alpha/ticket-to-pr:failed">✗ 1 failed</button><button class="hist-t" data-action="toggle-section" data-section="alpha/ticket-to-pr:completed">✓ 1 done ›</button></div>',
  );
  expect(markup).not.toContain('class="hist-t" data-action="toggle-section" data-section="beta/ticket-to-pr');
  expect([shown(markup), markup.includes('hist-run')]).toEqual([[], false]);
  expect(markup.slice(markup.indexOf('data-group="beta/ticket-to-pr"'))).not.toContain('class="run');
  const failed = rail({ open: ['alpha/ticket-to-pr:failed'] });
  expect(shown(failed)).toEqual([`alpha ${FAKE_2_ID}`]);
  expect(failed).toContain(
    '<button class="hist-t open" data-action="toggle-section" data-section="alpha/ticket-to-pr:failed">',
  );
  expect(shown(rail({ open: ['alpha/ticket-to-pr:failed', 'alpha/ticket-to-pr:completed'] }))).toEqual([
    `alpha ${FAKE_2_ID}`,
    `alpha ${GOLDEN_RUN_ID}`,
  ]);
  expect(failed).toContain(
    `title="$0.36" data-action="select-run" data-repo="alpha" data-run="${FAKE_2_ID}">\n<span class="st p-fail"></span><span class="r-id">FAKE-2</span>`,
  );
  expect(failed).toContain('<span class="r-el">4.9s</span></button>');
});

test('the run states map to the pill colours the rail draws', () => {
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
});

test('the tree starts folded: repository headers only, with no workflow header and no history row', () => {
  const markup = folded();
  expect(markup).toContain('<button class="lgrp-h" title="https://example.com/alpha.git"');
  expect(markup).toContain('<button class="lgrp-h" title="https://example.com/beta.git"');
  for (const absent of ['wf-t', 'class="hist', 'hist-run']) expect(markup).not.toContain(absent);
  const groups = [...markup.matchAll(/data-action="toggle-group" data-group="([^"]+)"/g)].map(([, group]) => group);
  expect(groups).toEqual(['alpha', 'beta']);
});

test('only the expanded repositories and workflows open, and the others stay folded', () => {
  const markup = folded({ expanded: ['alpha'] });
  expect(markup).toContain('<button class="wf-t" data-action="toggle-group" data-group="alpha/ticket-to-pr">');
  expect(markup).not.toContain('class="hist"');
  expect(markup).not.toContain('data-group="beta/');
  expect(folded({ expanded: ['alpha', 'alpha/ticket-to-pr'] })).toContain('class="hist"');
});

test('the selected run and the selected queue stay visible while folded', () => {
  const golden = { repo: 'alpha', runId: GOLDEN_RUN_ID };
  expect(shown(folded(golden))).toEqual([`alpha ${GOLDEN_RUN_ID} *`]);
  expect(shown(folded({ ...golden, expanded: ['alpha'] }))).toEqual([`alpha ${GOLDEN_RUN_ID} *`]);
  const queued = folded({ repo: 'beta', runId: FAKE_3_ID, queue: 'beta/ticket-to-pr' });
  expect(queued).toContain('<button class="wf-t" data-action="toggle-group" data-group="beta/ticket-to-pr">');
  expect(queued).toContain('<button class="qbadge warn sel" title="polled 7d ago"');
  expect(queued).not.toContain('data-group="beta/review"');
  const live = folded({ repo: 'beta', runId: FAKE_3_ID });
  expect(live).not.toContain('data-group="beta/ticket-to-pr"');
  expect(live).toContain('class="run live-run sel"');
});

const liveRows = (markup: string) =>
  [
    ...markup.matchAll(
      /<button class="run live-run( sel)?"[^>]*data-action="select-run" data-repo="(\w+)" data-run="([\w-]+)"/g,
    ),
  ].map(([, sel, repo, run]) => `${repo} ${run}${sel ? ' *' : ''}`);

test('under a folded repository the open queue’s workflow header opens and folds like any other', () => {
  const repos = handMade([{ status: 'failed' }], 1);
  const ui = { ...initialUi(0), queue: 'gamma/flow' };
  const shut = renderRail(repos, ui, NOW).value;
  expect(shut).toContain('<button class="wf-t" data-action="toggle-group" data-group="gamma/flow">');
  expect(shut).not.toContain('class="hist"');
  const opened = renderRail(repos, { ...ui, expanded: ['gamma/flow'] }, NOW).value;
  expect(opened).toContain('<button class="wf-t open" data-action="toggle-group" data-group="gamma/flow">');
  expect(opened).toContain('data-section="gamma/flow:failed">✗ 1 failed</button>');
});

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
