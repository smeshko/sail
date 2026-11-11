// The run view, drawn from the run model and the summary the index carries: the header, the totals against the
// budget, one stage card per call grouped by loop iteration, the pending cards, the PR and the
// CLI commands. The status bar line is drawn from the same model.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CleanOffer, RestartOffer, ResumeOffer, StopOffer } from '../../../src/dashboard/actions';
import { ACTIONS } from '../../../src/dashboard/page/action-registry';
import { foldRun } from '../../../src/dashboard/page/run-model';
import { commandList, renderRun, renderStatus, runControls } from '../../../src/dashboard/page/run-view';
import { initialUi } from '../../../src/dashboard/page/ui-state';
import { readEvents } from '../../../src/events/consumers/ndjson';
import { type Summary, summarize } from '../../../src/events/summary';
import { DASHBOARD_FIXTURES, FAKE_2_ID, FAKE_3_ID, GOLDEN_RUN, GOLDEN_RUN_ID } from '../../helpers/dashboard';
import { FAKE_4_ID, REVIEW_KEYS } from '../../helpers/review-fixture';

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

describe('audit 2: rows say what they are (ADW-543)', () => {
  const PROBLEM = '/tmp/x/beta/.sail-runs/r/summary.json is not a sail.summary.v1';

  test("a run that can't be read says so under its view header, with why and the Rebuild it offers", () => {
    const model = foldRun(readEvents(FAKE_3));
    const offers = { rebuild: { enabled: true, problem: PROBLEM } };
    const markup = renderRun(model, summaryOf(FAKE_3), initialUi(0), NOW, offers, PROBLEM).value;
    expect(markup).toContain(
      `<div class="d-problem"><div class="d-problem-t"><b>this run can't be read</b><span class="act"><button class="btn" data-action="rebuild-run">rebuild</button></span></div><div class="d-problem-w" title="${PROBLEM}">.sail-runs/r/summary.json is not a sail.summary.v1</div></div>`,
    );
    const unread = renderRun(model, summaryOf(FAKE_3), initialUi(0), NOW, undefined, PROBLEM).value;
    expect(unread).toContain("<b>this run can't be read</b></div>");
    expect(renderRun(model, summaryOf(FAKE_3), initialUi(0), NOW, offers).value).not.toContain('d-problem');
  });

  test('a stop reason is an amber chip on a suspended run and a red pill only on a failed one', () => {
    expect(renderRun(foldRun(readEvents(FAKE_3)), summaryOf(FAKE_3), initialUi(0), NOW).value).toContain(
      '<span class="warnchip">budget_exceeded</span>',
    );
    expect(renderRun(foldRun(readEvents(FAKE_2)), summaryOf(FAKE_2), initialUi(0), NOW).value).toContain(
      '<span class="pill p-fail">stage_error</span>',
    );
  });

  test('a pending card is drawn with a dashed border and colours, never faded with opacity', () => {
    const html = readFileSync(join(PAGE, 'index.html'), 'utf8');
    const rule = (selector: string) =>
      new RegExp(`\\n\\s*${selector.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`).exec(html)?.[1] ?? '';
    expect(rule('.card.pending')).toContain('border-style: dashed');
    expect(rule('.card.pending')).not.toContain('opacity');
    expect(html).not.toMatch(/\.qrow2\.done \{[^}]*opacity/);
  });
});

test("the golden run's eight cards are grouped: intake and spec, then fix's iteration 1 and iteration 2, then publish", () => {
  const markup = renderRun(foldRun(readEvents(GOLDEN_RUN)), summaryOf(GOLDEN_RUN), initialUi(0), NOW).value;
  expect(groups(markup)).toEqual([
    '-: intake#1 spec#1',
    'fix · iteration 1 of 3: implement#1 tests#1',
    'fix · iteration 2 of 3: implement#2 tests#2 self-review#1',
    '-: publish#1',
  ]);
  expect(markup).toContain('<span class="pill p-fail">failed</span>');
  expect(markup.match(/data-action="select-card"/g)?.length).toBe(8);
});

