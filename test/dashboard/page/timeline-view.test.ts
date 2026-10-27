// The timeline, drawn from a card's timeline in the run model: its header with the way back and the steps either side,
// thinking and messages as escaped text, a tool call's row with its input, duration and how it ended, and opened, its
// whole input, denial and result; step and try separators, a script's command and exit, and the end or the work going on.
// The filter chips count each kind of entry and hide the kinds the page hides, keeping separators.
import { expect, test } from 'bun:test';
import { foldRun, type StageCard } from '../../../src/dashboard/page/run-model';
import { filterOf, inputSummary, OUTPUT_LINES, renderTimeline } from '../../../src/dashboard/page/timeline-view';
import { initialUi, type UiState } from '../../../src/dashboard/page/ui-state';
import { readEvents } from '../../../src/events/consumers/ndjson';
import { GOLDEN_RUN } from '../../helpers/dashboard';

const NOW = Date.parse('2026-09-25T09:00:31.000Z');
const ui = (fields: Partial<UiState> = {}): UiState => ({ ...initialUi(0), timeline: true, ...fields });
const at = { ts: '2026-09-25T09:00:30.000Z', runId: 'x', key: 'spec#1' };

/** spec#1 of the golden run, its first 14 events, then `events`: running until one ends it. */
function spec(events: Record<string, unknown>[]): StageCard {
  const card = foldRun([...readEvents(GOLDEN_RUN).slice(0, 14), ...events]).cards[1];
  if (card === undefined) throw new Error('no spec#1');
  return card;
}

test("a tool call's input is shown by its most telling field's first line, else as JSON, cut at 160 characters", () => {
  expect([
    inputSummary({ command: 'bun test\nsecond', file_path: 'a.ts' }),
    inputSummary({ file_path: 'a.ts', pattern: 'x' }),
    inputSummary({ pattern: 'TODO', path: 'src' }),
    inputSummary({ url: 'https://example.com' }),
    inputSummary({ command: '', limit: 3 }),
    inputSummary(['a', 1]),
    inputSummary(undefined),
    inputSummary({ command: 'x'.repeat(200) }),
  ]).toEqual([
    'bun test',
    'a.ts',
    'src',
    'https://example.com',
    '{"command":"","limit":3}',
    '["a",1]',
    '',
    `${'x'.repeat(160)}…`,
  ]);
});

test('a running call with no events yet says the timeline fills as it works, with follow on, and a settled one with none says so', () => {
  const running = renderTimeline(spec([]), ui(), NOW).value;
  expect(running).toContain('<span class="d-title">spec#1</span><span class="pill p-run">running</span>');
  expect(running).toContain('<div class="qempty">nothing yet: the timeline fills as the call works</div>');
  expect(running).toContain('<button class="tog on" data-action="toggle-follow">follow</button>');
  expect(running).toContain('<div class="streaming"><i></i>spec#1 is working…</div>');
  expect(renderTimeline(spec([]), ui({ follow: false }), NOW).value).toContain(
    '<button class="tog" data-action="toggle-follow">follow</button>',
  );
  const settled = renderTimeline(
    spec([{ ...at, seq: 901, type: 'stage:end', stage: 'spec', call: 1, try: 1, outcome: 'done', durationMs: 1200 }]),
    ui(),
    NOW,
  ).value;
  expect(settled).toContain('<div class="qempty">this call recorded no timeline</div>');
  expect(settled).toContain(
    '<div class="logend"><span class="pill p-pass">done</span><span>1.2s · — · 0 tool calls</span></div>',
  );
  expect(settled).not.toContain('toggle-follow');
});

