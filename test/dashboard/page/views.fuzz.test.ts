// The structural XSS check (D5): every view is rendered from the seeded fixtures twice, once as they are and once with
// a hostile payload in every untrusted field, and Bun's HTMLRewriter lists each output's elements and their attribute
// names. The two lists must be the same, so no payload opened an element, closed one, or added an attribute. No view
// may emit a script, an inline handler, or a link that isn't http(s).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { index } from '../../../src/dashboard/files';
import { attention } from '../../../src/dashboard/page/attention';
import { renderAttention } from '../../../src/dashboard/page/attention-view';
import { queuePanels, railRepos, watchState } from '../../../src/dashboard/page/index-model';
import { renderInspector } from '../../../src/dashboard/page/inspector-view';
import { queueId, renderQueues } from '../../../src/dashboard/page/queue-view';
import { renderRail } from '../../../src/dashboard/page/rail-view';
import { foldRun } from '../../../src/dashboard/page/run-model';
import { renderRun, renderStatus } from '../../../src/dashboard/page/run-view';
import { initialUi, TABS } from '../../../src/dashboard/page/ui-state';
import { readEvents } from '../../../src/events/consumers/ndjson';
import type { QueueEvent } from '../../../src/events/types';
import { FAKE_2_ID, fake2Dir, type Machine, QUEUE_WORKFLOW, queueDirOf, seedFixtures } from '../../helpers/dashboard';

const RLO = String.fromCharCode(0x202e);
const PAYLOADS = [
  '<img src=x onerror=alert(1)>',
  '"><script>alert(1)</script>',
  "' onmouseover='x",
  'javascript:alert(1)',
  '</textarea><svg onload=1>',
  '&lt;b&gt;',
  '<!--',
  '</script><script>alert(1)</script>',
  ['$', '{alert(1)}`);alert(1);(`'].join(''),
  `${RLO}gnp.exe<a href="javascript:x">`,
  '＜script＞alert(1)＜/script＞',
];

/** The fields of the index that hold untrusted text. */
const INDEX_FIELDS = new Set([
  'title',
  'remote',
  'problem',
  'reason',
  'dedupKey',
  'url',
  'ticketKey',
  'stopReason',
  'message',
]);
/** The fields of an event that hold untrusted text. File names and paths are untrusted too, on file events. */
const EVENT_FIELDS = new Set(['text', 'title', 'url', 'reason', 'message', 'command']);

/** A copy of `value` with every string under a key in `fields` replaced by `payload`. */
function poison<T>(value: T, fields: ReadonlySet<string>, payload: string, every = false): T {
  if (Array.isArray(value)) return value.map((item) => poison(item, fields, payload, every)) as T;
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    out[key] =
      typeof field === 'string' && (every || fields.has(key)) ? payload : poison(field, fields, payload, every);
  }
  return out as T;
}

function poisonEvent(event: Record<string, unknown>, payload: string): Record<string, unknown> {
  const out = poison(event, EVENT_FIELDS, payload);
  if (String(event.type).startsWith('file:')) return { ...out, name: payload, path: payload };
  if (event.type === 'tool:start') return { ...out, input: { command: payload } };
  return out;
}

interface Structure {
  elements: string[];
  hrefs: string[];
}

/** Every element of `markup` as `tag[attribute names]`, and every href. */
async function structure(markup: string): Promise<Structure> {
  const found: Structure = { elements: [], hrefs: [] };
  const rewriter = new HTMLRewriter().on('*', {
    element(element) {
      const names = [...element.attributes].map(([name]) => name).sort();
      found.elements.push(`${element.tagName}[${names.join(' ')}]`);
      const href = element.getAttribute('href');
      if (href !== null) found.hrefs.push(href);
    },
  });
  await rewriter.transform(new Response(markup)).text();
  return found;
}

/** Asserts the hostile render has the benign one's structure, and neither has a script, a handler or a foreign link. */
async function same(benign: string, hostile: string, label: string): Promise<void> {
  const [plain, attacked] = await Promise.all([structure(benign), structure(hostile)]);
  expect(plain.elements.length).toBeGreaterThan(3);
  expect({ label, elements: attacked.elements }).toEqual({ label, elements: plain.elements });
  for (const { elements, hrefs } of [plain, attacked]) {
    expect(elements.filter((element) => /^script\[|\[.*\bon\w+/.test(element))).toEqual([]);
    expect(hrefs.filter((href) => !/^https?:/.test(href))).toEqual([]);
  }
}

let m: Machine;
beforeAll(() => {
  m = seedFixtures();
});
afterAll(() => m.remove());

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const ui = initialUi(0);

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('the rail, needs attention and the queue panel keep their structure under a hostile payload in every untrusted field', async () => {
  const repos = index(m.registryDir).map((repo) => (repo.name === 'beta' ? { ...repo, problem: 'a problem' } : repo));
  const events = readEvents(queueDirOf(m)) as unknown as QueueEvent[];
  const views = (input: typeof repos, queue: QueueEvent[]) => {
    const streams = { [queueId('beta', QUEUE_WORKFLOW)]: { recent: queue, watch: watchState(queue) } };
    return [
      renderRail(railRepos(input, NOW), { ...ui, repo: 'alpha', runId: FAKE_2_ID, open: ['alpha:completed'] }).value,
      renderAttention(attention(input)).value,
      renderQueues(queuePanels(input), streams, ui, NOW).value,
    ];
  };
  const benign = views(repos, events);
  for (const payload of PAYLOADS) {
    const hostile = views(
      poison(repos, INDEX_FIELDS, payload),
      events.map((event) => poison(event, new Set(['title', 'reason', 'message', 'dedupKey', 'label']), payload)),
    );
    for (const [i, view] of benign.entries())
      await same(view, hostile[i] ?? '', `${['rail', 'attention', 'queues'][i]}: ${payload}`);
  }
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('the run view, its status line and every inspector tab keep their structure under a hostile payload in every untrusted field', async () => {
  const dir = fake2Dir(m);
  const events = readEvents(dir) as unknown as Record<string, unknown>[];
  const summary = index(m.registryDir)[0]?.runs.find((run) => run.runId === FAKE_2_ID)?.summary;
  const result = JSON.parse(readFileSync(join(dir, '02-implement/call-1/result.json'), 'utf8'));
  const log = readFileSync(join(dir, dirname('02-implement/call-1/result.json'), 'session.log'), 'utf8');
  const views = (input: Record<string, unknown>[], value: unknown, text: string) => {
    const model = foldRun(input);
    const card = model.cards.find((entry) => entry.key === 'implement#1');
    return [
      renderRun(model, summary, { ...ui, key: 'implement#1' }, NOW).value,
      renderStatus(model, summary).value,
      ...TABS.map(
        (tab) =>
          renderInspector(
            card,
            model.roster,
            { state: 'loaded', value },
            { state: 'loaded', value: text },
            {
              ...ui,
              key: 'implement#1',
              tab,
            },
          ).value,
      ),
    ];
  };
  const withOutput = { ...result, output: { notes: 'benign', list: ['a', 'b'] }, consumed: { spec: 'from' } };
  const benign = views(events, withOutput, log);
  for (const payload of PAYLOADS) {
    const hostile = views(
      events.map((event) => poisonEvent(event, payload)),
      { ...withOutput, output: poison(withOutput.output, new Set(), payload, true), consumed: { spec: payload } },
      payload,
    );
    for (const [i, view] of benign.entries()) await same(view, hostile[i] ?? '', `view ${i}: ${payload}`);
  }
});
