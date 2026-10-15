// The run view, drawn from the run model and the summary the index carries: the header, the totals against the
// budget, the loops and routes, one stage card per call grouped by loop iteration, the pending cards, the PR and the
// CLI commands. The status bar line is drawn from the same model.
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { foldRun } from '../../../src/dashboard/page/run-model';
import { renderRun, renderStatus } from '../../../src/dashboard/page/run-view';
import { initialUi } from '../../../src/dashboard/page/ui-state';
import { readEvents } from '../../../src/events/consumers/ndjson';
import type { Summary } from '../../../src/events/summary';
import { DASHBOARD_FIXTURES, FAKE_2_ID, FAKE_3_ID, GOLDEN_RUN, GOLDEN_RUN_ID } from '../../helpers/dashboard';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const summaryOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as Summary;
const FAKE_2 = join(DASHBOARD_FIXTURES, 'alpha', FAKE_2_ID);
const FAKE_3 = join(DASHBOARD_FIXTURES, 'beta', FAKE_3_ID);
const PAGE = join(import.meta.dir, '..', '..', '..', 'src', 'dashboard', 'page');

/** The run view's groups in order: each header, or `-`, with the keys of its cards, and a pending card's stage. */
function groups(markup: string): string[] {
  return markup
    .split('<div class="cgrp">')
    .slice(1)
    .map((group) => {
      const header = /^<div class="grp-t">([^<]*)<\/div>/.exec(group)?.[1] ?? '-';
      const keys = [...group.matchAll(/data-key="([^"]+)"/g)].map(([, key]) => key);
      const pending = [
        ...group.matchAll(/<div class="card pending"><div class="c-top"><span class="c-name">([^<]+)</g),
      ].map(([, stage]) => stage);
      return `${header}: ${[...keys, ...pending].join(' ')}`;
    });
}

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ("the golden run's nine cards are grouped: intake and spec, then fix's iteration 1 and iteration 2, then describe and open", () => {
  const markup = renderRun(foldRun(readEvents(GOLDEN_RUN)), summaryOf(GOLDEN_RUN), initialUi(0), NOW).value;
  expect(groups(markup)).toEqual([
    '-: intake#1 spec#1',
    'fix · iteration 1 of 3: implement#1 tests#1',
    'fix · iteration 2 of 3: implement#2 tests#2 self-review#1',
    '-: describe#1 open#1',
  ]);
  expect(markup).toContain('<span class="pill p-fail">failed</span>');
  expect(markup.match(/data-action="select-card"/g)?.length).toBe(9);
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('the golden run view shows its loop, its eight routes, $1.35 of its $25.00 budget, its PR and sail show', () => {
  const markup = renderRun(foldRun(readEvents(GOLDEN_RUN)), summaryOf(GOLDEN_RUN), initialUi(0), NOW).value;
  expect(markup).toContain('<span class="loopbadge">fix: 2/3 · break</span>');
  expect([...markup.matchAll(/<span class="route">([^<]+)<\/span>/g)].map(([, route]) => route)).toEqual([
    'spec#1 done → implement#1',
    'implement#1 done → tests#1',
    'tests#1 failed → implement#2',
    'implement#2 done → tests#2',
    'tests#2 passed → self-review#1',
    'self-review#1 done → describe#1',
    'describe#1 done → open#1',
    'open#1 passed → end',
  ]);
  expect(markup).toContain('<div class="stat"><b>$1.35</b><span>of $25.00 (5.4%)</span></div>');
  expect(markup).toContain('<div class="stat"><b>15.9s</b><span>of 90m</span></div>');
  expect(markup).toContain('<div class="stat"><b>9/9</b><span>calls settled</span></div>');
  expect(markup).toContain(
    `<code>sail show ${GOLDEN_RUN_ID}</code><button class="btn" data-action="copy" data-text="sail show ${GOLDEN_RUN_ID}">copy</button>`,
  );
  expect(markup).toContain('<span class="lnk">#5</span>');
  expect(markup).not.toContain('sail resume');
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ("FAKE-3's view has a lint#1 card and a not called yet group of describe, open, self-review and tests, its resume command, and no page module names lint", () => {
  const markup = renderRun(foldRun(readEvents(FAKE_3)), summaryOf(FAKE_3), initialUi(0), NOW).value;
  expect(groups(markup)).toEqual([
    '-: intake#1 spec#1 lint#1',
    'fix · iteration 1 of 3: implement#1',
    'not called yet: describe open self-review tests',
  ]);
  expect(markup).toContain(
    '<span class="d-title">FAKE-3</span> <span class="lnk">Escape &lt;b&gt;this&lt;/b&gt; &amp; &quot;that&quot;</span>',
  );
  expect(markup).toContain('<span class="warnchip">budget_exceeded</span>');
  expect(markup).toContain('<div class="stat"><b>$1.06</b><span>of $1.00 (106.3%)</span></div>');
  expect(markup).toContain(`<code>sail resume ${FAKE_3_ID}</code>`);
  const naming = readdirSync(PAGE).filter((file) => /\blint\b(?!\/)/.test(readFileSync(join(PAGE, file), 'utf8')));
  expect(naming).toEqual([]);
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('a running card shows running and its time so far, a PR link is drawn only for an http(s) URL, and the status line says live until the run ends', () => {
  const events = readEvents(GOLDEN_RUN);
  const until = events.findIndex((event) => event.type === 'stage:start' && event.key === 'tests#1');
  const model = foldRun(events.slice(0, until + 1));
  const started = Date.parse(events[until]?.ts ?? '');
  const ui = { ...initialUi(0), key: 'tests#1', cursor: 3 };
  const markup = renderRun(model, undefined, ui, started + 2500).value;
  expect(markup).toContain('<div class="card cursor sel" data-action="select-card" data-key="tests#1">');
  expect(markup).toMatch(
    /data-key="tests#1">\n<div class="c-top"><span class="c-n">04<\/span><span class="c-name">tests#1<\/span><span class="pill p-run">running<\/span>/,
  );
  expect(markup).toContain('<div class="facts"><div><b>2.5s</b>');
  expect(markup).toContain('<span class="pill p-run">running</span><span class="d-agent">');
  expect(markup).toContain(`<code>sail show ${GOLDEN_RUN_ID} --follow</code>`);
  expect(renderStatus(model, undefined).value).toBe(
    '<span>calls <b>3/4</b></span><span>tools <b>0</b></span><span class="">denied <b>0</b></span><span>cost <b>$0.79</b></span><span class="spacer"></span><span>● live</span>',
  );
  const at = { seq: 900, ts: events[until]?.ts ?? '', runId: 'x', key: 'tests#1/lint' };
  const stepped = foldRun([
    ...events.slice(0, until + 1),
    { ...at, type: 'step:start', stage: 'tests', step: 'lint', index: 1, of: 2, kind: 'script' },
    { ...at, type: 'step:end', step: 'lint', outcome: 'passed', resultPath: 'x/result.json' },
    { ...at, type: 'step:start', stage: 'tests', step: 'unit', index: 2, of: 2, kind: 'script' },
  ]);
  expect(renderRun(stepped, undefined, ui, started).value).toContain(
    '<div class="c-steps"><span class="pill p-pass">lint</span><span class="pill p-run">unit</span></div>',
  );
  const linked = { ...foldRun(events), pr: { number: 7, url: 'https://example.com/pull/7' } };
  expect(renderRun(linked, undefined, ui, NOW).value).toContain(
    '<a class="lnk" href="https://example.com/pull/7" rel="noreferrer" target="_blank">#7</a>',
  );
  expect(renderStatus(foldRun(readEvents(FAKE_2)), summaryOf(FAKE_2)).value).toBe(
    '<span>calls <b>3/3</b></span><span>tools <b>1</b></span><span class="w">denied <b>1</b></span><span>cost <b>$0.36</b></span><span class="spacer"></span><span>ended failed</span>',
  );
});