test('thinking and messages are escaped text; a tool row shows its input, duration and mark, and opened, its input, denial and result', () => {
  const card = spec([
    { ...at, seq: 901, type: 'agent:thinking', text: 'Maybe <script>alert(1)</script>?' },
    { ...at, seq: 902, type: 'agent:message', text: 'Reading & writing.' },
    { ...at, seq: 903, type: 'tool:start', callId: 'c1', tool: 'Bash', input: { command: 'git push' } },
    {
      ...at,
      seq: 904,
      type: 'permission:denied',
      callId: 'c1',
      tool: 'Bash',
      rule: 'commands',
      permissions: {},
      reason: 'not <allowed>',
    },
    { ...at, seq: 905, type: 'tool:end', callId: 'c1', status: 'denied', durationMs: 4, result: 'hook error' },
    { ...at, seq: 906, type: 'tool:start', callId: 'c2', tool: 'Read', input: { file_path: 'a.ts' } },
    { ...at, seq: 907, type: 'tool:end', callId: 'c2', status: 'completed', durationMs: 12 },
    { ...at, seq: 908, type: 'tool:start', callId: 'c3', tool: 'Grep', input: { pattern: 'x' } },
  ]);
  const closed = renderTimeline(card, ui(), NOW).value;
  expect(closed).toContain(
    '<div class="ev tht"><span class="ts">09:00:30</span><div class="col"><p>Maybe &lt;script&gt;alert(1)&lt;/script&gt;?</p></div></div>',
  );
  expect(closed).toContain(
    '<div class="ev msg"><span class="ts">09:00:30</span><div class="col"><p>Reading &amp; writing.</p>',
  );
  expect(closed).toContain(
    '<div class="tcall t-denied"><button class="trow" data-action="toggle-tool" data-call="c1"><span class="tname">Bash</span><span class="tdet">git push</span><span class="tmeta">4ms<span class="mark">⊘</span></span></button></div>',
  );
  expect(closed).toContain('<span class="tdet">a.ts</span><span class="tmeta">12ms<span class="mark">✓</span>');
  expect(closed).toContain(
    '<div class="tcall t-running"><button class="trow" data-action="toggle-tool" data-call="c3">',
  );
  expect(closed).toContain('<span class="tmeta"><span class="mark">…</span>');
  expect(closed).toContain('<span class="d-agent">28.6s · — · 3 tool calls · 1 denied</span>');
  expect(closed).not.toContain('class="tout"');

  const opened = renderTimeline(card, ui({ opened: ['c1', 'c2'] }), NOW).value;
  expect(opened).toContain(
    '<div class="tout"><div class="grp-t">input</div><pre class="code" data-scroll="input:c1">{\n  &quot;command&quot;: &quot;git push&quot;\n}</pre><div class="mini deny"><div class="mini-h">denied · commands</div><div class="mini-b">not &lt;allowed&gt;</div></div><div class="grp-t">result</div><pre class="code" data-scroll="result:c1">hook error</pre></div>',
  );
  expect(opened).toContain('<div class="tcall t-completed open">');
  expect(opened.match(/<div class="grp-t">result<\/div>/g)).toHaveLength(1);
  expect(opened.match(/data-scroll="[^"]*"/g)).toEqual([
    'data-scroll="input:c1"',
    'data-scroll="result:c1"',
    'data-scroll="input:c2"',
  ]);
});

test("a failed tool's result is marked bad, and a tool whose input is no JSON value opens to an empty input", () => {
  const card = spec([
    { ...at, seq: 901, type: 'tool:start', callId: 'c1', tool: 'Bash', input: { command: 'false' } },
    { ...at, seq: 902, type: 'tool:end', callId: 'c1', status: 'failed', durationMs: 2, result: 'exit 1' },
    { ...at, seq: 903, type: 'tool:start', callId: 'c2', tool: 'Odd' },
  ]);
  const markup = renderTimeline(card, ui({ opened: ['c1', 'c2'] }), NOW).value;
  expect(markup).toContain('<div class="grp-t">result</div><pre class="code bad" data-scroll="result:c1">exit 1</pre>');
  expect(markup).toContain('<span class="mark">✗</span>');
  expect(markup).toContain(
    '<span class="tname">Odd</span><span class="tdet"></span><span class="tmeta"><span class="mark">…</span></span></button><div class="tout"><div class="grp-t">input</div><pre class="code" data-scroll="input:c2"></pre></div>',
  );
});