test('the golden run view shows $1.35 of its $25.00 budget, its PR and sail show, and no loop or route chips', () => {
  const markup = renderRun(foldRun(readEvents(GOLDEN_RUN)), summaryOf(GOLDEN_RUN), initialUi(0), NOW).value;
  expect(markup).not.toContain('loopbadge');
  expect(markup).not.toContain('class="route');
  expect(markup).toContain('<div class="stat"><b>$1.35</b><span>of $25.00 (5.4%)</span></div>');
  expect(markup).toContain('<div class="stat"><b>16.6s</b><span>of 90 min</span></div>');
  expect(markup).toContain('<div class="stat"><b>8/8</b><span>calls settled</span></div>');
  expect(markup).toContain(
    `<code>sail show ${GOLDEN_RUN_ID}</code><button class="btn" data-action="copy" data-text="sail show ${GOLDEN_RUN_ID}">copy</button>`,
  );
  expect(markup).toContain('<span class="lnk">#5</span>');
  expect(markup).not.toContain('sail resume');
});

test('a card and a pending card show the effort after the model when one is set, and the model alone when none is', () => {
  const events = readEvents(GOLDEN_RUN);
  const start = events.find((event) => event.type === 'stage:start' && event.key === 'spec#1');
  const head = events[0] as { roster: { stages: Record<string, object> } };
  const roster = {
    ...head.roster,
    stages: { ...head.roster.stages, 'self-review': { ...head.roster.stages['self-review'], effort: 'max' } },
  };
  const draw = (...fed: unknown[]) => renderRun(foldRun(fed), summaryOf(GOLDEN_RUN), initialUi(0), NOW).value;
  const effort = draw({ ...head, roster }, { ...start, effort: 'medium' });
  expect(effort).toContain('<span class="c-model">claude-opus-5-5 · medium</span>');
  expect(effort).toContain('<span class="c-model">claude-opus-5-5 · max</span>');
  const plain = draw(head, start);
  expect(plain).toContain('<span class="c-model">claude-opus-5-5</span>');
  expect(plain).not.toContain(' · medium');
  expect(plain).not.toContain(' · max');
});

test("FAKE-3's view has a lint#1 card and a not called yet group of describe, open, self-review and tests, no resume command, and no page module names lint", () => {
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
  expect(markup).toContain(`<code>sail show ${FAKE_3_ID}</code>`);
  expect(markup).not.toContain('sail resume');
  const naming = readdirSync(PAGE).filter((file) => /\blint\b(?!\/)/.test(readFileSync(join(PAGE, file), 'utf8')));
  expect(naming).toEqual([]);
});

test('a running card shows running and its time so far, a PR link is drawn only for an http(s) URL, and the status line says live until the run ends', () => {
  const events = readEvents(GOLDEN_RUN);
  const until = events.findIndex((event) => event.type === 'stage:start' && event.key === 'tests#1');
  const model = foldRun(events.slice(0, until + 1));
  const started = Date.parse(events[until]?.ts ?? '');
  const ui = { ...initialUi(0), key: 'tests#1', cursor: 3 };
  const markup = renderRun(model, undefined, ui, started + 2500).value;
  expect(markup).toContain(
    '<div class="card cursor sel" role="button" tabindex="0" data-action="select-card" data-key="tests#1">',
  );
  expect(markup).toMatch(
    /data-key="tests#1">\n<div class="c-top"><span class="c-n">04<\/span><span class="c-name">tests#1<\/span><span class="pill p-run">running<\/span>/,
  );
  expect(markup).toContain(
    '<div class="facts"><div><b>2.5s</b><span class="lbl">duration</span></div><div><b>0</b><span class="lbl">tool calls</span></div></div>',
  );
  expect(markup).toContain('<span class="pill p-run">running</span><span class="d-agent">');
  expect(markup).toContain(`<code>sail show ${GOLDEN_RUN_ID} --follow</code>`);
  expect(renderStatus(model, undefined).value).toBe(
    '<span>calls <b>3/4</b></span><span>tools <b>0</b></span><span class="">denied <b>0</b></span><span title="tokens in, out and read from the cache">tokens <b>15.0k</b> in · <b>5.4k</b> out · <b>82.4k</b> cached</span><span>cost <b>$0.79</b></span><span class="spacer"></span><span>● live</span>',
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
    '<span>calls <b>3/3</b></span><span>tools <b>1</b></span><span class="w">denied <b>1</b></span><span title="tokens in, out and read from the cache">tokens <b>6.4k</b> in · <b>1.9k</b> out · <b>24.8k</b> cached</span><span>cost <b>$0.36</b></span><span class="spacer"></span><span>ended failed</span>',
  );
});

