// The inspector, drawn for one call from the run's own files: the card from its events, the roster from `run:start`,
// and the call's `result.json` and log. Each tab is checked against a fixture whose answer is known.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { renderInspector } from '../../../src/dashboard/page/inspector-view';
import { foldRun } from '../../../src/dashboard/page/run-model';
import { type InspectorTab, initialUi } from '../../../src/dashboard/page/ui-state';
import { readEvents } from '../../../src/events/consumers/ndjson';
import { DASHBOARD_FIXTURES, FAKE_2_ID, GOLDEN_RUN } from '../../helpers/dashboard';

const FAKE_2 = join(DASHBOARD_FIXTURES, 'alpha', FAKE_2_ID);

/** The inspector of `key` in the run at `dir`, on `tab`, fed only that run's events, roster and result. */
function inspect(dir: string, key: string, tab: InspectorTab, log?: string) {
  const model = foldRun(readEvents(dir));
  const card = model.cards.find((entry) => entry.key === key);
  expect([card?.key, typeof card?.resultPath]).toEqual([key, 'string']);
  const resultPath = card?.resultPath ?? '';
  const value = JSON.parse(readFileSync(join(dir, resultPath), 'utf8'));
  const text =
    log === undefined
      ? undefined
      : { state: 'loaded' as const, value: readFileSync(join(dir, dirname(resultPath), log), 'utf8') };
  return renderInspector(card, model.roster, { state: 'loaded', value }, text, { ...initialUi(0), key, tab }).value;
}

test("the permissions tab explains FAKE-2's denial from its events, roster and result alone: the command, the rule, the step's commands and the reason", () => {
  const markup = inspect(FAKE_2, 'implement#1', 'permissions');
  expect(markup).toContain(
    '<div class="grp"><div class="grp-t">commands</div><ul class="polylist"><li>bun test*</li><li>git add *</li><li>git commit *</li><li>git diff *</li></ul></div>',
  );
  expect(markup).toContain(
    '<div class="grp-t">denials · 1</div><div class="mini deny"><div class="mini-h">denied · 10:00:04</div>',
  );
  expect(markup).toContain(
    '<dt>tool</dt><dd>Bash</dd>\n<dt>command</dt><dd><code>git push --force origin HEAD</code></dd>\n<dt>rule</dt><dd>commands</dd>',
  );
  expect(markup).toContain(
    '<dt>allowed</dt><dd><ul class="polylist"><li>bun test*</li><li>git add *</li><li>git commit *</li><li>git diff *</li></ul></dd>',
  );
  expect(markup).toContain(
    '<dt>reason</dt><dd>default deny: git push --force — a forced push rewrites what others have: `git push --force origin HEAD`</dd>',
  );
  expect(markup).toContain('<dt>maxTurns</dt><dd>60</dd><dt>maxUsd</dt><dd>5</dd><dt>maxMinutes</dt><dd>20</dd>');
  expect(markup).toContain('<button class="tab on" data-action="tab" data-tab="permissions">permissions</button>');
  const quiet = inspect(GOLDEN_RUN, 'spec#1', 'permissions');
  expect(quiet).toContain('<div class="grp-t">denials · 0</div><div class="code">No denials</div>');
});

test("the files tab lists the golden implement#2's diff.patch with its bytes and a sha256 prefix, the whole hash in its title", () => {
  expect(inspect(GOLDEN_RUN, 'implement#2', 'files')).toContain(
    '<div class="grp-t">files · 1</div><div class="art"><span class="ic">▤</span><span><b>diff.patch</b><span class="d">02-implement/call-2/diff.patch · 613 bytes · <span class="sha" title="2a10783a63a95398d9ab4bace6f0919d15d15ab03637579579b192693547ea25">2a10783a63a9</span></span></span></div>',
  );
  expect(inspect(FAKE_2, 'implement#1', 'files')).toContain('<div class="code">this call produced no files</div>');
  const events = readEvents(GOLDEN_RUN);
  const end = events.findIndex((event) => event.type === 'stage:end' && event.key === 'implement#2');
  const at = { seq: 900, ts: events[end]?.ts ?? '', runId: 'x', key: 'implement#2' };
  const checked = foldRun([
    ...events.slice(0, end),
    {
      ...at,
      type: 'file:validated',
      name: 'diff.patch',
      ok: false,
      checks: ['the patch applies', 'it touches <src/>'],
    },
  ]);
  const card = checked.cards.find((entry) => entry.key === 'implement#2');
  const tab = renderInspector(card, checked.roster, { state: 'loading' }, undefined, { ...initialUi(0), tab: 'files' });
  expect(tab.value).toContain(
    '613 bytes · <span class="sha" title="2a10783a63a95398d9ab4bace6f0919d15d15ab03637579579b192693547ea25">2a10783a63a9</span></span></span><span class="pill p-fail">invalid</span></div><ul class="polylist"><li>the patch applies</li><li>it touches &lt;src/&gt;</li></ul>',
  );
});