test('steps and tries are separators, and a script shows its command, then its duration and exit code or signal, failed unless it passed', () => {
  const golden = foldRun(readEvents(GOLDEN_RUN)).cards.find((card) => card.key === 'publish#1');
  const publish = renderTimeline(golden as StageCard, ui(), NOW).value;
  expect(publish).toContain('<div class="tl-sep"><span>step 1/2 · describe</span></div>');
  expect(publish).toContain('<div class="tl-sep"><span>step 2/2 · open</span></div>');
  expect(publish).toContain(
    '<div class="tcall t-completed"><button class="trow" data-action="toggle-tool" data-call="script:0"><span class="tname">$</span><span class="tdet">.sail/workflows/ticket-to-pr/stages/publish/open.sh</span><span class="tmeta">100ms<span class="mark">exit 0</span></span></button></div>',
  );
  const card = spec([
    { ...at, seq: 901, type: 'stage:start', stage: 'spec', call: 1, try: 2, kind: 'agent' },
    { ...at, seq: 902, type: 'script:exec', command: 'sleep 9', cwd: '.', envKeys: [] },
    { ...at, seq: 903, type: 'script:exit', code: null, signal: 'SIGTERM', durationMs: 900, stdoutBytes: 0 },
    { ...at, seq: 904, type: 'script:exec', command: 'make', cwd: '.', envKeys: [] },
    { ...at, seq: 905, type: 'script:exit', code: 2, durationMs: 50, stdoutBytes: 0 },
    { ...at, seq: 906, type: 'script:exec', command: 'tail -f log', cwd: '.', envKeys: [] },
    { ...at, seq: 907, type: 'script:exec', command: 'odd', cwd: '.', envKeys: [] },
    { ...at, seq: 908, type: 'script:exit', code: null, durationMs: 5, stdoutBytes: 0 },
  ]);
  const markup = renderTimeline(card, ui(), NOW).value;
  expect(markup).toContain('<div class="tl-sep"><span>try 2</span></div>');
  expect(markup).toContain(
    '<span class="tdet">sleep 9</span><span class="tmeta">900ms<span class="mark">SIGTERM</span>',
  );
  expect(markup).toContain(
    '<div class="tcall t-failed"><button class="trow" data-action="toggle-tool" data-call="script:1"><span class="tname">$</span><span class="tdet">make</span><span class="tmeta">50ms<span class="mark">exit 2</span>',
  );
  expect(markup).toContain(
    '<div class="tcall t-running"><button class="trow" data-action="toggle-tool" data-call="script:2"><span class="tname">$</span><span class="tdet">tail -f log</span><span class="tmeta"><span class="mark">…</span>',
  );
  expect(markup).toContain('<span class="tdet">odd</span><span class="tmeta">5ms<span class="mark"></span>');
});

test('each entry is of one kind: a failed or denied tool and a failed script are errors, and a separator is none', () => {
  const card = spec([
    { ...at, seq: 901, type: 'agent:thinking', text: 'hm' },
    { ...at, seq: 902, type: 'agent:message', text: 'ok' },
    { ...at, seq: 903, type: 'tool:start', callId: 'c1', tool: 'Read', input: {} },
    { ...at, seq: 904, type: 'tool:end', callId: 'c1', status: 'completed', durationMs: 1 },
    { ...at, seq: 905, type: 'tool:start', callId: 'c2', tool: 'Bash', input: {} },
    { ...at, seq: 906, type: 'tool:end', callId: 'c2', status: 'failed', durationMs: 1 },
    { ...at, seq: 907, type: 'tool:start', callId: 'c3', tool: 'Bash', input: {} },
    { ...at, seq: 908, type: 'tool:end', callId: 'c3', status: 'denied', durationMs: 1 },
    { ...at, seq: 909, type: 'tool:start', callId: 'c4', tool: 'Grep', input: {} },
    { ...at, seq: 910, type: 'script:exec', command: 'ok', cwd: '.', envKeys: [] },
    { ...at, seq: 911, type: 'script:exit', code: 0, outcome: 'passed', durationMs: 5, stdoutBytes: 0 },
    { ...at, seq: 912, type: 'script:exec', command: 'bad', cwd: '.', envKeys: [] },
    { ...at, seq: 913, type: 'script:exit', code: 1, outcome: 'failed', durationMs: 5, stdoutBytes: 0 },
    { ...at, seq: 914, type: 'script:exec', command: 'going', cwd: '.', envKeys: [] },
    { ...at, seq: 915, type: 'stage:start', stage: 'spec', call: 1, try: 2, kind: 'agent' },
  ]);
  expect(card.timeline.map(filterOf)).toEqual([
    'thinking',
    'messages',
    'tools',
    'errors',
    'errors',
    'tools',
    'scripts',
    'errors',
    'scripts',
    undefined,
  ]);
});