test("the footer shows the golden run's tokens from its summary once it has ended", () => {
  const model = foldRun(readEvents(GOLDEN_RUN));
  const summary = summaryOf(GOLDEN_RUN);
  expect(renderStatus(model, summary).value).toContain('tokens <b>28.4k</b> in · <b>9.0k</b> out · <b>189k</b> cached');
  const usage = { ...summary.totals.usage, inputTokens: 534, outputTokens: 12_600, cacheReadTokens: 13_000_000 };
  const final = { ...summary, totals: { ...summary.totals, usage } };
  expect(renderStatus(model, final).value).toContain('tokens <b>534</b> in · <b>12.6k</b> out · <b>13m</b> cached');
});

test("while a call runs, the footer's tokens count its live usage over a summary written before it", () => {
  const events = readEvents(GOLDEN_RUN);
  const journals = events.flatMap((event, at) => (event.type === 'journal:append' ? [at] : []));
  const journaled = journals[1] ?? -1;
  const live = events.findIndex((event, at) => at > journaled && event.type === 'usage:update');
  const stale = summarize(events.slice(0, journaled + 1));
  const slice = events.slice(0, live + 1);
  const current = renderStatus(foldRun(slice), stale).value;
  expect(current).toContain('tokens <b>7.2k</b> in · <b>2.2k</b> out · <b>31.2k</b> cached');
  expect(current).not.toContain('<b>5.2k</b> in');
});

test('while the run runs, its duration and cost tiles count from the cards over a summary written after an earlier call', () => {
  const events = readEvents(GOLDEN_RUN);
  const journals = events.flatMap((event, at) => (event.type === 'journal:append' ? [at] : []));
  const journaled = journals[1] ?? -1;
  const stale = summarize(events.slice(0, journaled + 1));
  const slice = events.slice(0, (journals[2] ?? -1) + 1);
  const tiles = (summary: Summary | undefined) =>
    renderRun(foldRun(slice), summary, initialUi(0), NOW).value.match(
      /<div class="stats totals">[\s\S]*?\n<\/div>/,
    )?.[0];
  expect(tiles(stale)).toBe(tiles(undefined));
  expect(renderStatus(foldRun(slice), stale).value).toBe(renderStatus(foldRun(slice), undefined).value);
});

const FAKE_4 = join(DASHBOARD_FIXTURES, 'beta', FAKE_4_ID);

test("a group's cards share one block headed run.all · 6 calls, side by side in its grid, the intake's card outside it, and while it runs the header counts its running calls", () => {
  const events = readEvents(FAKE_4);
  const markup = renderRun(foldRun(events), summaryOf(FAKE_4), initialUi(0), NOW).value;
  expect(groups(markup)).toEqual(['-: intake#1', `run.all · 6 calls: ${REVIEW_KEYS.join(' ')}`]);
  const firstEnd = events.findIndex((event) => event.type === 'stage:end' && event.key !== 'intake#1');
  const running = renderRun(foldRun(events.slice(0, firstEnd + 1)), undefined, initialUi(0), NOW).value;
  expect(groups(running)).toEqual(['-: intake#1', `run.all · 6 calls · 5 running: ${REVIEW_KEYS.join(' ')}`]);
});

test("a group inside a loop iteration is headed by the iteration and the group, and the iteration's other cards keep their own block", () => {
  const events = readEvents(FAKE_4);
  const at = events.findIndex((event) => event.type === 'all:start');
  const ts = events[at]?.ts ?? '';
  const looped = [
    ...events.slice(0, at),
    { seq: 900, ts, runId: FAKE_4_ID, type: 'loop:iteration', loop: 'rounds', iteration: 1, max: 2 },
    ...events.slice(at),
  ];
  const markup = renderRun(foldRun(looped), undefined, initialUi(0), NOW).value;
  expect(groups(markup)).toEqual([
    '-: intake#1',
    `rounds · iteration 1 of 2 · run.all · 6 calls: ${REVIEW_KEYS.join(' ')}`,
  ]);
});

/** A UI whose action state has these drafts typed. */
const act = (drafts: Record<string, Record<string, string>> = {}) => ({ act: { drafts } });

const SOURCE_RUN = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';
const RESUME_OFFER: ResumeOffer = {
  enabled: true,
  spentUsd: 1.0625,
  budget: { maxUsd: 1, maxMinutes: 90 },
  raise: 'usd',
};

