// The rail, drawn from the index model: each repository with its runs, finished runs folded into a counted completed
// section that opens when asked or when it holds the open run, and every run a delegated `select-run` action.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { index } from '../../../src/dashboard/files';
import { railRepos } from '../../../src/dashboard/page/index-model';
import { renderRail } from '../../../src/dashboard/page/rail-view';
import { initialUi, pillOf } from '../../../src/dashboard/page/ui-state';
import { FAKE_2_ID, FAKE_3_ID, GOLDEN_RUN_ID, type Machine, seedFixtures } from '../../helpers/dashboard';

let m: Machine;
beforeEach(() => {
  m = seedFixtures();
});
afterEach(() => m.remove());

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const rail = (fields = {}) => renderRail(railRepos(index(m.registryDir), NOW), { ...initialUi(0), ...fields }).value;
/** The runs the rail shows, in order, each marked when selected. */
const shown = (markup: string) =>
  [
    ...markup.matchAll(/<button class="run( sel)?" data-action="select-run" data-repo="(\w+)" data-run="([\w-]+)">/g),
  ].map(([, sel, repo, run]) => `${repo} ${run}${sel ? ' *' : ''}`);

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ("the rail shows alpha's FAKE-2, its completed section open on the selected golden run, and beta's FAKE-3 suspended on budget_exceeded with its title escaped", () => {
  const markup = rail({ repo: 'alpha', runId: GOLDEN_RUN_ID });
  expect(shown(markup)).toEqual([`alpha ${FAKE_2_ID}`, `alpha ${GOLDEN_RUN_ID} *`, `beta ${FAKE_3_ID}`]);
  expect(markup).toContain('<span class="nm">alpha</span>');
  expect(markup).toContain('<div class="lgrp-r">https://example.com/beta.git</div>');
  expect(markup).toContain(
    '<button class="subgrp-h open" data-action="toggle-section" data-section="alpha:completed"><span class="caret">›</span><span class="sw p-pass"></span><span>completed</span><span class="n">1</span></button>',
  );
  expect(markup).toContain(
    '<span class="r-title">Escape &lt;b&gt;this&lt;/b&gt; &amp; &quot;that&quot;</span><span class="r-sub">suspended · <span class="why">budget_exceeded</span> · 6.2s · $1.06</span>',
  );
  expect(markup).toContain('failed · <span class="why">stage_error</span> · 4.9s · $0.36');
  expect(markup).toContain('<div class="rail-h"><span>repositories</span><span class="c">3 runs</span></div>');
});

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('the completed section stays closed unless it is opened or holds the selection', () => {
  expect(shown(rail())).toEqual([`alpha ${FAKE_2_ID}`, `beta ${FAKE_3_ID}`]);
  expect(rail()).toContain('<button class="subgrp-h" data-action="toggle-section" data-section="alpha:completed">');
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
  expect(shown(rail({ open: ['alpha:completed'] }))).toEqual([
    `alpha ${FAKE_2_ID}`,
    `alpha ${GOLDEN_RUN_ID}`,
    `beta ${FAKE_3_ID}`,
  ]);
});