test('the chips count the kinds the call has, a hidden kind is off and its entries gone, separators stay, and all shows while one is hidden', () => {
  const card = spec([
    { ...at, seq: 901, type: 'agent:thinking', text: 'pondering' },
    { ...at, seq: 902, type: 'agent:thinking', text: 'more' },
    { ...at, seq: 903, type: 'agent:message', text: 'Saying' },
    { ...at, seq: 904, type: 'stage:start', stage: 'spec', call: 1, try: 2, kind: 'agent' },
    { ...at, seq: 905, type: 'tool:start', callId: 'c1', tool: 'Bash', input: { command: 'false' } },
    { ...at, seq: 906, type: 'tool:end', callId: 'c1', status: 'failed', durationMs: 1 },
  ]);
  const all = renderTimeline(card, ui(), NOW).value;
  expect(all).toContain(
    '<div class="tl-f"><button class="tog f-thinking on" data-action="toggle-filter" data-filter="thinking">thinking <span class="n">2</span></button><button class="tog f-messages on" data-action="toggle-filter" data-filter="messages">messages <span class="n">1</span></button><button class="tog f-errors on" data-action="toggle-filter" data-filter="errors">errors <span class="n">1</span></button></div>',
  );
  expect(all).not.toContain('data-action="show-all"');

  const errorsOnly = renderTimeline(card, ui({ hidden: ['thinking', 'messages', 'tools'] }), NOW).value;
  expect(errorsOnly).toContain('<button class="tog f-thinking" data-action="toggle-filter" data-filter="thinking">');
  expect(errorsOnly).toContain('<button class="tog" data-action="show-all">all</button>');
  expect(errorsOnly).not.toContain('pondering');
  expect(errorsOnly).not.toContain('Saying');
  expect(errorsOnly).toContain('<div class="tl-sep"><span>try 2</span></div>');
  expect(errorsOnly).toContain('<span class="tdet">false</span>');

  // A hidden kind the call doesn't have hides nothing, so all doesn't show.
  expect(renderTimeline(card, ui({ hidden: ['scripts'] }), NOW).value).not.toContain('show-all');
});

test('a filter that hides every entry says so, and a call with no entries has no chips', () => {
  const card = spec([{ ...at, seq: 901, type: 'agent:message', text: 'Only this' }]);
  const markup = renderTimeline(card, ui({ hidden: ['messages'] }), NOW).value;
  expect(markup).toContain('<div class="qempty">the filter hides every entry</div>');
  expect(markup).not.toContain('Only this');
  expect(renderTimeline(spec([]), ui(), NOW).value).not.toContain('class="tl-f"');
});

test("an opened script shows the call's stdout and stderr, escaped, the last lines of a long one, loading, and says when it printed nothing", () => {
  const golden = foldRun(readEvents(GOLDEN_RUN)).cards.find((card) => card.key === 'publish#1') as StageCard;
  const opened = ui({ opened: ['script:0'] });
  expect(renderTimeline(golden, ui(), NOW, { stdout: { state: 'loaded', value: 'x' } }).value).not.toContain('tout');
  const long = Array.from({ length: OUTPUT_LINES + 5 }, (_, i) => `line ${i}`).join('\n');
  const both = renderTimeline(golden, opened, NOW, {
    stdout: { state: 'loaded', value: '{"ok":"<yes>"}\n' },
    stderr: { state: 'loaded', value: `${long}\n` },
  }).value;
  expect(both).toContain(
    '<div class="tcall t-completed open"><button class="trow" data-action="toggle-tool" data-call="script:0">',
  );
  expect(both).toContain(
    '</button><div class="tout"><div class="grp-t">stdout</div><pre class="code" data-scroll="stdout:script:0">{&quot;ok&quot;:&quot;&lt;yes&gt;&quot;}</pre><div class="grp-t">stderr · last 200 lines</div><pre class="code" data-scroll="stderr:script:0">line 5\n',
  );
  expect(both).toContain(`line ${OUTPUT_LINES + 4}</pre></div></div>`);
  expect(both).not.toContain('line 4\n');
  expect(
    renderTimeline(golden, opened, NOW, { stdout: { state: 'loading' }, stderr: { state: 'missing' } }).value,
  ).toContain('<div class="tout"><div class="grp-t">stdout</div><div class="code">loading…</div></div>');
  expect(renderTimeline(golden, opened, NOW, undefined).value).toContain(
    '<div class="tout"><div class="grp-t">stdout</div><div class="code">loading…</div><div class="grp-t">stderr</div><div class="code">loading…</div></div>',
  );
  expect(
    renderTimeline(golden, opened, NOW, { stdout: { state: 'loaded', value: '' }, stderr: { state: 'missing' } }).value,
  ).toContain('<div class="tout"><div class="code">the call printed nothing</div></div>');
});