test("a seeded run's header names the run it was seeded from, and an unseeded run's does not", () => {
  const events = readEvents(GOLDEN_RUN);
  const seeded = foldRun(
    events.map((event) => (event.type === 'run:start' ? { ...event, fromRun: SOURCE_RUN } : event)),
  );
  const header = (model: ReturnType<typeof foldRun>) =>
    /<span class="d-agent">([^<]*)<\/span>/.exec(renderRun(model, summaryOf(GOLDEN_RUN), initialUi(0), NOW).value)?.[1];
  expect([seeded.fromRun, header(seeded)]).toEqual([
    SOURCE_RUN,
    `${GOLDEN_RUN_ID} · ticket-to-pr@1 · seeded from ${SOURCE_RUN}`,
  ]);
  expect([foldRun(events).fromRun, header(foldRun(events))]).toEqual([undefined, `${GOLDEN_RUN_ID} · ticket-to-pr@1`]);
});

test('Resume shows one button reading resume and no raise field, and shows a disabled one with its reason', () => {
  const resume = RESUME_OFFER;
  const view = (ui: Partial<ReturnType<typeof initialUi>>, offers: Parameters<typeof runControls>[0]) =>
    runControls(offers, { ...initialUi(0), ...ui })?.value ?? '';
  const idle = view(act({ 'resume-run': { raise: '5' } }), { resume });
  expect(idle).toBe(
    '<div class="acts"><span class="act"><button class="btn" data-action="resume-run" title="resume (R)">resume</button><kbd>R</kbd></span></div>',
  );
  expect(idle).not.toContain('restart');
  expect(idle).not.toContain('armed');
  expect(view(act(), { resume: { ...resume, enabled: false, why: 'run is running' } })).toContain(
    '<span class="act"><button class="btn" disabled>resume</button><span class="act-why">run is running</span><kbd>R</kbd></span>',
  );
  expect(runControls(undefined, initialUi(0))).toBeUndefined();
  expect(runControls({ why: 'run completed' }, initialUi(0))).toBeUndefined();
});

test('Restart is one button and no stage choice, since the dialog asks the stage and names the budget', () => {
  const restart: RestartOffer = {
    enabled: true,
    stages: [
      { stage: 'spec', runsAgain: 'spec#1 and everything after it' },
      { stage: 'implement', runsAgain: 'implement#1 and everything after it, in loop fix from iteration 1' },
    ],
    stage: 'implement',
    budget: { maxUsd: 25, maxMinutes: 90 },
  };
  const view = (ui: Partial<ReturnType<typeof initialUi>>, offer = restart) =>
    runControls({ restart: offer }, { ...initialUi(0), ...ui })?.value;
  expect(view({})).toContain('<button class="btn" data-action="restart-run" title="restart (⇧R)">restart</button>');
  expect(view(act({ 'restart-run': { stage: 'spec' } }))).not.toContain('<select');
  expect(view({})).not.toContain('name="stage"');
  expect(view({}, { ...restart, budget: {} })).toContain('restart</button>');
  expect(view({}, { enabled: false, why: 'branch sail/x is leased by run FAKE-9', stages: [], budget: {} })).toContain(
    '<button class="btn" disabled>restart</button><span class="act-why">branch sail/x is leased by run FAKE-9</span>',
  );
});