test("the log tab shows tests#1's stdout escaped, with stdout and stderr to choose, and says loading, or no log, when there is none", () => {
  const markup = inspect(GOLDEN_RUN, 'tests#1', 'log', 'stdout.log');
  expect(markup).toContain(
    '<div class="logbar"><button class="tog on" data-action="stream" data-stream="stdout">stdout</button><button class="tog" data-action="stream" data-stream="stderr">stderr</button></div><pre class="code log">bun test v1.3.14\n5 pass\n1 fail\n(fail) greet --shout › uppercases the name\n{&quot;ok&quot;:false,',
  );
  const model = foldRun(readEvents(GOLDEN_RUN));
  const card = (key: string) => model.cards.find((entry) => entry.key === key);
  const ui = { ...initialUi(0), tab: 'log' as const, stream: 'stderr' };
  const loading = renderInspector(card('tests#1'), model.roster, undefined, { state: 'loading' }, ui).value;
  expect(loading).toContain(
    '<button class="tog on" data-action="stream" data-stream="stderr">stderr</button></div><div class="code">loading…</div>',
  );
  const missing = renderInspector(card('spec#1'), model.roster, undefined, { state: 'missing' }, ui).value;
  expect(missing).toContain(
    '<button class="tog on" data-action="stream" data-stream="session">session</button></div><div class="code">no log for this call</div>',
  );
  const intake = renderInspector(card('intake#1'), model.roster, undefined, undefined, ui).value;
  expect(intake).toContain('<div class="ins-b"><div class="code">no log for this call</div></div>');
});

test("the overview shows the call's facts, output, consumed bindings, errors and other event types, a result not read yet says so, and no card asks for one", () => {
  const markup = inspect(GOLDEN_RUN, 'implement#2', 'overview');
  expect(markup).toContain(
    '<div class="stat"><b>done</b><span>outcome</span></div>\n<div class="stat"><b>1</b><span>tries</span></div>\n<div class="stat"><b>1.1s</b><span>duration</span></div>',
  );
  expect(markup).toContain('<dt>model</dt><dd>claude-sonnet-5</dd><dt>cost</dt><dd>$0.24</dd><dt>turns</dt><dd>4</dd>');
  expect(markup).toContain('<pre class="code">{\n  &quot;commits&quot;: [');
  expect(markup).toContain(
    '<dt>spec</dt><dd>01-spec/call-1/spec.md</dd><dt>feedback</dt><dd>03-tests/call-1/result.json#/output</dd>',
  );
  expect(markup).not.toContain('<div class="hint">');
  const fake2 = foldRun(readEvents(FAKE_2));
  const card = fake2.cards.find((entry) => entry.key === 'implement#1');
  const unread = renderInspector(card, fake2.roster, { state: 'missing' }, undefined, {
    ...initialUi(0),
    key: 'implement#1',
  }).value;
  expect(unread).toContain('<div class="hint">this call has no result.json yet: shown from its events</div>');
  expect(unread).toContain('<div class="code bad"><b>harness</b> the session ended before it submitted a result</div>');
  const open = foldRun(readEvents(GOLDEN_RUN)).cards.find((entry) => entry.key === 'open#1');
  expect(renderInspector(open, undefined, { state: 'loading' }, undefined, initialUi(0)).value).toContain(
    '<ul class="polylist"><li>codehost:pushed × 1</li><li>codehost:labelled × 1</li></ul>',
  );
  expect(renderInspector(undefined, undefined, undefined, undefined, initialUi(0)).value).toBe(
    '<div class="ins-h"><span>inspector</span></div><div class="ins-b"><div class="code">select a stage card</div></div>',
  );
});