test('Suspend and hold is drawn after stop and stop now when offered, and not when it is not', () => {
  const view = (offers: Parameters<typeof runControls>[0]) => runControls(offers, initialUi(0))?.value ?? '';
  const names = (markup: string) =>
    [...markup.matchAll(/data-action="([a-z-]+)"(?: title="[^"]*")?>/g)].map((each) => each[1]);
  expect(names(view({ stop: STOP, suspend: { enabled: true } }))).toEqual(['stop-run', 'stop-run-now', 'suspend-run']);
  expect(view({ stop: STOP, suspend: { enabled: true } })).toContain(
    'data-action="stop-run-now" title="stop now (⇧S)">stop now</button><kbd>⇧S</kbd></span><span class="act"><button class="btn" data-action="suspend-run">suspend and hold</button>',
  );
  expect(view({ stop: STOP })).not.toContain('suspend-run');
});

test('Stop shows two buttons, stop and stop now, and no box, and a disabled one gives its reason', () => {
  const view = (ui: Partial<ReturnType<typeof initialUi>>, stop: StopOffer = { enabled: true }) =>
    runControls({ stop }, { ...initialUi(0), ...ui })?.value;
  expect(view({})).toContain(
    '<span class="act"><button class="btn" data-action="stop-run" title="stop (S)">stop</button><kbd>S</kbd></span><span class="act"><button class="btn" data-action="stop-run-now" title="stop now (⇧S)">stop now</button><kbd>⇧S</kbd></span>',
  );
  expect(view({})).not.toContain('type="checkbox"');
  expect(view({}, { enabled: false, why: 'run is not running' })).toContain(
    '<button class="btn" disabled>stop</button><span class="act-why">run is not running</span>',
  );
});

test('Clean sits beside Restart, reads clean whatever it removes, and a disabled one gives its reason', () => {
  const clean: CleanOffer = {
    enabled: true,
    removes: ['worktree', 'branch sail/x', 'run ref'],
    archive: '~/.sail/failed-runs/2026-11-01/FAKE-2',
  };
  const restart: RestartOffer = { enabled: true, stages: [], stage: 'implement', budget: { maxUsd: 25 } };
  const view = (ui: Partial<ReturnType<typeof initialUi>>, offer: CleanOffer = clean) =>
    runControls({ restart, clean: offer }, { ...initialUi(0), ...ui })?.value;
  const idle = view({});
  expect(idle).toContain(
    'data-action="restart-run" title="restart (⇧R)">restart</button><kbd>⇧R</kbd></span><span class="act"><button class="btn" data-action="clean-run" title="clean (⌫)">clean</button><kbd>⌫</kbd></span>',
  );
  expect(idle).not.toContain('armed');
  expect(idle).not.toContain('confirm');
  expect(view({}, { enabled: false, removes: [], why: 'a queue item names it' })).toContain(
    '<button class="btn" disabled>clean</button><span class="act-why">a queue item names it</span>',
  );
});

test('a called card is a focusable button and a pending card is neither', () => {
  const golden = renderRun(foldRun(readEvents(GOLDEN_RUN)), summaryOf(GOLDEN_RUN), initialUi(0), NOW).value;
  expect(golden.match(/role="button" tabindex="0" data-action="select-card"/g)?.length).toBe(8);
  const beta = renderRun(foldRun(readEvents(FAKE_3)), summaryOf(FAKE_3), initialUi(0), NOW).value;
  expect(beta.match(/role="button" tabindex="0" data-action="select-card"/g)?.length).toBe(4);
  const pending = beta.match(/<div class="card pending"[^>]*>/g) ?? [];
  expect(pending.length).toBe(4);
  for (const tag of pending) expect(tag).toBe('<div class="card pending">');
});

// The run header's actions: the buttons of the run's status and a ⋯ for the rest, from the registry (ADW-516).
const HEADER_UI = { repo: 'alpha', runId: FAKE_2_ID };
const STOP: StopOffer = { enabled: true };
const RESTART: RestartOffer = { enabled: true, stages: [], stage: 'implement', budget: { maxUsd: 25 } };
const CLEAN: CleanOffer = { enabled: true, removes: ['worktree'], archive: '~/.sail/failed-runs/x' };
const runningModel = () => foldRun(readEvents(GOLDEN_RUN).filter((event) => event.type !== 'run:end'));
const header = (
  model: ReturnType<typeof foldRun>,
  offers: Parameters<typeof runControls>[0],
  ui: Partial<ReturnType<typeof initialUi>> = {},
) => {
  const markup = renderRun(model, null, { ...initialUi(0), ...HEADER_UI, ...ui }, NOW, offers).value;
  return markup.slice(0, markup.indexOf('<div class="run-b">'));
};
const MORE = 'data-action="run-menu" data-at="header"';

test("a running run's header holds stop, and its disabled resume and restart only once the header's ⋯ is open, each with its reason", () => {
  const offers = {
    stop: STOP,
    resume: { ...RESUME_OFFER, enabled: false, why: 'run is running' },
    restart: { ...RESTART, enabled: false, why: 'run is running' },
  };
  const running = runningModel();
  const closed = header(running, offers);
  expect(closed).toContain('<button class="btn" data-action="stop-run" title="stop (S)">stop</button>');
  expect(closed).toContain(MORE);
  expect(closed).not.toContain('resume');
  const open = header(running, offers, { runMenu: { runId: running.runId ?? '', at: 'header' } });
  expect(open).toContain('<div class="h-menu">');
  expect(open).toContain('<button class="btn" disabled>resume</button><span class="act-why">run is running</span>');
  expect(open).toContain('<button class="btn" disabled>restart</button><span class="act-why">run is running</span>');
  expect(open).toContain('aria-expanded="true"');
  expect(closed).not.toContain('suspend-run');
  const suspendable = { ...offers, suspend: { enabled: true } };
  expect(header(running, suspendable)).not.toContain('suspend-run');
  expect(header(running, suspendable, { runMenu: { runId: running.runId ?? '', at: 'header' } })).toContain(
    'data-action="suspend-run">suspend and hold</button>',
  );
});

test("a suspended run's header holds resume as a button and stop in the ⋯ menu", () => {
  const model = foldRun(readEvents(FAKE_3));
  const offers = { resume: RESUME_OFFER, stop: STOP };
  const closed = header(model, offers);
  expect(closed).toContain('data-action="resume-run" title="resume (R)">resume</button>');
  expect(closed).not.toContain('stop-run');
  expect(closed).toContain(MORE);
  const open = header(model, offers, { runMenu: { runId: model.runId ?? '', at: 'header' } });
  expect(open).toContain(
    '<div class="h-menu"><div class="acts"><span class="act"><button class="btn" data-action="stop-run" title="stop (S)">stop</button>',
  );
  expect(open).toContain('data-action="stop-run-now" title="stop now (⇧S)">stop now</button>');
});

test("a failed run's header holds restart and clean, and no ⋯", () => {
  const markup = header(foldRun(readEvents(FAKE_2)), { restart: RESTART, clean: CLEAN });
  expect(markup).toContain('data-action="restart-run" title="restart (⇧R)">restart</button>');
  expect(markup).toContain('data-action="clean-run" title="clean (⌫)">clean</button>');
  expect(markup).not.toContain(MORE);
});

test('a failed run whose restart is refused shows it disabled in the header, with its reason', () => {
  const markup = header(foldRun(readEvents(FAKE_2)), {
    restart: { ...RESTART, enabled: false, why: 'branch sail/x is leased by run FAKE-9' },
    clean: CLEAN,
  });
  expect(markup).toContain(
    '<button class="btn" disabled>restart</button><span class="act-why">branch sail/x is leased by run FAKE-9</span>',
  );
});

test('a completed run, offers that offer nothing and offers not read yet draw no button and no ⋯ in the header', () => {
  const done = foldRun(readEvents(GOLDEN_RUN));
  for (const offers of [{ why: 'run completed' }, undefined]) {
    const markup = header(done, offers);
    expect(markup).not.toContain('h-acts');
    expect(markup).not.toContain(MORE);
  }
  expect(header(foldRun(readEvents(FAKE_2)), undefined)).not.toContain('restart');
});

test("the header's actions yield to an open row menu, so no action is drawn twice", () => {
  const offers = { stop: STOP, resume: RESUME_OFFER };
  const model = foldRun(readEvents(FAKE_3));
  const ui = { ...initialUi(0), ...HEADER_UI, runMenu: { runId: FAKE_2_ID, at: 'row' as const } };
  const markup = renderRun(model, null, ui, NOW, offers).value;
  expect(markup).not.toContain('data-action="resume-run"');
  expect(markup).not.toContain(MORE);
  const row = runControls(offers, ui)?.value ?? '';
  expect(`${markup}${row}`.match(/data-action="resume-run"/g)).toHaveLength(1);
  expect(`${markup}${row}`.match(/data-action="stop-run"/g)).toHaveLength(1);
});

test('runControls draws only the actions it is given, and none when none is offered', () => {
  const stopOnly = ACTIONS.filter((def) => def.id === 'stop-run');
  const offers = { stop: STOP, resume: RESUME_OFFER };
  const drawn = runControls(offers, initialUi(0), stopOnly)?.value ?? '';
  expect(drawn).toContain('stop-run');
  expect(drawn).not.toContain('resume');
  expect(runControls({ resume: RESUME_OFFER }, initialUi(0), stopOnly)).toBeUndefined();
});

test('commandList labels the copied command copied or copy failed and every other copy, keeping its attributes', () => {
  const commands = [
    { label: 'show', command: 'sail show X' },
    { label: 'stop', command: 'sail stop X' },
  ];
  const button = (command: string, label: string) =>
    `<button class="btn" data-action="copy" data-text="${command}">${label}</button>`;
  expect(commandList(commands).value).toContain(button('sail show X', 'copy'));
  expect(commandList(commands).value).not.toContain('copied');
  const took = commandList(commands, { text: 'sail show X', ok: true }).value;
  expect([took.includes(button('sail show X', 'copied')), took.includes(button('sail stop X', 'copy'))]).toEqual([
    true,
    true,
  ]);
  const refused = commandList(commands, { text: 'sail show X', ok: false }).value;
  expect(refused).toContain(button('sail show X', 'copy failed'));
  expect(refused).toContain(button('sail stop X', 'copy'));
});
