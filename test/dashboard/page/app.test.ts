// The page's shell, driven through a fake host (D3, D10): sockets the test pushes messages into, timers it runs by
// hand, and REST reads answered from the seeded fixtures' own files through the dashboard's file module. Every
// assertion is on what the shell rendered into a region, or on the sockets and reads it asked the host for.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runActions } from '../../../src/dashboard/actions';
import { callFile, findRepo, findRunDir, index } from '../../../src/dashboard/files';
import { boot, CLEARED_KEY, FILTER_KEY, type Page, RAIL_KEY, THEME_KEY } from '../../../src/dashboard/page/app';
import { attention, identity } from '../../../src/dashboard/page/attention';
import { browserHost, type ConnectHandlers, type PageHost, type Region } from '../../../src/dashboard/page/host';
import { readEvents } from '../../../src/events/consumers/ndjson';
import {
  FAKE_2_ID,
  FAKE_3_ID,
  fake2Dir,
  fakeClonePorts,
  GOLDEN_RUN_ID,
  type Machine,
  QUEUE_WORKFLOW,
  queueDirOf,
  RUNNING_ID,
  runningCopy,
  seedFixtures,
} from '../../helpers/dashboard';
import { markupWindow } from '../../helpers/dashboard-dom';

interface FakeSocket {
  query: string;
  handlers: ConnectHandlers;
  closed: boolean;
}

interface Read {
  path: string;
  resolve(): void;
}

const STREAMS: Record<string, string> = { session: 'session.log', stdout: 'stdout.log', stderr: 'stderr.log' };

/** A host whose sockets, timers and reads the test drives. Reads answer from the machine's files once released. */
class FakeHost implements PageHost {
  regions: Partial<Record<Region, string>> = {};
  renders: Region[] = [];
  sockets: FakeSocket[] = [];
  reads: Read[] = [];
  /** When set, reads wait for their `resolve()`. */
  hold = false;
  /** Answers that stand in for the machine's files, by path. */
  bodies = new Map<string, { status: number; body: string }>();
  storage = new Map<string, string>();
  copied: string[] = [];
  theme = '';
  inspector = true;
  /** The query the page's URL holds, as start() gives it. */
  startAt: Record<string, string> = {};
  clock = Date.parse('2026-10-01T12:00:00.000Z');
  private timers = new Map<number, { at: number; fn: () => void }>();
  private next = 1;
  private action?: (action: string, data: Record<string, string>) => void;
  private key?: (key: string, inInput: boolean, on?: string) => void;

  constructor(private readonly machine: Machine) {}

  /** The regions written as fresh: the shell gave up their fields. */
  freshes: Region[] = [];
  render(region: Region, html: string, fresh?: boolean) {
    this.regions[region] = html;
    this.renders.push(region);
    if (fresh === true) this.freshes.push(region);
  }
  /** The regions scrolled to their end, in order. */
  scrolls: Region[] = [];
  scrollToEnd(region: Region) {
    this.scrolls.push(region);
  }
  onAction(handler: (action: string, data: Record<string, string>) => void) {
    this.action = handler;
  }
  onKey(handler: (key: string, inInput: boolean, on?: string) => void) {
    this.key = handler;
  }
  /** The dialog's markup while one is open, and how many times it was opened and closed. */
  dialog: string | undefined;
  dialogOpens = 0;
  dialogCloses = 0;
  openDialog(html: string) {
    this.dialog = html;
    this.dialogOpens++;
  }
  closeDialog() {
    this.dialog = undefined;
    this.dialogCloses++;
  }
  /** The reads of a run's actions: answered at once, and kept apart from the reads of its calls. */
  actionReads: string[] = [];
  get(path: string) {
    if (path.endsWith('/actions')) {
      this.actionReads.push(path);
      return this.actionsAnswer(path);
    }
    return new Promise<{ status: number; body: string }>((done) => {
      const read = { path, resolve: () => done(this.answer(path)) };
      this.reads.push(read);
      if (!this.hold) read.resolve();
    });
  }
  /** The values of the fields the page reads, by name. */
  fields: Record<string, string> = {};
  value(name: string) {
    return this.fields[name];
  }
  /** The POSTs made, and what the dashboard answers them. */
  posts: { path: string; body: unknown }[] = [];
  postAnswer: { status: number; body: string } = { status: 202, body: '{"file":"x"}' };
  async post(path: string, body: unknown) {
    this.posts.push({ path, body });
    return this.postAnswer;
  }
  /** What the dashboard would answer for a run's actions. */
  private async actionsAnswer(path: string): Promise<{ status: number; body: string }> {
    const [, , , repo = '', , runId = ''] = new URL(path, 'http://dashboard').pathname
      .split('/')
      .map(decodeURIComponent);
    const entry = findRepo(this.machine.registryDir, repo);
    if (entry === undefined) return { status: 404, body: '' };
    const leasesDir = join(this.machine.root, 'leases');
    const offers = await runActions(entry, runId, { leasesDir, ports: fakeClonePorts(leasesDir) });
    return { status: 200, body: JSON.stringify(offers) };
  }
  /** What the dashboard would answer for a call's result or log: the file, or 404. */
  private answer(path: string): { status: number; body: string } {
    const given = this.bodies.get(path);
    if (given !== undefined) return given;
    const url = new URL(path, 'http://dashboard');
    const [, , , repo = '', , runId = '', , key = '', what] = url.pathname.split('/').map(decodeURIComponent);
    const entry = findRepo(this.machine.registryDir, repo);
    const dir = entry === undefined ? { missing: '' } : findRunDir(entry, runId);
    if (typeof dir !== 'string') return { status: 404, body: '' };
    const name = what === 'result' ? 'result.json' : (STREAMS[url.searchParams.get('stream') ?? ''] ?? '');
    const file = callFile(dir, key, name);
    return typeof file === 'string' ? { status: 200, body: readFileSync(file, 'utf8') } : { status: 404, body: '' };
  }
  connect(query: string, handlers: ConnectHandlers) {
    const socket = { query, handlers, closed: false };
    this.sockets.push(socket);
    return {
      close: () => {
        if (socket.closed) return;
        socket.closed = true;
        handlers.close();
      },
    };
  }
  now() {
    return this.clock;
  }
  later(fn: () => void, ms: number) {
    const id = this.next++;
    this.timers.set(id, { at: this.clock + ms, fn });
    return id;
  }
  cancel(id: number) {
    this.timers.delete(id);
  }
  load(key: string) {
    return this.storage.get(key);
  }
  save(key: string, value: string) {
    this.storage.set(key, value);
  }
  /** Whether the clipboard takes a copy. */
  copyTakes = true;
  async copy(text: string) {
    this.copied.push(text);
    return this.copyTakes;
  }
  setTheme(theme: string) {
    this.theme = theme;
  }
  setInspector(open: boolean) {
    this.inspector = open;
  }
  offset() {
    return 0;
  }
  start() {
    return this.startAt;
  }

  /** Moves the clock on by `ms`, running every timer that falls due, in order. */
  advance(ms: number) {
    const until = this.clock + ms;
    for (;;) {
      const due = [...this.timers].filter(([, timer]) => timer.at <= until).sort(([, a], [, b]) => a.at - b.at)[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.clock = due[1].at;
      due[1].fn();
    }
    this.clock = until;
  }
  click(data: Record<string, string>) {
    this.action?.(data.action ?? '', data);
  }
  press(key: string, inInput = false, on?: string) {
    this.key?.(key, inInput, on);
  }
  /** The open sockets whose query starts with `prefix`. */
  open(prefix: string) {
    return this.sockets.filter((socket) => !socket.closed && socket.query.startsWith(prefix));
  }
  push(socket: FakeSocket | undefined, message: unknown) {
    socket?.handlers.message(JSON.stringify(message));
  }
  /** The server closing `socket`. */
  drop(socket: FakeSocket | undefined) {
    if (socket === undefined || socket.closed) return;
    socket.closed = true;
    socket.handlers.close();
  }
}

/** A host that also draws into a window whose regions hold fields by name, and reads them through the real `browserHost`. */
class DomHost extends FakeHost {
  private readonly dom = markupWindow();
  private readonly real = browserHost(this.dom.win);
  override render(region: Region, html: string) {
    super.render(region, html);
    this.real.render(region, html);
  }
  override value(name: string) {
    return this.real.value(name);
  }
  field(region: string, name: string) {
    return this.dom.field(region, name);
  }
}

let m: Machine;
let host: FakeHost;
let page: Page | undefined;
beforeEach(() => {
  m = seedFixtures();
  host = new FakeHost(m);
});
afterEach(() => {
  page?.stop();
  page = undefined;
  m.remove();
});

/** The toasts on the stack, as `<kind> <head>: <text>`. */
const toasts = () => (page?.ui.toasts ?? []).map((each) => `${each.kind} ${each.head}: ${each.text}`);

/** Lets the reads' promises settle. */
const settle = () => Bun.sleep(0);
const indexMessage = () => ({ kind: 'index', repos: index(m.registryDir) });
const replay = (socket: FakeSocket | undefined, dir: string, end = true) => {
  for (const event of readEvents(dir)) host.push(socket, { kind: 'event', event });
  if (end) host.push(socket, { kind: 'end' });
};
const cards = (region: string | undefined) => [...(region ?? '').matchAll(/data-key="([^"]+)"/g)].map(([, key]) => key);
const runQuery = (repo: string, runId: string) => `run=${encodeURIComponent(`${repo}/${runId}`)}`;
const GOLDEN = () => m.alpha.runDir;

test('boot renders the rail with alpha and beta from the first index, opens the newest run, and renders its eight cards, each region once a flush', () => {
  page = boot(host);
  expect(host.sockets.map((socket) => socket.query)).toEqual(['index=1']);
  host.advance(100);
  expect(host.renders.sort()).toEqual(['attention', 'drawer', 'inspector', 'main', 'rail', 'status', 'toasts']);
  host.push(host.open('index')[0], indexMessage());
  expect(host.open('run=').map((socket) => socket.query)).toEqual([runQuery('alpha', GOLDEN_RUN_ID)]);
  replay(host.open('run=')[0], GOLDEN());
  host.renders = [];
  host.advance(99);
  expect(host.renders).toEqual([]);
  host.advance(1);
  expect(host.renders.sort()).toEqual(['attention', 'main', 'rail', 'status']);
  expect(host.regions.rail).toContain('<span class="nm">alpha</span>');
  expect(host.regions.rail).toContain('<span class="nm">beta</span>');
  expect(host.regions.rail).toContain(
    `<div class="run hist-run sel"><button class="r-open" title="$1.35" data-action="select-run" data-repo="alpha" data-run="${GOLDEN_RUN_ID}">`,
  );
  expect(cards(host.regions.main)).toEqual([
    'intake#1',
    'spec#1',
    'implement#1',
    'tests#1',
    'implement#2',
    'tests#2',
    'self-review#1',
    'publish#1',
  ]);
  expect(host.regions.status).toContain('<span>ended completed</span>');
  expect(host.regions.attention).toContain('⚑ needs attention<span class="badge">4</span></button>');
  expect(host.regions.attention).not.toContain('att-pane');
});

test("opening FAKE-2's denial closes the golden run's socket, opens FAKE-2's, reads implement#1's result, and renders its permissions tab", async () => {
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  const golden = host.open('run=')[0];
  replay(golden, GOLDEN());
  host.click({ action: 'open', repo: 'alpha', run: FAKE_2_ID, key: 'implement#1', tab: 'permissions' });
  expect(golden?.closed).toBe(true);
  expect(host.open('run=').map((socket) => socket.query)).toEqual([runQuery('alpha', FAKE_2_ID)]);
  expect(host.reads.map((read) => read.path)).toEqual([
    `/api/repos/alpha/runs/${FAKE_2_ID}/calls/implement%231/result`,
  ]);
  replay(host.open('run=')[0], fake2Dir(m));
  await settle();
  host.advance(100);
  expect(host.regions.inspector).toContain(
    '<button class="tab on" data-action="tab" data-tab="permissions">permissions</button>',
  );
  expect(host.regions.inspector).toContain('<dt>command</dt><dd><code>git push --force origin HEAD</code></dd>');
  expect(host.regions.inspector).toContain('<dt>rule</dt><dd>commands</dd>');
  expect(host.regions.main).toContain(
    '<div class="card cursor sel" role="button" tabindex="0" data-action="select-card" data-key="implement#1">',
  );
});

test("a URL naming FAKE-2's implement#1 and its permissions tab opens them on the first index, not the newest run", async () => {
  host.startAt = { repo: 'alpha', run: FAKE_2_ID, key: 'implement#1', tab: 'permissions' };
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  expect(host.open('run=').map((socket) => socket.query)).toEqual([runQuery('alpha', FAKE_2_ID)]);
  expect(host.reads.map((read) => read.path)).toEqual([
    `/api/repos/alpha/runs/${FAKE_2_ID}/calls/implement%231/result`,
  ]);
  replay(host.open('run=')[0], fake2Dir(m));
  await settle();
  host.advance(100);
  expect(host.regions.inspector).toContain(
    '<button class="tab on" data-action="tab" data-tab="permissions">permissions</button>',
  );
  expect(host.regions.main).toContain(
    '<div class="card cursor sel" role="button" tabindex="0" data-action="select-card" data-key="implement#1">',
  );
});

test('a URL naming a run no repository lists opens the newest run instead', () => {
  host.startAt = { repo: 'alpha', run: 'FAKE-9-01M5PY0000000000000000000' };
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  expect(host.open('run=').map((socket) => socket.query)).toEqual([runQuery('alpha', GOLDEN_RUN_ID)]);
});

test('the URL is read on the first index only: a run picked since stays open through the next index', () => {
  host.startAt = { repo: 'alpha', run: FAKE_2_ID };
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  expect(host.open('run=').map((socket) => socket.query)).toEqual([runQuery('alpha', FAKE_2_ID)]);
  host.click({ action: 'select-run', repo: 'alpha', run: GOLDEN_RUN_ID });
  host.push(host.open('index')[0], indexMessage());
  expect(host.open('run=').map((socket) => socket.query)).toEqual([runQuery('alpha', GOLDEN_RUN_ID)]);
});

test("live: events pushed one by one show tests#1 running, then settled, and a running call's log is read again at most once a second", async () => {
  const { dir, rest } = runningCopy(m, 1);
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  const socket = host.open('run=')[0];
  expect(socket?.query).toBe(runQuery('alpha', RUNNING_ID));
  replay(socket, dir, false);
  const lines = rest.map((line) => JSON.parse(line));
  const start = lines.findIndex((event) => event.type === 'stage:start' && event.key === 'tests#1');
  for (const event of lines.slice(0, start + 1)) host.push(socket, { kind: 'event', event });
  host.advance(100);
  expect(host.regions.main).toMatch(
    /data-key="tests#1">\n<div class="c-top"><span class="c-n">04<\/span><span class="c-name">tests#1<\/span><span class="pill p-run">running<\/span>/,
  );
  host.click({ action: 'select-card', key: 'tests#1' });
  host.click({ action: 'tab', tab: 'log' });
  const logReads = () => host.reads.filter((read) => read.path.includes('/log?')).length;
  expect(logReads()).toBe(1);
  await settle();
  for (const event of lines.slice(start + 1, start + 3)) {
    host.advance(300);
    host.push(socket, { kind: 'event', event });
  }
  expect(logReads()).toBe(1);
  host.advance(400);
  expect(logReads()).toBe(2);
  const end = lines.findIndex((event) => event.type === 'stage:end' && event.key === 'tests#1');
  for (const event of lines.slice(start + 3, end + 1)) host.push(socket, { kind: 'event', event });
  host.advance(100);
  expect(host.regions.main).toMatch(/<span class="d-title">tests#1<\/span><span class="pill p-fail">failed<\/span>/);
  expect(host.regions.status).toContain('<span>● live</span>');
});

test('live: opening a running card shows its timeline in the centre, which grows with each event, keeps an opened tool call open, follows its tail until follow is off, and closes back to the cards with the selection kept', () => {
  const { dir, rest } = runningCopy(m, 1);
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  const socket = host.open('run=')[0];
  replay(socket, dir, false);
  const lines = rest.map((line) => JSON.parse(line));
  const start = lines.findIndex((event) => event.type === 'stage:start' && event.key === 'implement#1');
  for (const event of lines.slice(0, start + 1)) host.push(socket, { kind: 'event', event });
  host.click({ action: 'select-card', key: 'implement#1' });
  host.advance(100);
  expect(host.regions.main).toContain('nothing yet: the timeline fills as the call works');
  expect(host.regions.main).toContain('<div class="streaming"><i></i>implement#1 is working…</div>');
  expect(host.regions.inspector).toContain('<span>implement#1</span>');

  const at = { runId: RUNNING_ID, key: 'implement#1', ts: '2026-09-25T09:00:04.500Z' };
  const push = (event: Record<string, unknown>) => host.push(socket, { kind: 'event', event: { ...at, ...event } });
  push({ seq: 1001, type: 'agent:thinking', text: 'The <spec> asks for a flag.' });
  push({ seq: 1002, type: 'tool:start', callId: 'c1', tool: 'Bash', input: { command: 'bun test\nsecond line' } });
  host.scrolls = [];
  host.advance(100);
  expect(host.scrolls).toEqual([]);
  host.click({ action: 'toggle-follow' });
  host.advance(100);
  expect(host.scrolls).toEqual(['main']);
  expect(host.regions.main).toContain(
    '<div class="ev tht"><span class="ts">09:00:04</span><div class="col"><p>The &lt;spec&gt; asks for a flag.</p>',
  );
  expect(host.regions.main).toContain(
    '<button class="trow" data-action="toggle-tool" data-call="c1" aria-expanded="false"><span class="tname">Bash</span><span class="tdet">bun test</span><span class="tmeta"><span class="mark">…</span>',
  );
  host.click({ action: 'toggle-tool', call: 'c1' });
  push({ seq: 1003, type: 'tool:end', callId: 'c1', status: 'failed', durationMs: 1500, result: '1 fail' });
  push({ seq: 1004, type: 'agent:message', text: 'Fixing the test.' });
  host.advance(100);
  expect(host.regions.main).toContain('<div class="tcall t-failed open">');
  expect(host.regions.main).toContain('<span class="tmeta">1.5s<span class="mark">✗</span>');
  expect(host.regions.main).toContain(
    '<div class="grp-t">result</div><pre class="code bad" data-scroll="result:c1">1 fail</pre>',
  );
  expect(host.regions.main).toContain(
    '<div class="ev msg"><span class="ts">09:00:04</span><div class="col"><p>Fixing the test.</p>',
  );

  host.click({ action: 'toggle-follow' });
  host.scrolls = [];
  push({ seq: 1005, type: 'agent:thinking', text: 'again' });
  host.advance(100);
  expect(host.scrolls).toEqual([]);
  expect(host.regions.main).toContain('<button class="tog" data-action="toggle-follow">follow</button>');

  host.click({ action: 'toggle-tool', call: 'c1' });
  host.advance(100);
  expect(host.regions.main).toContain('<div class="tcall t-failed">');
  host.click({ action: 'step-card', by: '-1' });
  host.advance(100);
  expect([page.ui.key, page.ui.timeline]).toEqual(['spec#1', true]);
  expect(host.regions.main).toContain('<span class="d-title">spec#1</span>');
  host.click({ action: 'step-card', by: '1' });
  host.click({ action: 'close-timeline' });
  host.advance(100);
  expect([page.ui.key, page.ui.timeline]).toEqual(['implement#1', false]);
  expect(host.regions.main).toContain(
    '<div class="card cursor sel" role="button" tabindex="0" data-action="select-card" data-key="implement#1">',
  );
  expect(host.regions.inspector).toContain('<span>implement#1</span>');
  host.click({ action: 'open', repo: 'alpha', run: RUNNING_ID, key: 'spec#1', tab: 'files' });
  expect([page.ui.key, page.ui.timeline, page.ui.tab]).toEqual(['spec#1', false, 'files']);
});

test('a queue opened over a followed running timeline is not scrolled to its end', () => {
  const { dir, rest } = runningCopy(m, 1);
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  const socket = host.open('run=')[0];
  replay(socket, dir, false);
  const lines = rest.map((line) => JSON.parse(line));
  const start = lines.findIndex((event) => event.type === 'stage:start' && event.key === 'implement#1');
  for (const event of lines.slice(0, start + 1)) host.push(socket, { kind: 'event', event });
  host.click({ action: 'select-card', key: 'implement#1' });
  host.click({ action: 'toggle-follow' });
  host.advance(100);
  expect(host.scrolls).toEqual(['main']);
  host.click({ action: 'select-queue', queue: `beta/${QUEUE_WORKFLOW}` });
  host.scrolls = [];
  host.advance(100);
  const at = { runId: RUNNING_ID, key: 'implement#1', ts: '2026-09-25T09:00:04.500Z' };
  host.push(socket, { kind: 'event', event: { ...at, seq: 1001, type: 'agent:thinking', text: 'more' } });
  host.advance(100);
  expect(host.regions.main).toStartWith('<div class="d-h"><span class="d-title">ticket-to-pr queue</span>');
  expect(host.scrolls).toEqual([]);
});

test('a run socket closed without end reconnects after 2 s into a fresh model, one closed after end stays closed, and the index socket reconnects', () => {
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  const first = host.open('run=')[0];
  replay(first, GOLDEN(), false);
  host.drop(first);
  host.advance(1999);
  expect(host.open('run=')).toEqual([]);
  host.advance(1);
  const second = host.open('run=')[0];
  expect(second?.query).toBe(runQuery('alpha', GOLDEN_RUN_ID));
  host.advance(100);
  expect(cards(host.regions.main)).toEqual([]);
  replay(second, GOLDEN());
  host.advance(100);
  expect(cards(host.regions.main)).toHaveLength(8);
  host.drop(second);
  host.advance(5000);
  expect(host.sockets.filter((socket) => socket.query.startsWith('run='))).toHaveLength(2);
  host.drop(host.open('index')[0]);
  host.advance(2000);
  expect(host.sockets.filter((socket) => socket.query === 'index=1')).toHaveLength(2);
  expect(host.open('index')).toHaveLength(1);
  const [queue] = host.open('queue=');
  host.push(queue, {
    kind: 'queue-event',
    event: { seq: 1, ts: '2026-09-24T10:54:59.000Z', type: 'watch:added', workflow: QUEUE_WORKFLOW },
  });
  host.drop(queue);
  host.advance(2000);
  const [again] = host.open('queue=');
  expect([again === queue, again?.query]).toEqual([false, queue?.query]);
  host.click({ action: 'select-queue', queue: `beta/${QUEUE_WORKFLOW}` });
  host.advance(100);
  expect(host.regions.main).toContain('<span class="pill p-skip">unknown</span>');
});

test('a run stream that sends an error and closes is not reopened, keeps its cards and its error, and clicking the run opens it again from empty (ADW-209)', () => {
  const runSockets = () => host.sockets.filter((socket) => socket.query.startsWith('run='));
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  const socket = host.open('run=')[0];
  const before = [...readEvents(GOLDEN())].slice(0, 12);
  for (const event of before) host.push(socket, { kind: 'event', event });
  host.advance(100);
  const drawn = cards(host.regions.main);
  expect(drawn.length).toBeGreaterThan(0);
  host.push(socket, { kind: 'error', message: "events.ndjson:9 can't be read" });
  host.drop(socket);
  host.advance(10_000);
  expect(runSockets()).toHaveLength(1);
  expect(host.regions.main).toContain('<div class="code bad">events.ndjson:9 can&#39;t be read</div>');
  expect(cards(host.regions.main)).toEqual(drawn);
  host.click({ action: 'select-card', key: drawn[0] ?? '' });
  expect(page.ui.key).toBe(drawn[0]);
  host.click({ action: 'select-run', repo: 'alpha', run: GOLDEN_RUN_ID });
  host.advance(100);
  expect(runSockets()).toHaveLength(2);
  expect(cards(host.regions.main)).toEqual([]);
  expect(host.regions.main).not.toContain('code bad');
  expect(page.ui.key).toBeUndefined();
  host.click({ action: 'select-run', repo: 'alpha', run: GOLDEN_RUN_ID });
  expect(runSockets()).toHaveLength(2);
});

test("a run stream's error is shown in the main region, and a message or a result that is no JSON changes nothing", async () => {
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  const socket = host.open('run=')[0];
  expect(socket?.query).toBe(runQuery('alpha', GOLDEN_RUN_ID));
  socket?.handlers.message('not json');
  host.push(socket, { kind: 'error', message: "events.ndjson:3 can't be read: <b>broken</b>" });
  host.advance(100);
  expect(host.regions.main).toContain(
    '<div class="code bad">events.ndjson:3 can&#39;t be read: &lt;b&gt;broken&lt;/b&gt;</div>',
  );
  replay(socket, GOLDEN());
  host.bodies.set(`/api/repos/alpha/runs/${GOLDEN_RUN_ID}/calls/spec%231/result`, { status: 200, body: '{"schema":' });
  host.click({ action: 'select-card', key: 'spec#1' });
  await settle();
  host.advance(100);
  expect(host.regions.inspector).toContain(
    '<div class="hint">this call has no result.json yet: shown from its events</div>',
  );
  expect(host.regions.main).toContain('<span class="d-title">spec#1</span><span class="pill p-pass">done</span>');
});

test('a result that arrives after the selection changed is not rendered', async () => {
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  replay(host.open('run=')[0], GOLDEN());
  host.hold = true;
  host.click({ action: 'select-card', key: 'implement#1' });
  host.click({ action: 'select-card', key: 'implement#2' });
  const [first, second] = host.reads;
  expect([first?.path, second?.path]).toEqual([
    `/api/repos/alpha/runs/${GOLDEN_RUN_ID}/calls/implement%231/result`,
    `/api/repos/alpha/runs/${GOLDEN_RUN_ID}/calls/implement%232/result`,
  ]);
  first?.resolve();
  await settle();
  host.advance(100);
  expect(host.regions.inspector).toContain('<span>implement#2</span>');
  expect(host.regions.inspector).toContain("reading this call's result.json…");
  expect(host.regions.inspector).not.toContain('89541459e5b0696a12a6adb712334ea24cff1a31');
  second?.resolve();
  await settle();
  host.advance(100);
  expect(host.regions.inspector).not.toContain("reading this call's result.json…");
  expect(host.regions.inspector).toContain('b4efb0c5de84d87c1455d4504b8b75b095a8e10b');
});

test("with no queue the rail has no queue row and no queue socket opens; with beta's, its row opens queue=beta/ticket-to-pr in the centre with its recent events, until the queue leaves the index", () => {
  rmSync(join(m.beta.clone, '.sail-runs', 'queue'), { recursive: true });
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  host.advance(100);
  expect([host.regions.rail?.includes('select-queue'), host.open('queue=')]).toEqual([false, []]);
  page.stop();
  m.remove();
  m = seedFixtures();
  host = new FakeHost(m);
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  const sockets = host.open('queue=');
  expect(sockets.map((socket) => socket.query)).toEqual([`queue=${encodeURIComponent(`beta/${QUEUE_WORKFLOW}`)}`]);
  replay(host.open('run=')[0], GOLDEN());
  host.advance(100);
  expect(host.regions.rail).toContain('<button class="q-row" title="polled 7d ago" data-action="select-queue"');
  host.renders = [];
  for (const event of readEvents(queueDirOf(m))) host.push(sockets[0], { kind: 'queue-event', event });
  host.advance(100);
  expect(host.renders).toEqual([]);
  host.click({ action: 'select-queue', queue: `beta/${QUEUE_WORKFLOW}` });
  host.advance(100);
  expect(host.regions.main).toStartWith('<div class="d-h"><span class="d-title">ticket-to-pr queue</span>');
  expect(host.regions.main).toContain('<span class="pill p-pass">watched</span>');
  expect(host.regions.main).not.toContain('<div class="ev">');
  host.click({ action: 'toggle-queue-events' });
  host.advance(100);
  expect(host.regions.main).toContain('<span class="tname">queue:parked</span>');
  expect(host.regions.main?.match(/<div class="ev">/g)).toHaveLength(9);
  expect(host.regions.main).toContain('<span class="c-ref">ticket:FAKE-4</span>');
  host.click({ action: 'toggle-queue-section', section: `beta/${QUEUE_WORKFLOW}:done` });
  host.advance(100);
  expect(host.regions.main).toContain(
    'data-section="beta/ticket-to-pr:done" aria-expanded="false"><span class="caret">›</span>done · 1</button>',
  );
  expect(host.regions.main).not.toContain('<span class="c-ref">ticket:FAKE-4</span>');
  host.renders = [];
  host.push(sockets[0], {
    kind: 'queue-event',
    event: { seq: 98, ts: '2026-09-24T11:08:00.000Z', type: 'watch:added', workflow: QUEUE_WORKFLOW, pid: 1 },
  });
  host.advance(100);
  expect(host.renders).toContain('main');
  expect(host.regions.main?.match(/<div class="ev">/g)).toHaveLength(10);
  expect(host.regions.main).not.toContain('<span class="c-ref">ticket:FAKE-4</span>');
  expect(host.regions.main).toContain('<span class="c-ref">ticket:FAKE-3</span>');
  host.click({ action: 'toggle-queue-section', section: `beta/${QUEUE_WORKFLOW}:done` });
  host.advance(100);
  expect(host.regions.main).toContain('<span class="c-ref">ticket:FAKE-4</span>');
  expect(host.regions.rail).toContain('<button class="q-row sel" title="polled 7d ago" data-action="select-queue"');
  expect(host.regions.rail).toContain(
    '<button class="qbadge warn sel" title="polled 7d ago" data-action="select-queue"',
  );
  expect(host.regions.rail).not.toMatch(/<div class="run[^"]* sel">/);
  host.renders = [];
  host.push(sockets[0], {
    kind: 'queue-event',
    event: { seq: 99, ts: '2026-09-24T11:09:00.000Z', type: 'watch:removed', workflow: QUEUE_WORKFLOW },
  });
  host.advance(100);
  expect([host.renders, host.regions.main?.includes('<span class="pill p-skip">not watched</span>')]).toEqual([
    ['main'],
    true,
  ]);
  rmSync(join(m.beta.clone, '.sail-runs', 'queue'), { recursive: true });
  host.push(host.open('index')[0], indexMessage());
  expect([sockets[0]?.closed, host.open('queue=')]).toEqual([true, []]);
  host.advance(100);
  expect([page.ui.queue, cards(host.regions.main)]).toEqual([undefined, expect.arrayContaining(['publish#1'])]);
});

test('a queue stream that sends an error and closes is not reopened and shows its error, and clicking its row opens it again from empty (ADW-209)', () => {
  const queueSockets = () => host.sockets.filter((socket) => socket.query.startsWith('queue='));
  const queue = `beta/${QUEUE_WORKFLOW}`;
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  const socket = host.open('queue=')[0];
  host.click({ action: 'select-queue', queue });
  expect(queueSockets()).toHaveLength(1);
  host.push(socket, {
    kind: 'queue-event',
    event: { seq: 1, ts: '2026-09-24T10:54:59.000Z', type: 'watch:added', workflow: QUEUE_WORKFLOW },
  });
  host.push(socket, { kind: 'error', message: "events.ndjson:2 can't be read" });
  host.drop(socket);
  host.advance(10_000);
  expect(queueSockets()).toHaveLength(1);
  expect(host.regions.main).toContain('<div class="code bad">events.ndjson:2 can&#39;t be read</div>');
  host.click({ action: 'select-queue', queue });
  host.advance(100);
  expect(queueSockets()).toHaveLength(2);
  expect(host.regions.main).not.toContain('code bad');
  expect(host.regions.main).toContain('<span class="pill p-skip">unknown</span>');
  host.click({ action: 'select-queue', queue });
  expect(queueSockets()).toHaveLength(2);
});

test('a failed queue reopened before its old socket closes keeps one open socket when the old one closes (review R1) (ADW-209)', () => {
  const queue = `beta/${QUEUE_WORKFLOW}`;
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  const old = host.open('queue=')[0];
  host.click({ action: 'select-queue', queue });
  host.push(old, { kind: 'error', message: "events.ndjson:2 can't be read" });
  host.click({ action: 'select-queue', queue });
  host.drop(old);
  host.advance(10_000);
  expect(host.sockets.filter((socket) => socket.query.startsWith('queue='))).toHaveLength(2);
  expect(host.open('queue=')).toHaveLength(1);
});

test('keys move the cursor, Enter opens a timeline, ] and [ step it, Escape goes back to the cards then deselects, i toggles the inspector, and a key typed in an input does nothing', () => {
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  replay(host.open('run=')[0], GOLDEN());
  const cursor = () =>
    /<div class="card cursor[^"]*" role="button" tabindex="0" data-action="select-card" data-key="([^"]+)"/.exec(
      host.regions.main ?? '',
    )?.[1];
  host.press('j');
  host.press('ArrowDown');
  host.press('j', true);
  host.advance(100);
  expect(cursor()).toBe('implement#1');
  host.press('k');
  host.press('Enter');
  expect([page.ui.key, page.ui.timeline]).toEqual(['spec#1', true]);
  host.press(']');
  host.press(']');
  expect(page.ui.key).toBe('tests#1');
  host.press('[');
  host.advance(100);
  expect([page.ui.key, page.ui.timeline]).toEqual(['implement#1', true]);
  expect(host.regions.main).toContain('<span class="d-title">implement#1</span>');
  host.press('Escape');
  host.advance(100);
  expect([page.ui.key, page.ui.timeline]).toEqual(['implement#1', false]);
  expect(cursor()).toBe('implement#1');
  host.press('Escape');
  expect(page.ui.key).toBeUndefined();
  host.press('i');
  expect(host.inspector).toBe(false);
  host.press('i');
  expect(host.inspector).toBe(true);
  for (let i = 0; i < 20; i++) host.press('ArrowRight');
  host.advance(100);
  expect(cursor()).toBe('publish#1');
});

test('a copy that took draws one ok toast reading what it copied, and 4,000 ms on it is gone', async () => {
  page = boot(host);
  host.click({ action: 'copy', text: 'sail show X' });
  await settle();
  host.advance(100);
  expect(host.regions.toasts).toContain('<div class="toast ok" role="status" data-toast="1">');
  expect(host.regions.toasts).toContain(
    '<span class="toast-head">copy</span> <span class="toast-text">copied sail show X</span>',
  );
  host.advance(3899);
  expect(host.regions.toasts).toContain('copied sail show X');
  host.advance(1);
  host.advance(100);
  expect(host.regions.toasts).toBe('');
});

test('a copy the host refuses draws a red alert that is still drawn 60 s on, until dismiss-toast removes it', async () => {
  page = boot(host);
  host.copyTakes = false;
  host.click({ action: 'copy', text: 'x' });
  await settle();
  host.advance(60_000);
  expect(host.regions.toasts).toContain('<div class="toast bad" role="alert" data-toast="1">');
  expect(host.regions.toasts).toContain('the clipboard refused it');
  host.click({ action: 'dismiss-toast', toast: '1' });
  host.advance(100);
  expect(host.regions.toasts).toBe('');
});

test('the theme cycles and is saved, a section toggles, copy copies, follow toggles, and the stream buttons read that stream', async () => {
  host.storage.set(THEME_KEY, 'light');
  page = boot(host);
  expect(host.theme).toBe('light');
  host.click({ action: 'toggle-theme' });
  expect([host.theme, host.storage.get(THEME_KEY)]).toEqual(['system', 'system']);
  host.click({ action: 'toggle-theme' });
  expect(host.theme).toBe('dark');
  host.push(host.open('index')[0], indexMessage());
  replay(host.open('run=')[0], GOLDEN(), false);
  host.click({ action: 'toggle-section', section: 'beta:completed' });
  expect(page.ui.open).toEqual(['beta:completed']);
  host.click({ action: 'toggle-section', section: 'beta:completed' });
  expect(page.ui.open).toEqual([]);
  host.click({ action: 'copy', text: `sail show ${GOLDEN_RUN_ID}` });
  expect(host.copied).toEqual([`sail show ${GOLDEN_RUN_ID}`]);
  host.click({ action: 'select-card', key: 'tests#1' });
  host.click({ action: 'tab', tab: 'log' });
  host.click({ action: 'stream', stream: 'stderr' });
  expect(page.ui.follow).toBe(false);
  host.click({ action: 'toggle-follow' });
  expect(page.ui.follow).toBe(true);
  expect(host.reads.map((read) => read.path).filter((path) => path.includes('/log?'))).toEqual([
    `/api/repos/alpha/runs/${GOLDEN_RUN_ID}/calls/tests%231/log?stream=stdout`,
    `/api/repos/alpha/runs/${GOLDEN_RUN_ID}/calls/tests%231/log?stream=stderr`,
  ]);
  await settle();
  host.advance(100);
  expect(host.regions.inspector).toContain(
    '<button class="tog on" data-action="stream" data-stream="stderr">stderr</button>',
  );
  host.click({ action: 'select-run', repo: 'alpha', run: FAKE_2_ID });
  expect(host.open('run=').map((socket) => socket.query)).toEqual([runQuery('alpha', FAKE_2_ID)]);
  expect(page.ui.key).toBeUndefined();
});

test("a multi-step call's log reads its steps by step key", async () => {
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  replay(host.open('run=')[0], GOLDEN(), false);
  const base = `/api/repos/alpha/runs/${GOLDEN_RUN_ID}/calls`;
  const logReads = () => host.reads.map((read) => read.path).filter((path) => path.includes('/log?'));
  host.click({ action: 'select-card', key: 'publish#1' });
  host.click({ action: 'tab', tab: 'log' });
  expect(logReads()).toEqual([`${base}/publish%231%2Fopen/log?stream=stdout`]);
  host.click({ action: 'log-step', step: 'describe' });
  expect(page.ui.step).toBe('describe');
  expect(logReads().at(-1)).toBe(`${base}/publish%231%2Fdescribe/log?stream=session`);
  await settle();
  host.advance(100);
  expect(host.regions.inspector).toContain('PR description written.');
  // A stream picked on one step isn't carried to the next one picked, even one that writes it.
  host.click({ action: 'log-step', step: 'open' });
  host.click({ action: 'stream', stream: 'stderr' });
  host.click({ action: 'log-step', step: 'describe' });
  host.click({ action: 'log-step', step: 'open' });
  expect(page.ui.stream).toBeUndefined();
  expect(logReads().at(-1)).toBe(`${base}/publish%231%2Fopen/log?stream=stdout`);
  host.click({ action: 'select-card', key: 'tests#1' });
  expect(page.ui.step).toBeUndefined();
  expect(logReads().at(-1)).toBe(`${base}/tests%231/log?stream=stdout`);
});

test("a running multi-step call's next step drops the last step's log and reads its own at once", async () => {
  const { dir, rest } = runningCopy(m, 1);
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  const socket = host.open('run=')[0];
  replay(socket, dir, false);
  const lines = rest.map((line) => JSON.parse(line));
  const next = lines.findIndex((event) => event.type === 'step:start' && event.key === 'publish#1/open');
  for (const event of lines.slice(0, next)) host.push(socket, { kind: 'event', event });
  const base = `/api/repos/alpha/runs/${RUNNING_ID}/calls`;
  host.bodies.set(`${base}/publish%231%2Fdescribe/log?stream=session`, { status: 200, body: 'DESCRIBE_LOG' });
  host.click({ action: 'select-card', key: 'publish#1' });
  host.click({ action: 'tab', tab: 'log' });
  await settle();
  host.advance(100);
  expect(host.regions.inspector).toContain('DESCRIBE_LOG');
  host.push(socket, { kind: 'event', event: lines[next] });
  host.advance(100);
  expect(host.regions.inspector).not.toContain('DESCRIBE_LOG');
  const logReads = host.reads.map((read) => read.path).filter((path) => path.includes('/log?'));
  expect(logReads.at(-1)).toBe(`${base}/publish%231%2Fopen/log?stream=stdout`);
});

test('the timeline filter loads what was saved, toggles a kind in the order of the chips, saves it, holds across calls, and all clears it', () => {
  host.storage.set(FILTER_KEY, 'tools,bogus,thinking');
  page = boot(host);
  expect(page.ui.hidden).toEqual(['thinking', 'tools']);
  host.push(host.open('index')[0], indexMessage());
  replay(host.open('run=')[0], GOLDEN(), false);
  host.click({ action: 'select-card', key: 'publish#1' });
  host.click({ action: 'toggle-filter', filter: 'scripts' });
  host.click({ action: 'toggle-filter', filter: 'messages' });
  host.click({ action: 'toggle-filter', filter: 'tools' });
  host.click({ action: 'toggle-filter', filter: 'nonsense' });
  expect(page.ui.hidden).toEqual(['thinking', 'messages', 'scripts']);
  expect(host.storage.get(FILTER_KEY)).toBe('thinking,messages,scripts');
  host.advance(100);
  expect(host.regions.main).toContain(
    '<button class="tog f-scripts" data-action="toggle-filter" data-filter="scripts">',
  );
  expect(host.regions.main).not.toContain('open.sh');
  host.click({ action: 'step-card', by: '-1' });
  expect(page.ui.hidden).toEqual(['thinking', 'messages', 'scripts']);
  host.click({ action: 'show-all' });
  expect([page.ui.hidden, host.storage.get(FILTER_KEY)]).toEqual([[], '']);
});

test("a file name opens the drawer with the file's markdown as HTML, another file as text, Esc closes it before the timeline, and another run closes it", async () => {
  const file = (path: string) => `/api/repos/alpha/runs/${GOLDEN_RUN_ID}/file?path=${encodeURIComponent(path)}`;
  host.bodies.set(`${file('01-spec/call-1/out/spec.md')}&as=html`, { status: 200, body: '<h1>Spec</h1>' });
  host.bodies.set(file('00-intake/call-1/out/ticket.json'), { status: 200, body: '{}' });
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  replay(host.open('run=')[0], GOLDEN(), false);
  host.click({ action: 'select-card', key: 'spec#1' });
  host.click({ action: 'open-file', name: 'spec.md', path: '01-spec/call-1/out/spec.md' });
  expect(page.ui.file).toEqual({ name: 'spec.md', path: '01-spec/call-1/out/spec.md' });
  host.advance(100);
  expect(host.regions.drawer).toContain('<div class="code">loading…</div>');
  await settle();
  host.advance(100);
  expect(host.regions.drawer).toContain('<div class="md"><h1>Spec</h1></div>');
  host.click({ action: 'open-file', name: 'ticket.json', path: '00-intake/call-1/out/ticket.json' });
  host.click({ action: 'open-file', name: 'gone.txt', path: '00-intake/call-1/gone.txt' });
  await settle();
  host.advance(100);
  expect(host.reads.map((read) => read.path).filter((path) => path.includes('/file?'))).toEqual([
    `${file('01-spec/call-1/out/spec.md')}&as=html`,
    file('00-intake/call-1/out/ticket.json'),
    file('00-intake/call-1/gone.txt'),
  ]);
  // Only the latest file's read is shown.
  expect(host.regions.drawer).toContain('<b>gone.txt</b>');
  expect(host.regions.drawer).toContain('this file is not in the run');
  host.press('Escape');
  expect([page.ui.file, page.ui.timeline]).toEqual([undefined, true]);
  host.advance(100);
  expect(host.regions.drawer).toBe('');
  host.click({ action: 'open-file', name: 'spec.md', path: '01-spec/call-1/out/spec.md' });
  host.click({ action: 'close-file' });
  expect(page.ui.file).toBeUndefined();
  host.click({ action: 'open-file', name: 'spec.md' });
  expect(page.ui.file).toBeUndefined();
  host.click({ action: 'open-file', name: 'spec.md', path: '01-spec/call-1/out/spec.md' });
  host.click({ action: 'select-run', repo: 'alpha', run: FAKE_2_ID });
  expect(page.ui.file).toBeUndefined();
});

test("opening a multi-step call's script command reads its step's stdout and stderr by step key", async () => {
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  const socket = host.open('run=')[0];
  replay(socket, GOLDEN(), false);
  host.click({ action: 'select-card', key: 'publish#1' });
  host.click({ action: 'toggle-tool', call: 'script:0' });
  const base = `/api/repos/alpha/runs/${GOLDEN_RUN_ID}/calls/publish%231%2Fopen/log`;
  const reads = () => host.reads.map((read) => read.path).filter((path) => path.includes('/log?'));
  expect(reads()).toEqual([`${base}?stream=stdout`, `${base}?stream=stderr`]);
  await settle();
  host.advance(100);
  expect(host.regions.main).toContain('data-scroll="stdout:script:0">{&quot;number&quot;:5');
  const at = { ts: '2026-10-01T12:00:00.000Z', runId: GOLDEN_RUN_ID, key: 'publish#1' };
  host.push(socket, {
    kind: 'event',
    event: { ...at, seq: 990, type: 'stage:start', stage: 'publish', call: 1, try: 2, kind: 'stage' },
  });
  host.push(socket, {
    kind: 'event',
    event: { ...at, key: 'publish#1/open', seq: 991, type: 'script:exec', command: 'more', cwd: '.', envKeys: [] },
  });
  expect(reads()).toEqual([`${base}?stream=stdout`, `${base}?stream=stderr`]);
  host.advance(1000);
  expect(reads()).toEqual([
    `${base}?stream=stdout`,
    `${base}?stream=stderr`,
    `${base}?stream=stdout`,
    `${base}?stream=stderr`,
  ]);
});

test("opening a second script step keeps the first step's output while reading both keys", async () => {
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  const socket = host.open('run=')[0];
  replay(socket, GOLDEN(), false);
  host.push(socket, {
    kind: 'event',
    event: {
      ts: '2026-10-01T12:00:00.000Z',
      runId: GOLDEN_RUN_ID,
      key: 'publish#1/verify',
      seq: 990,
      type: 'script:exec',
      command: 'verify',
      cwd: '.',
      envKeys: [],
    },
  });
  const base = `/api/repos/alpha/runs/${GOLDEN_RUN_ID}/calls`;
  host.bodies.set(`${base}/publish%231%2Fverify/log?stream=stdout`, { status: 200, body: 'VERIFIED' });
  host.bodies.set(`${base}/publish%231%2Fverify/log?stream=stderr`, { status: 200, body: '' });
  host.click({ action: 'select-card', key: 'publish#1' });
  host.click({ action: 'toggle-tool', call: 'script:0' });
  await settle();
  host.advance(100);
  host.hold = true;
  const before = host.reads.length;
  host.click({ action: 'toggle-tool', call: 'script:1' });
  expect(host.reads.slice(before).map((read) => read.path)).toEqual([
    `${base}/publish%231%2Fopen/log?stream=stdout`,
    `${base}/publish%231%2Fopen/log?stream=stderr`,
    `${base}/publish%231%2Fverify/log?stream=stdout`,
    `${base}/publish%231%2Fverify/log?stream=stderr`,
  ]);
  host.advance(100);
  expect(host.regions.main).toContain('data-scroll="stdout:script:0">{&quot;number&quot;:5');
  expect(host.regions.main).toContain('<div class="code">loading…</div>');
  for (const read of host.reads.slice(before)) read.resolve();
  await settle();
  host.advance(100);
  expect(host.regions.main).toContain('data-scroll="stdout:script:0">{&quot;number&quot;:5');
  expect(host.regions.main).toContain('data-scroll="stdout:script:1">VERIFIED</pre>');
});

test("opening a script command reads the call's stdout and stderr once, shows them, and a running call's are read again at most once a second", async () => {
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  const socket = host.open('run=')[0];
  replay(socket, GOLDEN(), false);
  host.click({ action: 'select-card', key: 'tests#1' });
  const outputReads = () => host.reads.map((read) => read.path).filter((path) => path.includes('/log?'));
  host.click({ action: 'toggle-tool', call: 'script:0' });
  host.click({ action: 'toggle-tool', call: 'script:0' });
  host.click({ action: 'toggle-tool', call: 'script:0' });
  const tests = `/api/repos/alpha/runs/${GOLDEN_RUN_ID}/calls/tests%231/log`;
  expect(outputReads()).toEqual([`${tests}?stream=stdout`, `${tests}?stream=stderr`]);
  await settle();
  host.advance(100);
  expect(host.regions.main).toContain(
    '<div class="grp-t">stdout</div><pre class="code" data-scroll="stdout:script:0">bun test v1.3.14',
  );
  // Another call starts over; while it runs, its events read its output again, a second apart at most.
  host.click({ action: 'select-card', key: 'publish#1' });
  host.click({ action: 'toggle-tool', call: 'script:0' });
  const before = outputReads().length;
  const at = { ts: '2026-10-01T12:00:00.000Z', runId: GOLDEN_RUN_ID, key: 'publish#1' };
  host.push(socket, {
    kind: 'event',
    event: { ...at, seq: 990, type: 'stage:start', stage: 'publish', call: 1, try: 2, kind: 'stage' },
  });
  host.push(socket, {
    kind: 'event',
    event: { ...at, seq: 991, type: 'script:exec', command: 'more', cwd: '.', envKeys: [] },
  });
  expect(outputReads().length).toBe(before);
  host.advance(1000);
  expect(outputReads().length).toBe(before + 2);
});

test("with no events, a running call's time is drawn again each second, and with nothing running nothing is drawn", () => {
  const { dir, rest } = runningCopy(m, 1);
  const lines = rest.map((line) => JSON.parse(line));
  const start = lines.findIndex((event) => event.type === 'stage:start' && event.key === 'tests#1');
  host.clock = Date.parse(lines[start].ts) + 1000;
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  const socket = host.open('run=')[0];
  replay(socket, dir, false);
  for (const event of lines.slice(0, start + 1)) host.push(socket, { kind: 'event', event });
  host.click({ action: 'select-card', key: 'tests#1' });
  host.advance(100);
  expect(host.regions.main).toContain('<span class="d-agent">1.1s');
  host.renders = [];
  host.advance(1000);
  expect(host.regions.main).toContain('<span class="d-agent">2.1s');
  expect(host.renders.sort()).toEqual(['main', 'rail']);
  host.advance(1000);
  expect(host.regions.main).toContain('<span class="d-agent">3.1s');
  page.stop();
  page = undefined;

  // The seeded machine alone runs nothing: no tick draws anything.
  host = new FakeHost(m);
  rmSync(dir, { recursive: true });
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  replay(host.open('run=')[0], GOLDEN());
  host.advance(100);
  host.renders = [];
  host.advance(5000);
  expect(host.renders).toEqual([]);
});

test('a tick that changes no markup writes no region and scrolls nothing, and one that changes the running time writes it (ADW-504)', () => {
  const { dir, rest } = runningCopy(m, 1);
  const lines = rest.map((line) => JSON.parse(line));
  const start = lines.findIndex((event) => event.type === 'stage:start' && event.key === 'implement#1');
  // Two hours and ten seconds into the run: its time reads in minutes, so only a minute's turn changes a draw.
  host.clock = Date.parse('2026-09-25T09:00:00.600Z') + 2 * 3_600_000 + 10_000;
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  const socket = host.open('run=')[0];
  replay(socket, dir, false);
  for (const event of lines.slice(0, start + 1)) host.push(socket, { kind: 'event', event });
  host.click({ action: 'select-card', key: 'implement#1' });
  host.click({ action: 'toggle-follow' });
  host.advance(100);
  expect(host.scrolls).toEqual(['main']);
  host.renders = [];
  host.scrolls = [];
  // A value typed between two unchanged ticks is still read by the draw whose write is skipped.
  host.fields.now = 'on';
  host.advance(2500);
  expect([host.renders, host.scrolls, page.ui.act.drafts['stop-run']?.now]).toEqual([[], [], 'on']);
  host.advance(60_000);
  expect(host.renders).toContain('main');
  expect(host.renders).toContain('rail');
  expect([...new Set(host.scrolls)]).toEqual(['main']);
});

test('an add that took writes main though its markup is what was last drawn (ADW-504)', async () => {
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  const [socket] = host.open('queue=');
  host.click({ action: 'select-queue', queue: `beta/${QUEUE_WORKFLOW}` });
  for (const event of readEvents(queueDirOf(m))) host.push(socket, { kind: 'queue-event', event });
  host.advance(100);
  expect(host.regions.main).toContain('name="add-ticket" placeholder="ticket key" value=""');
  host.postAnswer = { status: 200, body: '{}' };
  host.fields['add-ticket'] = 'FAKE-9';
  host.click({ action: 'add-ticket', ...BETA });
  await settle();
  host.renders = [];
  host.freshes = [];
  host.advance(100);
  expect(host.renders).toContain('main');
  expect(host.freshes).toEqual(['main']);
  expect(host.regions.main).toContain('name="add-ticket" placeholder="ticket key" value=""');
});

test('a switch of run draws the rail fresh, and a tick does not (ADW-504)', () => {
  const { dir, rest } = runningCopy(m, 1);
  const start = rest.map((line) => JSON.parse(line)).find((event) => event.type === 'stage:start');
  host.clock = Date.parse(start.ts) + 1000;
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  replay(host.open('run=')[0], dir, false);
  host.advance(100);
  expect(host.freshes).toEqual(['rail']);
  host.renders = [];
  host.freshes = [];
  host.advance(2500);
  expect(host.renders).toContain('rail');
  expect(host.freshes).toEqual([]);
  host.click({ action: 'select-run', repo: 'alpha', run: GOLDEN_RUN_ID });
  host.advance(100);
  expect(host.freshes).toEqual(['rail']);
});

test('the open run, once ended, opens its stream again when the index says it runs again, folds past its old run:end as live, and leaves one socket (review R1-2)', () => {
  const beta = join(m.beta.clone, '.sail-runs', FAKE_3_ID);
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  host.click({ action: 'select-run', repo: 'beta', run: FAKE_3_ID });
  const first = host.open('run=')[0];
  expect(first?.query).toBe(runQuery('beta', FAKE_3_ID));
  replay(first, beta);
  host.drop(first);
  host.advance(5000);
  expect(host.regions.status).toContain('<span>ended suspended</span>');
  expect(host.open('run=')).toEqual([]);

  // `sail resume` sets STATUS back to running, and the next index says so.
  const resumed = indexMessage();
  for (const repo of resumed.repos)
    for (const run of repo.runs) if (run.runId === FAKE_3_ID) run.status = { status: 'running' };
  host.push(host.open('index')[0], resumed);
  const second = host.open('run=');
  expect(second.map((socket) => socket.query)).toEqual([runQuery('beta', FAKE_3_ID)]);
  replay(second[0], beta, false);
  const after = { seq: 50, ts: '2026-09-24T11:05:00.000Z', type: 'workspace:leased', runId: FAKE_3_ID };
  host.push(second[0], { kind: 'event', event: after });
  host.advance(100);
  expect(host.regions.status).toContain('<span>● live</span>');
  host.advance(5000);
  expect(host.open('run=')).toHaveLength(1);
  expect(host.sockets.filter((socket) => socket.query.startsWith('run=beta'))).toHaveLength(2);
});

test("the selected call's result and log are read again when it ends, and a read answered late never overwrites a newer one (review R1-3)", async () => {
  const { dir, rest } = runningCopy(m, 1);
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  const socket = host.open('run=')[0];
  replay(socket, dir, false);
  const lines = rest.map((line) => JSON.parse(line));
  const start = lines.findIndex((event) => event.type === 'stage:start' && event.key === 'tests#1');
  const end = lines.findIndex((event) => event.type === 'stage:end' && event.key === 'tests#1');
  for (const event of lines.slice(0, start + 1)) host.push(socket, { kind: 'event', event });
  const result = `/api/repos/alpha/runs/${RUNNING_ID}/calls/tests%231/result`;
  host.bodies.set(result, { status: 404, body: '' });
  host.hold = true;
  host.click({ action: 'select-card', key: 'tests#1' });
  host.click({ action: 'tab', tab: 'log' });
  const reads = (part: string) => host.reads.filter((read) => read.path.includes(part));
  const counts = () => [reads('/result').length, reads('/log?').length];
  expect(counts()).toEqual([1, 1]);
  for (const event of lines.slice(start + 1, end)) host.push(socket, { kind: 'event', event });
  host.advance(2000);
  const [results = 0, logs = 0] = counts();
  expect(results).toBe(1);
  // Its end, a second after the last read: its result.json and its whole log are read once more.
  host.push(socket, { kind: 'event', event: lines[end] });
  host.advance(1000);
  expect(counts()).toEqual([results + 1, logs + 1]);
  // The call's result.json now exists: the second read finds it, and the first, answered after it, is dropped.
  host.bodies.set(result, { status: 200, body: JSON.stringify({ outcome: 'failed', output: { read: 'the second' } }) });
  reads('/result')[1]?.resolve();
  await settle();
  host.bodies.set(result, { status: 404, body: '' });
  reads('/result')[0]?.resolve();
  for (const read of reads('/log?')) read.resolve();
  await settle();
  host.click({ action: 'tab', tab: 'overview' });
  host.advance(100);
  expect(host.regions.inspector).toContain('&quot;the second&quot;');
  expect(host.regions.inspector).not.toContain('this call has no result.json yet');
});

test("a region whose draw throws shows that it couldn't be drawn, and every other region is still drawn (review R2-1)", () => {
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  replay(host.open('run=')[0], GOLDEN());
  host.advance(100);
  // A summary of no shape, as the server never sends one: the rail and needs attention read it, the open run doesn't.
  const broken = indexMessage();
  for (const repo of broken.repos)
    for (const run of repo.runs) if (run.runId === FAKE_3_ID) run.summary = {} as typeof run.summary;
  host.renders = [];
  host.push(host.open('index')[0], broken);
  expect(() => host.advance(100)).not.toThrow();
  expect(host.renders.sort()).toEqual(['attention', 'rail']);
  expect(host.regions.rail).toContain('this part of the page could not be drawn');
  expect(cards(host.regions.main)).toHaveLength(8);
});

test("a corrective try's end reads the call's result.json again though the first try's was loaded (review R2-2)", async () => {
  const { dir, rest } = runningCopy(m, 1);
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  const socket = host.open('run=')[0];
  replay(socket, dir, false);
  const lines = rest.map((line) => JSON.parse(line));
  const end = lines.findIndex((event) => event.type === 'stage:end' && event.key === 'tests#1');
  const result = `/api/repos/alpha/runs/${RUNNING_ID}/calls/tests%231/result`;
  const answer = (output: string) => host.bodies.set(result, { status: 200, body: JSON.stringify({ output }) });
  answer('FIRST_TRY');
  for (const event of lines.slice(0, end + 1)) host.push(socket, { kind: 'event', event });
  host.click({ action: 'select-card', key: 'tests#1' });
  await settle();
  host.advance(100);
  expect(host.regions.inspector).toContain('FIRST_TRY');
  const first = lines[end];
  answer('SECOND_TRY');
  const start = lines.find((event) => event.type === 'stage:start' && event.key === 'tests#1');
  host.push(socket, { kind: 'event', event: { ...start, seq: 900, try: 2 } });
  host.push(socket, { kind: 'event', event: { ...first, seq: 901, try: 2, outcome: 'passed' } });
  await settle();
  host.advance(100);
  expect(host.regions.inspector).toContain('SECOND_TRY');
});

test('a resumed open run is followed again when the index saying it runs arrives before its old stream ends (review R2-3)', () => {
  const beta = join(m.beta.clone, '.sail-runs', FAKE_3_ID);
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  host.click({ action: 'select-run', repo: 'beta', run: FAKE_3_ID });
  const first = host.open('run=')[0];
  replay(first, beta, false);
  const resumed = indexMessage();
  for (const repo of resumed.repos)
    for (const run of repo.runs) if (run.runId === FAKE_3_ID) run.status = { status: 'running' };
  host.push(host.open('index')[0], resumed);
  host.push(first, { kind: 'end' });
  host.drop(first);
  host.advance(2000);
  expect(host.open('run=').map((socket) => socket.query)).toEqual([runQuery('beta', FAKE_3_ID)]);
  host.advance(10_000);
  expect(host.sockets.filter((socket) => socket.query.startsWith('run=beta'))).toHaveLength(2);
});

test('a run whose stream ended while an older index still said running is not opened again, and is once the index says it ended later (review R3-1, R3-3)', () => {
  const { dir, rest } = runningCopy(m, 1);
  page = boot(host);
  const running = indexMessage();
  host.push(host.open('index')[0], running);
  const first = host.open('run=')[0];
  expect(first?.query).toBe(runQuery('alpha', RUNNING_ID));
  replay(first, dir, false);
  for (const line of rest) host.push(first, { kind: 'event', event: JSON.parse(line) });
  host.push(first, { kind: 'end' });
  host.drop(first);
  // The index lags: it still says running half a second after the end, then says completed.
  host.advance(500);
  host.push(host.open('index')[0], running);
  host.advance(500);
  const ended = indexMessage();
  for (const repo of ended.repos)
    for (const run of repo.runs) if (run.runId === RUNNING_ID) run.status = { status: 'completed' };
  host.push(host.open('index')[0], ended);
  host.advance(10_000);
  const opened = () => host.sockets.filter((socket) => socket.query === runQuery('alpha', RUNNING_ID));
  expect(opened()).toHaveLength(1);

  // A resume that ran and ended between two polls: the index never says running, but it ended later than the stream.
  const again = indexMessage();
  for (const repo of again.repos)
    for (const run of repo.runs)
      if (run.runId === RUNNING_ID && run.summary !== null) {
        run.status = { status: 'completed' };
        run.summary = { ...run.summary, endedAt: '2026-09-25T10:00:00.000Z' };
      }
  host.push(host.open('index')[0], again);
  expect(opened()).toHaveLength(2);
  expect(host.open('run=')).toHaveLength(1);
});

test('a suspended open run that is resumed and ends between two polls, as completed, is followed again (review R3-1)', () => {
  const beta = join(m.beta.clone, '.sail-runs', FAKE_3_ID);
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  host.click({ action: 'select-run', repo: 'beta', run: FAKE_3_ID });
  const first = host.open('run=')[0];
  replay(first, beta);
  host.drop(first);
  host.advance(5000);
  const finished = indexMessage();
  for (const repo of finished.repos)
    for (const run of repo.runs) if (run.runId === FAKE_3_ID) run.status = { status: 'completed' };
  host.push(host.open('index')[0], finished);
  expect(host.open('run=').map((socket) => socket.query)).toEqual([runQuery('beta', FAKE_3_ID)]);
  expect(host.sockets.filter((socket) => socket.query.startsWith('run=beta'))).toHaveLength(2);
});

test('the needs attention button opens its pane, a and Escape toggle and close it, and opening an item closes it and leaves an open queue', () => {
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  replay(host.open('run=')[0], GOLDEN());
  host.advance(100);
  host.click({ action: 'toggle-attention' });
  host.advance(100);
  expect(host.regions.attention).toContain('<div class="att-pane">');
  expect(host.regions.attention).toContain(`data-action="open" data-repo="alpha" data-run="${FAKE_2_ID}"`);
  host.press('Escape');
  host.advance(100);
  expect([page.ui.attention, host.regions.attention?.includes('att-pane')]).toEqual([false, false]);
  expect(page.ui.key).toBeUndefined();
  host.press('a');
  host.advance(100);
  expect(page.ui.attention).toBe(true);
  host.press('a', true);
  expect(page.ui.attention).toBe(true);
  host.click({ action: 'select-queue', queue: `beta/${QUEUE_WORKFLOW}` });
  host.click({ action: 'open', repo: 'alpha', run: FAKE_2_ID, key: 'implement#1', tab: 'permissions' });
  host.advance(100);
  expect([page.ui.attention, page.ui.queue, page.ui.runId, page.ui.key]).toEqual([
    false,
    undefined,
    FAKE_2_ID,
    'implement#1',
  ]);
  expect(host.regions.attention).not.toContain('att-pane');
});

test('a repository or workflow opens and folds again from its header, remembered across a boot, and opening the open run from the rail gives the centre back from a queue', () => {
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  replay(host.open('run=')[0], GOLDEN());
  host.advance(100);
  expect(page.ui.expanded).toEqual([]);
  expect(host.regions.rail).not.toContain('data-group="beta/');
  host.click({ action: 'toggle-group', group: 'beta' });
  host.click({ action: 'toggle-group', group: `beta/${QUEUE_WORKFLOW}` });
  host.advance(100);
  expect(page.ui.expanded).toEqual(['beta', `beta/${QUEUE_WORKFLOW}`]);
  expect(host.storage.get(RAIL_KEY)).toBe(JSON.stringify(['beta', `beta/${QUEUE_WORKFLOW}`]));
  expect(host.regions.rail).toContain(
    '<button class="lgrp-h open" title="https://example.com/beta.git" data-action="toggle-group" data-group="beta" aria-expanded="true">',
  );
  expect(host.regions.rail).toContain(
    `<button class="wf-t open" data-action="toggle-group" data-group="beta/${QUEUE_WORKFLOW}" aria-expanded="true">`,
  );
  host.click({ action: 'toggle-group', group: 'beta' });
  host.advance(100);
  expect(page.ui.expanded).toEqual([`beta/${QUEUE_WORKFLOW}`]);
  expect(host.storage.get(RAIL_KEY)).toBe(JSON.stringify([`beta/${QUEUE_WORKFLOW}`]));
  host.click({ action: 'select-queue', queue: `beta/${QUEUE_WORKFLOW}` });
  host.advance(100);
  expect(cards(host.regions.main)).toEqual([]);
  host.click({ action: 'select-run', repo: 'alpha', run: GOLDEN_RUN_ID });
  host.advance(100);
  expect([page.ui.queue, cards(host.regions.main)]).toEqual([undefined, expect.arrayContaining(['publish#1'])]);
  expect(host.sockets.filter((socket) => socket.query.startsWith('run='))).toHaveLength(1);
});

test('the rail restores the opens it saved and ignores a stored value that is not a list of names', () => {
  host.storage.set(RAIL_KEY, JSON.stringify(['alpha', 'alpha/ticket-to-pr']));
  const restored = boot(host);
  expect(restored.ui.expanded).toEqual(['alpha', 'alpha/ticket-to-pr']);
  restored.stop();
  for (const bad of ['nope', '{"a":1}', '[1,"a"]']) {
    host.storage.set(RAIL_KEY, bad);
    const malformed = boot(host);
    expect(malformed.ui.expanded).toEqual([]);
    malformed.stop();
  }
  host.storage.delete(RAIL_KEY);
  page = boot(host);
  host.click({ action: 'toggle-group', group: 'alpha' });
  page.stop();
  const again = boot(host);
  expect(again.ui.expanded).toEqual(['alpha']);
  again.stop();
});

test("a click on a waiting row's down button posts the move to the queue's move route, a 409 is a red toast quoting its error, and a 202 an ok one", async () => {
  const file = join(queueDirOf(m), 'queue.json');
  const queue = JSON.parse(readFileSync(file, 'utf8'));
  const waiting = queue.items.find((item: { state: string }) => item.state === 'queued');
  queue.items.push({ ...waiting, dedupKey: 'ticket:FAKE-7', source: { kind: 'ticket', ticketKey: 'FAKE-7' } });
  writeFileSync(file, JSON.stringify(queue));
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  host.click({ action: 'select-queue', queue: `beta/${QUEUE_WORKFLOW}` });
  host.advance(100);
  const row = { repo: 'beta', workflow: QUEUE_WORKFLOW };
  host.postAnswer = { status: 409, body: JSON.stringify({ error: "no watcher is running for 'beta'" }) };
  host.click({ action: 'move-item', dir: 'down', ...row, key: 'ticket:FAKE-5', target: 'ticket:FAKE-7' });
  await settle();
  host.advance(100);
  const refused = toasts();
  host.postAnswer = { status: 202, body: '{"file":"x"}' };
  host.click({ action: 'move-item', dir: 'up', ...row, key: 'ticket:FAKE-7', target: 'ticket:FAKE-5' });
  await settle();
  host.advance(100);
  expect({
    posts: host.posts,
    refused,
    after: toasts(),
  }).toEqual({
    posts: [
      {
        path: `/api/repos/beta/queues/${QUEUE_WORKFLOW}/move`,
        body: { dedupKey: 'ticket:FAKE-5', after: 'ticket:FAKE-7' },
      },
      {
        path: `/api/repos/beta/queues/${QUEUE_WORKFLOW}/move`,
        body: { dedupKey: 'ticket:FAKE-7', before: 'ticket:FAKE-5' },
      },
    ],
    refused: ["bad move ticket:FAKE-5: no watcher is running for 'beta'"],
    after: ["bad move ticket:FAKE-5: no watcher is running for 'beta'", `ok move ticket:FAKE-7: asked`],
  });
});

// Resume and Restart: what the open run offers is read from its actions route, a first click arms a button, and a second
// posts it.
const NEW_ID = 'FAKE-2-01HZX3Y4Z5A6B7C8D9E0F1G2H3';
const GOLDEN_PATH = `/api/repos/alpha/runs/${GOLDEN_RUN_ID}`;
const FAKE_2_PATH = `/api/repos/alpha/runs/${FAKE_2_ID}`;
const FAKE_3_PATH = `/api/repos/beta/runs/${FAKE_3_ID}`;
const buttons = (region: string | undefined) =>
  [...(region ?? '').matchAll(/<button class="btn"( disabled)? ?(?:data-action="(\w+-run)")?>([^<]*)<\/button>/g)].map(
    ([, disabled, action, label]) => [label, action, disabled === undefined ? '' : 'disabled'],
  );

/** The lines of the dialog open now, and its primary button's verb. */
const dialogLines = () => [...(host.dialog ?? '').matchAll(/<li>([^<]*)<\/li>/g)].map(([, line]) => line);
const dialogVerb = () => host.dialog?.match(/data-action="dialog-confirm" autofocus>([^<]*)<\/button>/)?.[1];
/** The subject of the dialog open now: its title, or undefined when none is open. */
const dialogTitle = () => host.dialog?.match(/<h2 id="dialog-title">([^<]*)<\/h2>/)?.[1];

/** Boots the page on `run` of `repo`, its events replayed, its actions read and its ⋯ menu open, and settled. */
async function openOffering(repo: string, runId: string, dir: string) {
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  host.click({ action: 'open', repo, run: runId });
  replay(host.open('run=')[0], dir);
  host.click({ action: 'run-menu', repo, run: runId });
  await settle();
  host.advance(100);
}

/** The queue item of FAKE-3 as the watcher leaves it when it has let go: settled, so nothing holds the run. */
const settleQueue = () => {
  const file = join(queueDirOf(m), 'queue.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"state": "dispatched"', '"state": "done"'));
};

test("a failed run's view offers Restart with its stages and the failed one chosen, and no Resume; the first click opens the dialog and posts nothing, its confirm posts the stage and opens the new run", async () => {
  await openOffering('alpha', FAKE_2_ID, fake2Dir(m));
  expect(host.actionReads).toEqual([`${GOLDEN_PATH}/actions`, `${FAKE_2_PATH}/actions`]);
  expect(buttons(host.regions.rail).filter(([, action]) => action?.endsWith('-run'))).toEqual([
    ['restart', 'restart-run', ''],
    ['clean', 'clean-run', ''],
  ]);
  expect(host.regions.rail).toContain(
    '<option value="implement" title="implement#1 and everything after it, in loop fix from iteration 1" selected>',
  );
  host.click({ action: 'restart-run' });
  host.advance(100);
  expect([host.posts, dialogTitle(), dialogVerb()]).toEqual([[], `restart ${FAKE_2_ID}`, 'restart']);
  expect(dialogLines()).toEqual([
    'runs again: implement#1 and everything after it, in loop fix from iteration 1',
    'budget $25.00',
    `starts a new run seeded from ${FAKE_2_ID}`,
  ]);
  expect(host.regions.rail).not.toContain('armed');
  host.postAnswer = { status: 202, body: JSON.stringify({ runId: NEW_ID }) };
  host.click({ action: 'dialog-confirm' });
  expect(page?.ui.underway).toEqual({ [`run:alpha/${FAKE_2_ID}`]: 'restarting…' });
  await settle();
  host.advance(100);
  expect(host.posts).toEqual([{ path: `${FAKE_2_PATH}/restart`, body: { stage: 'implement' } }]);
  expect([host.open('run=').map((socket) => socket.query), page?.ui.runId, page?.ui.underway]).toEqual([
    [runQuery('alpha', NEW_ID)],
    NEW_ID,
    {},
  ]);
  expect(toasts()).toEqual([`ok restart ${FAKE_2_ID}: started ${NEW_ID}`]);
});
test('a stage chosen in the list is the one the restart dialog names and its confirm posts', async () => {
  await openOffering('alpha', FAKE_2_ID, fake2Dir(m));
  host.fields.stage = 'spec';
  host.click({ action: 'restart-run' });
  expect(dialogLines()[0]).toBe('runs again: spec#1 and everything after it');
  host.click({ action: 'dialog-cancel' });
  host.fields.stage = 'implement';
  host.click({ action: 'restart-run' });
  expect([host.posts, dialogLines()[0]]).toEqual([
    [],
    'runs again: implement#1 and everything after it, in loop fix from iteration 1',
  ]);
  host.click({ action: 'dialog-confirm' });
  await settle();
  expect(host.posts).toEqual([{ path: `${FAKE_2_PATH}/restart`, body: { stage: 'implement' } }]);
});
test("a refusal is a red toast in the dashboard's words that stays until dismissed, and a request that got no answer says so", async () => {
  await openOffering('alpha', FAKE_2_ID, fake2Dir(m));
  host.postAnswer = {
    status: 409,
    body: JSON.stringify({ error: 'sail run: branch sail/x is leased by run FAKE-9-Y' }),
  };
  host.click({ action: 'restart-run' });
  host.click({ action: 'dialog-confirm' });
  await settle();
  host.advance(60_000);
  expect(toasts()).toEqual([`bad restart ${FAKE_2_ID}: sail run: branch sail/x is leased by run FAKE-9-Y`]);
  expect(host.regions.toasts).toContain('role="alert"');
  expect(buttons(host.regions.rail).find(([, action]) => action === 'restart-run')?.[0]).toBe('restart');
  host.postAnswer = { status: 0, body: '' };
  host.click({ action: 'restart-run' });
  host.click({ action: 'dialog-confirm' });
  await settle();
  host.advance(100);
  expect(toasts().at(-1)).toBe(`bad restart ${FAKE_2_ID}: the restart could not be sent: the dashboard did not answer`);
  expect(page?.ui.runId).toBe(FAKE_2_ID);
});
test("a click on another control while the run's dialog is open can't confirm it, and the run menu toggled closes it with nothing sent", async () => {
  await openOffering('alpha', FAKE_2_ID, fake2Dir(m));
  host.click({ action: 'restart-run' });
  expect(dialogTitle()).toBe(`restart ${FAKE_2_ID}`);
  host.click({ action: 'run-menu', repo: 'alpha', run: FAKE_2_ID });
  host.advance(100);
  expect([host.dialog, page?.ui.runMenu, host.posts]).toEqual([undefined, undefined, []]);
  host.click({ action: 'run-menu', repo: 'alpha', run: FAKE_2_ID });
  host.advance(100);
  host.click({ action: 'restart-run' });
  await settle();
  expect(dialogTitle()).toBe(`restart ${FAKE_2_ID}`);
  expect(host.posts).toEqual([]);
});
test("a run's ⋯ opens the run and its menu under its row, reading what it offers; its ⋯ again or Escape shuts it, and another run's ⋯ moves it there (ADW-466)", async () => {
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  await settle();
  host.advance(100);
  expect(host.regions.rail).not.toContain('class="r-menu"');
  host.click({ action: 'run-menu', repo: 'alpha', run: FAKE_2_ID });
  host.advance(100);
  expect([page?.ui.runId, page?.ui.runMenu]).toEqual([FAKE_2_ID, FAKE_2_ID]);
  expect(host.regions.rail).toContain(
    '<div class="r-menu"><span class="act-why">reading what the run offers…</span></div>',
  );
  await settle();
  host.advance(100);
  expect(buttons(host.regions.rail).map(([label]) => label)).toEqual(['restart', 'clean']);
  expect(host.regions.main).not.toContain('data-action="restart-run"');
  host.click({ action: 'run-menu', repo: 'alpha', run: FAKE_2_ID });
  host.advance(100);
  expect([page?.ui.runId, page?.ui.runMenu, host.regions.rail?.includes('class="r-menu"')]).toEqual([
    FAKE_2_ID,
    undefined,
    false,
  ]);
  host.click({ action: 'run-menu', repo: 'alpha', run: FAKE_2_ID });
  host.click({ action: 'restart-run' });
  host.press('Escape');
  host.advance(100);
  expect([page?.ui.runMenu, host.dialog]).toEqual([FAKE_2_ID, undefined]);
  host.press('Escape');
  host.advance(100);
  expect([page?.ui.runId, page?.ui.runMenu]).toEqual([FAKE_2_ID, undefined]);
  host.click({ action: 'run-menu', repo: 'alpha', run: FAKE_2_ID });
  host.click({ action: 'run-menu', repo: 'alpha', run: GOLDEN_RUN_ID });
  await settle();
  host.advance(100);
  expect([page?.ui.runId, page?.ui.runMenu, host.regions.rail?.match(/class="r-menu"/g)?.length]).toEqual([
    GOLDEN_RUN_ID,
    GOLDEN_RUN_ID,
    1,
  ]);
  expect(host.regions.rail).toContain(`<div class="r-menu"><span class="act-why">run ${GOLDEN_RUN_ID} completed`);
});

test('a suspended run over its dollars offers Resume with a raise field and no Restart; with no raise typed a click is a red toast, and with one the dialog reads the raise and its confirm posts it and reads the run again', async () => {
  settleQueue();
  await openOffering('beta', FAKE_3_ID, m.beta.runDir);
  expect(host.regions.rail).toContain('name="raise"');
  expect(buttons(host.regions.rail).filter(([, action]) => action?.endsWith('-run'))).toEqual([
    ['resume', 'resume-run', ''],
    ['stop', 'stop-run', ''],
  ]);
  host.click({ action: 'resume-run' });
  host.advance(100);
  expect([host.posts, host.dialog]).toEqual([[], undefined]);
  expect(toasts()).toEqual([`bad resume ${FAKE_3_ID}: give the dollars to raise the budget by: at least 0.01`]);
  host.fields.raise = '5';
  host.click({ action: 'resume-run' });
  host.advance(100);
  expect([dialogTitle(), dialogLines(), dialogVerb()]).toEqual([
    `resume ${FAKE_3_ID}`,
    ['spent $1.06 of $1.00', 'raises the budget by $5.00'],
    'resume',
  ]);
  const before = host.open('run=')[0];
  host.click({ action: 'dialog-confirm' });
  await settle();
  expect(host.posts).toEqual([{ path: `${FAKE_3_PATH}/resume`, body: { raise: { usd: 5 } } }]);
  expect([before?.closed, host.open('run=').map((socket) => socket.query)]).toEqual([
    true,
    [runQuery('beta', FAKE_3_ID)],
  ]);
  expect(toasts().at(-1)).toBe(`ok resume ${FAKE_3_ID}: resumed`);
});
test('a run the watcher has is offered Resume disabled with the reason, and a click posts nothing', async () => {
  await openOffering('beta', FAKE_3_ID, m.beta.runDir);
  expect(
    buttons(host.regions.rail).filter(
      ([, action]) => action === undefined && ['resume', 'restart'].includes(action ?? ''),
    ),
  ).toEqual([]);
  expect(host.regions.rail).toContain('<button class="btn" disabled>resume</button>');
  expect(host.regions.rail).toContain('ticket-to-pr&#39;s watcher has this run: ticket:FAKE-3 is dispatched');
  host.click({ action: 'resume-run' });
  host.click({ action: 'resume-run' });
  await settle();
  expect(host.posts).toEqual([]);
});

test("the open run's actions are read again when the index shows its status change, and the open dialog closes with nothing sent", async () => {
  await openOffering('alpha', FAKE_2_ID, fake2Dir(m));
  host.click({ action: 'restart-run' });
  writeFileSync(join(fake2Dir(m), 'STATUS'), 'running\n');
  host.push(host.open('index')[0], indexMessage());
  await settle();
  host.advance(100);
  expect(host.actionReads).toEqual([`${GOLDEN_PATH}/actions`, `${FAKE_2_PATH}/actions`, `${FAKE_2_PATH}/actions`]);
  expect([host.dialog, host.posts]).toEqual([undefined, []]);
  expect(host.regions.rail).toContain(`run ${FAKE_2_ID} is running`);
  host.push(host.open('index')[0], indexMessage());
  await settle();
  expect(host.actionReads).toHaveLength(3);
});

test("a stage chosen and a raise typed on one run don't carry over to the next opened, which defaults to its own failed stage (review R7)", async () => {
  await openOffering('alpha', FAKE_2_ID, fake2Dir(m));
  host.fields = { stage: 'spec', raise: '7' };
  host.click({ action: 'restart-run' });
  host.advance(100);
  expect(page?.ui.act.drafts['restart-run']?.stage).toBe('spec');
  // The first draw after the switch still finds the fields of the run left behind.
  host.click({ action: 'select-run', repo: 'alpha', run: GOLDEN_RUN_ID });
  host.advance(100);
  expect([page?.ui.act.drafts['restart-run']?.stage, page?.ui.act.drafts['resume-run']?.raise]).toEqual([
    undefined,
    undefined,
  ]);
  host.fields = {};
  host.click({ action: 'run-menu', repo: 'alpha', run: FAKE_2_ID });
  replay(host.open('run=')[0], fake2Dir(m));
  await settle();
  host.advance(100);
  expect(host.regions.rail).toContain(
    '<option value="implement" title="implement#1 and everything after it, in loop fix from iteration 1" selected>',
  );
});

/** The beta queue open in the centre with its stream replayed, and the posts and renders cleared. */
function openBetaQueue() {
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  const [socket] = host.open('queue=');
  for (const event of readEvents(queueDirOf(m))) host.push(socket, { kind: 'queue-event', event });
  host.click({ action: 'select-queue', queue: `beta/${QUEUE_WORKFLOW}` });
  host.advance(100);
  return socket;
}
const BETA = { repo: 'beta', workflow: QUEUE_WORKFLOW };
const QUEUE_PATH = `/api/repos/beta/queues/${QUEUE_WORKFLOW}`;

test('a poll click posts an empty body to the queue poll route; a 200 toasts its message, a 202 its waiting line, a 409 its error, and no answer says so (ADW-460)', async () => {
  openBetaQueue();
  const notices: (string | undefined)[] = [];
  for (const answer of [
    { status: 200, body: JSON.stringify({ message: 'sail queue: polled ticket-to-pr' }) },
    { status: 202, body: JSON.stringify({ waiting: 'the watcher has not taken the command yet' }) },
    { status: 409, body: JSON.stringify({ error: "no watcher is running for 'beta'" }) },
    { status: 0, body: '' },
  ]) {
    host.postAnswer = answer;
    host.click({ action: 'poll-queue', ...BETA });
    await settle();
    host.advance(100);
    notices.push(toasts().at(-1));
  }
  expect(host.posts).toEqual(Array(4).fill({ path: `${QUEUE_PATH}/poll`, body: {} }));
  const head = `poll beta / ${QUEUE_WORKFLOW}`;
  expect(notices).toEqual([
    `ok ${head}: sail queue: polled ticket-to-pr`,
    `ok ${head}: the watcher has not taken the command yet`,
    `bad ${head}: no watcher is running for 'beta'`,
    `bad ${head}: the poll could not be sent: the dashboard did not answer`,
  ]);
  expect(host.regions.toasts).toContain('role="alert"');
});

test('the add form shows once the queue stream has polled tickets; add posts the typed key and force, an empty key posts nothing, and the key is kept across a draw (ADW-460)', async () => {
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  const [socket] = host.open('queue=');
  host.click({ action: 'select-queue', queue: `beta/${QUEUE_WORKFLOW}` });
  host.advance(100);
  expect(host.regions.main).not.toContain('name="add-ticket"');
  for (const event of readEvents(queueDirOf(m))) host.push(socket, { kind: 'queue-event', event });
  host.advance(100);
  expect(host.regions.main).toContain('name="add-ticket"');
  host.click({ action: 'add-ticket', ...BETA });
  await settle();
  expect(host.posts).toEqual([]);
  host.fields['add-ticket'] = '  FAKE-9 ';
  host.fields['add-force'] = 'on';
  host.postAnswer = { status: 200, body: JSON.stringify({ message: 'sail queue: queued ticket:FAKE-9 Nine' }) };
  host.click({ action: 'add-ticket', ...BETA });
  await settle();
  host.advance(100);
  expect(host.posts).toEqual([{ path: `${QUEUE_PATH}/add`, body: { ticketKey: 'FAKE-9', force: true } }]);
  expect(toasts()).toEqual([`ok add beta / ${QUEUE_WORKFLOW}: sail queue: queued ticket:FAKE-9 Nine`]);
  expect(host.regions.main).toContain('value=""');
  host.fields['add-force'] = '';
  host.click({ action: 'add-ticket', ...BETA });
  await settle();
  expect(host.posts[1]).toEqual({ path: `${QUEUE_PATH}/add`, body: { ticketKey: 'FAKE-9' } });
});

test('the first click on drop opens the dialog and posts nothing; its title names the item, its lines what goes, its button the verb (ADW-514)', () => {
  openBetaQueue();
  const row = { ...BETA, item: 'ticket:FAKE-6' };
  host.click({ action: 'item-menu', item: row.item });
  host.click({ action: 'drop-item', ...row });
  expect([host.posts, host.dialogOpens, dialogTitle()]).toEqual([[], 1, 'drop ticket:FAKE-6']);
  expect(host.dialog).toContain(`<li>removes ticket:FAKE-6 from beta / ${QUEUE_WORKFLOW}&#39;s queue</li>`);
  expect(host.dialog).toContain('<li>it is parked after 2 attempts</li>');
  expect(host.dialog).toContain('<button class="btn primary" data-action="dialog-confirm" autofocus>drop</button>');
  expect(host.regions.main).not.toContain('armed');
  expect(page?.ui.itemMenu).toBe('ticket:FAKE-6');
});

test('Enter on the dialog posts the drop once, also when a dialog-confirm click follows it, and the answer is a toast', async () => {
  openBetaQueue();
  host.click({ action: 'item-menu', item: 'ticket:FAKE-5' });
  host.click({ action: 'drop-item', ...BETA, item: 'ticket:FAKE-5' });
  host.postAnswer = { status: 200, body: JSON.stringify({ message: 'sail queue: ticket:FAKE-5 dropped' }) };
  host.press('Enter');
  host.click({ action: 'dialog-confirm' });
  await settle();
  host.advance(100);
  expect([host.posts, host.dialog, host.dialogCloses, toasts()]).toEqual([
    [{ path: `${QUEUE_PATH}/drop`, body: { dedupKey: 'ticket:FAKE-5' } }],
    undefined,
    1,
    ['ok drop ticket:FAKE-5: sail queue: ticket:FAKE-5 dropped'],
  ]);
});

test('Escape and the cancel button close the dialog and post nothing, and Enter on the cancel button posts nothing either', () => {
  openBetaQueue();
  const row = { ...BETA, item: 'ticket:FAKE-6' };
  host.click({ action: 'drop-item', ...row });
  host.press('Escape');
  expect([host.dialog, host.dialogCloses, host.posts]).toEqual([undefined, 1, []]);
  host.click({ action: 'drop-item', ...row });
  host.click({ action: 'dialog-cancel' });
  expect([host.dialog, host.dialogCloses, host.posts]).toEqual([undefined, 2, []]);
  host.click({ action: 'drop-item', ...row });
  host.press('Enter', false, 'dialog-cancel');
  expect([dialogTitle(), host.posts]).toEqual(['drop ticket:FAKE-6', []]);
  host.click({ action: 'dialog-cancel' });
  expect([host.dialog, host.posts]).toEqual([undefined, []]);
});

test('while the dialog is open, j, a and i change nothing', () => {
  openBetaQueue();
  host.click({ action: 'drop-item', ...BETA, item: 'ticket:FAKE-6' });
  const before = [page?.ui.attention, page?.ui.inspector, page?.ui.cursor];
  for (const key of ['j', 'a', 'i']) host.press(key);
  expect([page?.ui.attention, page?.ui.inspector, page?.ui.cursor]).toEqual(before);
  expect(dialogTitle()).toBe('drop ticket:FAKE-6');
});

test("an item's ⋯ opens its menu, one at a time; its ⋯ again, Escape, another control, or its item drawn running shuts it (ADW-464)", () => {
  openBetaQueue();
  const menus = () => [page?.ui.itemMenu, host.regions.main?.match(/class="qmenu"/g)?.length ?? 0];
  expect(menus()).toEqual([undefined, 0]);
  host.click({ action: 'item-menu', item: 'ticket:FAKE-6' });
  host.advance(100);
  expect(menus()).toEqual(['ticket:FAKE-6', 1]);
  expect(host.regions.main).toContain('data-action="requeue-item"');
  host.click({ action: 'item-menu', item: 'ticket:FAKE-5' });
  host.advance(100);
  expect(menus()).toEqual(['ticket:FAKE-5', 1]);
  host.click({ action: 'item-menu', item: 'ticket:FAKE-5' });
  host.advance(100);
  expect(menus()).toEqual([undefined, 0]);
  host.click({ action: 'item-menu', item: 'ticket:FAKE-6' });
  host.click({ action: 'drop-item', ...BETA, item: 'ticket:FAKE-6' });
  host.press('Escape');
  host.advance(100);
  expect([...menus(), host.dialog, page?.ui.queue]).toEqual(['ticket:FAKE-6', 1, undefined, 'beta/ticket-to-pr']);
  host.press('Escape');
  host.advance(100);
  expect(menus()).toEqual([undefined, 0]);
  host.click({ action: 'item-menu', item: 'ticket:FAKE-6' });
  host.click({ action: 'toggle-queue-events' });
  host.advance(100);
  expect(menus()).toEqual([undefined, 0]);
  host.click({ action: 'item-menu', item: 'ticket:FAKE-6' });
  const repos = indexMessage().repos.map((repo) => ({
    ...repo,
    queues: repo.queues.map((view) =>
      view.queue === undefined
        ? view
        : {
            ...view,
            // The server gives an item that runs no drop and no requeue.
            offers: view.offers && { ...view.offers, items: { ...view.offers.items, 'ticket:FAKE-6': {} } },
            queue: {
              ...view.queue,
              items: view.queue.items.map((item) =>
                item.dedupKey === 'ticket:FAKE-6' ? { ...item, state: 'dispatched' as const } : item,
              ),
            },
          },
    ),
  }));
  host.push(host.open('index')[0], { kind: 'index', repos });
  host.advance(100);
  expect(menus()).toEqual([undefined, 0]);
});

test('an open drop dialog closes with nothing sent when its item is drawn dispatched, and asks again once the item can be dropped (review R6)', () => {
  openBetaQueue();
  const row = { ...BETA, item: 'ticket:FAKE-6' };
  host.click({ action: 'drop-item', ...row });
  host.advance(100);
  const withState = (state: string) => {
    const repos = indexMessage().repos.map((repo) => ({
      ...repo,
      queues: repo.queues.map((view) =>
        view.queue === undefined
          ? view
          : {
              ...view,
              offers:
                view.offers &&
                (state === 'dispatched'
                  ? { ...view.offers, items: { ...view.offers.items, [row.item]: {} } }
                  : view.offers),
              queue: {
                ...view.queue,
                items: view.queue.items.map((item) =>
                  item.dedupKey === row.item ? { ...item, state: state as typeof item.state } : item,
                ),
              },
            },
      ),
    }));
    return { kind: 'index', repos };
  };
  host.push(host.open('index')[0], withState('dispatched'));
  host.advance(100);
  host.push(host.open('index')[0], withState('parked'));
  host.advance(100);
  expect([host.dialog, host.dialogCloses, host.posts]).toEqual([undefined, 1, []]);
  host.click({ action: 'drop-item', ...row });
  expect([dialogTitle(), host.posts]).toEqual(['drop ticket:FAKE-6', []]);
});

test("between a requeue's click and its answer the item's row reads requeuing… in place of its state, and the answer takes it away", async () => {
  openBetaQueue();
  host.click({ action: 'requeue-item', ...BETA, item: 'ticket:FAKE-6' });
  host.advance(100);
  expect(host.regions.main).toContain('<span class="c-sub"><span class="busy">requeuing…</span> · ');
  await settle();
  host.advance(100);
  expect(host.regions.main).not.toContain('requeuing…');
});

test('a requeue click posts at once with the dedup key, and a 409 is a red toast quoting the CLI line (ADW-460)', async () => {
  openBetaQueue();
  host.postAnswer = {
    status: 409,
    body: JSON.stringify({ error: 'ticket:FAKE-6 is queued: only a parked or failed item is requeued' }),
  };
  host.click({ action: 'requeue-item', ...BETA, item: 'ticket:FAKE-6' });
  await settle();
  host.advance(100);
  expect([host.posts, toasts()]).toEqual([
    [{ path: `${QUEUE_PATH}/requeue`, body: { dedupKey: 'ticket:FAKE-6' } }],
    ['bad requeue ticket:FAKE-6: ticket:FAKE-6 is queued: only a parked or failed item is requeued'],
  ]);
});

test('Stop opens the dialog on a first click and posts nothing; its confirm posts { now: false }, toasts the answer, and reads the run again', async () => {
  settleQueue();
  await openOffering('beta', FAKE_3_ID, m.beta.runDir);
  host.click({ action: 'stop-run' });
  host.advance(100);
  expect([host.posts, dialogTitle(), dialogLines(), dialogVerb()]).toEqual([
    [],
    `stop ${FAKE_3_ID}`,
    ['stops at its next call boundary', 'the run fails as stopped'],
    'stop',
  ]);
  host.postAnswer = {
    status: 202,
    body: JSON.stringify({ message: `run ${FAKE_3_ID} stops at its next call boundary (pid 7)` }),
  };
  host.click({ action: 'dialog-confirm' });
  host.advance(100);
  expect(host.regions.rail).toContain('<span class="busy">stopping…</span>');
  expect(host.regions.rail).not.toMatch(new RegExp(`<span class="st [^"]*"></span><span class="r-id">${FAKE_3_ID}`));
  await settle();
  host.advance(100);
  expect(host.posts).toEqual([{ path: `${FAKE_3_PATH}/stop`, body: { now: false } }]);
  expect(toasts()).toEqual([`ok stop ${FAKE_3_ID}: run ${FAKE_3_ID} stops at its next call boundary (pid 7)`]);
  expect(host.regions.rail).not.toContain('stopping…');
  expect(host.actionReads.filter((path) => path === `${FAKE_3_PATH}/actions`).length).toBeGreaterThan(1);
});
test('with Stop now ticked, the dialog says so and the post is { now: true }', async () => {
  settleQueue();
  await openOffering('beta', FAKE_3_ID, m.beta.runDir);
  host.fields.now = 'on';
  host.click({ action: 'stop-run' });
  expect(dialogLines()[0]).toBe('ends its running call now');
  host.postAnswer = { status: 202, body: JSON.stringify({ message: 'run X ends its running call now (pid 7)' }) };
  host.click({ action: 'dialog-confirm' });
  await settle();
  expect(host.posts).toEqual([{ path: `${FAKE_3_PATH}/stop`, body: { now: true } }]);
});
test('ticking Stop now only records the tick: no dialog opens and nothing is posted', async () => {
  settleQueue();
  await openOffering('beta', FAKE_3_ID, m.beta.runDir);
  host.fields.now = 'on';
  host.click({ action: 'stop-now' });
  host.advance(100);
  expect([page?.ui.act.drafts['stop-run'], host.dialog, host.posts]).toEqual([{ now: 'on' }, undefined, []]);
});
const domHost = () => {
  const dom = new DomHost(m);
  host = dom;
  return dom;
};

test("a raise typed in the rail's run menu is read from the rail and posted with the resume", async () => {
  settleQueue();
  const dom = domHost();
  await openOffering('beta', FAKE_3_ID, m.beta.runDir);
  dom.field('rail', 'raise').value = '5';
  host.click({ action: 'resume-run' });
  host.advance(100);
  expect(dialogLines()).toEqual(['spent $1.06 of $1.00', 'raises the budget by $5.00']);
  expect(toasts()).toEqual([]);
  expect(host.regions.rail).toContain('name="raise" min="0.01" step="any" value="5"');
  host.click({ action: 'dialog-confirm' });
  await settle();
  expect(host.posts).toEqual([{ path: `${FAKE_3_PATH}/resume`, body: { raise: { usd: 5 } } }]);
});

test("a stage chosen in the rail's run menu is read from the rail, named in the dialog and posted with the restart", async () => {
  const dom = domHost();
  await openOffering('alpha', FAKE_2_ID, fake2Dir(m));
  dom.field('rail', 'stage').value = 'spec';
  host.click({ action: 'restart-run' });
  host.advance(100);
  expect(dialogLines()[0]).toBe('runs again: spec#1 and everything after it');
  host.click({ action: 'dialog-confirm' });
  await settle();
  expect(host.posts).toEqual([{ path: `${FAKE_2_PATH}/restart`, body: { stage: 'spec' } }]);
});

test("stop now ticked in the rail's run menu is read from the rail, stays ticked across the draw, and posts { now: true }", async () => {
  settleQueue();
  const dom = domHost();
  await openOffering('beta', FAKE_3_ID, m.beta.runDir);
  dom.field('rail', 'now').checked = true;
  host.click({ action: 'stop-now' });
  host.click({ action: 'stop-run' });
  host.advance(100);
  expect(dialogLines()[0]).toBe('ends its running call now');
  expect(dom.field('rail', 'now').checked).toBe(true);
  host.click({ action: 'dialog-confirm' });
  await settle();
  expect(host.posts).toEqual([{ path: `${FAKE_3_PATH}/stop`, body: { now: true } }]);
});
test('Clean opens the dialog with what it removes and where the run directory goes, posts {} on confirm, and leaves the run for the index with the cleaned line as a toast', async () => {
  await openOffering('alpha', FAKE_2_ID, fake2Dir(m));
  host.click({ action: 'clean-run' });
  host.advance(100);
  expect([host.posts, dialogTitle(), dialogVerb()]).toEqual([[], `clean ${FAKE_2_ID}`, 'clean']);
  expect(dialogLines()[0]).toBe('removes run ref');
  expect(dialogLines()[1]).toStartWith('run directory → ');
  const cleaned = `cleaned ${FAKE_2_ID}: run ref; run directory -> ~/.sail/failed-runs/2026-11-01/${FAKE_2_ID}`;
  host.postAnswer = { status: 200, body: JSON.stringify({ message: cleaned, removed: ['run ref'], archived: '/x' }) };
  const before = host.open('run=')[0];
  host.click({ action: 'dialog-confirm' });
  await settle();
  host.advance(100);
  expect(host.posts).toEqual([{ path: `${FAKE_2_PATH}/clean`, body: {} }]);
  expect([before?.closed, toasts()]).toEqual([true, [`ok clean ${FAKE_2_ID}: ${cleaned}`]]);
  expect(host.regions.toasts).toContain('role="status"');
});
test('a refused Clean is a red toast quoting its error and the run stays open, and a cancelled dialog posts nothing', async () => {
  await openOffering('alpha', FAKE_2_ID, fake2Dir(m));
  host.click({ action: 'clean-run' });
  host.click({ action: 'dialog-cancel' });
  expect(host.posts).toEqual([]);
  host.click({ action: 'clean-run' });
  host.postAnswer = { status: 409, body: JSON.stringify({ error: 'run X: a queue item names it' }) };
  host.click({ action: 'dialog-confirm' });
  await settle();
  host.advance(100);
  expect(toasts()).toEqual([`bad clean ${FAKE_2_ID}: run X: a queue item names it`]);
  expect(buttons(host.regions.rail).find(([, action]) => action === 'clean-run')?.[0]).toBe('clean');
  expect(page?.ui.runId).toBe(FAKE_2_ID);
  expect(host.posts).toHaveLength(1);
});
/** The page booted on an index whose beta has a live watcher that watches `workflows`, or none. */
function bootWatching(workflows?: string[]) {
  page = boot(host);
  const repos = index(m.registryDir).map((repo) =>
    repo.name === 'beta' && workflows !== undefined
      ? {
          ...repo,
          watching: { pid: 4242, workflows },
          // What the server then offers: unwatch for what is watched, and for the whole set while it holds any.
          offers: {
            watch: { enabled: true },
            ...(workflows.length === 0 ? {} : { unwatch: { enabled: true } }),
            workflows: Object.fromEntries(workflows.map((name) => [name, { unwatch: { enabled: true } }])),
          },
        }
      : repo,
  );
  host.push(host.open('index')[0], { kind: 'index', repos });
  host.advance(100);
}
const watchClick = (op: string, workflow?: string) =>
  host.click({ action: op, repo: 'beta', ...(workflow === undefined ? {} : { workflow }) });
/** What watch and unwatch answered, as toasts. */
const watchToasts = () => toasts();

test('a Watch click posts the workflow to the repository watch route at once, and says it is watching until the answer', async () => {
  bootWatching();
  host.postAnswer = { status: 200, body: JSON.stringify({ message: 'sail watch: it watches ticket-to-pr' }) };
  watchClick('watch', QUEUE_WORKFLOW);
  expect(host.posts).toEqual([{ path: '/api/repos/beta/watch', body: { workflows: [QUEUE_WORKFLOW] } }]);
  expect(page?.ui.underway).toEqual({ [`watch:beta/${QUEUE_WORKFLOW}`]: 'watching…' });
  await settle();
  expect([page?.ui.underway, watchToasts()]).toEqual([
    {},
    [`ok watch beta / ${QUEUE_WORKFLOW}: sail watch: it watches ticket-to-pr`],
  ]);
  host.advance(100);
  expect(host.regions.rail).not.toContain('<div class="lgrp-p">sail watch: it watches ticket-to-pr</div>');
});

test('an Unwatch click posts the workflow to the unwatch route at once, with no dialog and no armed button', async () => {
  bootWatching([QUEUE_WORKFLOW]);
  host.click({ action: 'toggle-group', group: 'beta' });
  host.click({ action: 'toggle-group', group: `beta/${QUEUE_WORKFLOW}` });
  host.advance(100);
  expect(host.regions.rail).toContain(
    'data-action="unwatch" data-repo="beta" data-workflow="ticket-to-pr">unwatch</button>',
  );
  host.postAnswer = { status: 200, body: JSON.stringify({ message: 'sail unwatch: done' }) };
  watchClick('unwatch', QUEUE_WORKFLOW);
  expect(host.posts).toEqual([{ path: '/api/repos/beta/unwatch', body: { workflows: [QUEUE_WORKFLOW] } }]);
  expect([host.dialog, page?.ui.underway]).toEqual([undefined, { [`watch:beta/${QUEUE_WORKFLOW}`]: 'unwatching…' }]);
  host.advance(100);
  expect(host.regions.rail).not.toContain('armed');
});

test('an Unwatch toast has an undo that posts the watch with the same body and takes the toast away; the undo toast is drawn at 7,999 ms and gone at 8,000 ms', async () => {
  bootWatching([QUEUE_WORKFLOW]);
  host.postAnswer = { status: 200, body: JSON.stringify({ message: 'sail unwatch: done' }) };
  watchClick('unwatch', QUEUE_WORKFLOW);
  await settle();
  host.advance(100);
  expect(host.regions.toasts).toContain('data-action="undo-toast" data-toast="1">undo</button>');
  host.advance(7_899);
  host.advance(0);
  expect(page?.ui.toasts.map((each) => each.id)).toEqual([1]);
  host.advance(1);
  expect(page?.ui.toasts).toEqual([]);
  // The same again, taken by the undo.
  watchClick('unwatch', QUEUE_WORKFLOW);
  await settle();
  host.postAnswer = { status: 200, body: JSON.stringify({ message: 'sail watch: it watches ticket-to-pr' }) };
  host.click({ action: 'undo-toast', toast: '2' });
  expect(host.posts.at(-1)).toEqual({ path: '/api/repos/beta/watch', body: { workflows: [QUEUE_WORKFLOW] } });
  expect(page?.ui.toasts).toEqual([]);
  await settle();
  expect(toasts()).toEqual([`ok watch beta / ${QUEUE_WORKFLOW}: sail watch: it watches ticket-to-pr`]);
});

test('Watch all posts an empty list at once, and Unwatch all posts one at once and undoes with the workflows watched before the click', async () => {
  bootWatching([QUEUE_WORKFLOW]);
  watchClick('watch');
  expect(host.posts).toEqual([{ path: '/api/repos/beta/watch', body: { workflows: [] } }]);
  await settle();
  host.posts.length = 0;
  host.postAnswer = { status: 200, body: JSON.stringify({ message: 'sail unwatch: all' }) };
  watchClick('unwatch');
  expect(host.posts).toEqual([{ path: '/api/repos/beta/unwatch', body: { workflows: [] } }]);
  await settle();
  host.click({ action: 'undo-toast', toast: String(page?.ui.toasts.at(-1)?.id) });
  expect(host.posts.at(-1)).toEqual({ path: '/api/repos/beta/watch', body: { workflows: [QUEUE_WORKFLOW] } });
  await settle();
});

test('a 202 toasts its waiting line, a 409 the CLI refusal, and no answer says so', async () => {
  bootWatching();
  const notices: (string | undefined)[] = [];
  for (const answer of [
    { status: 202, body: JSON.stringify({ message: 'the watcher of beta (pid 7) starts', pid: 7 }) },
    { status: 202, body: JSON.stringify({ waiting: 'the watcher has not taken the command yet' }) },
    { status: 409, body: JSON.stringify({ error: 'sail watch: no workflow declares a watch' }) },
    { status: 0, body: '' },
  ]) {
    host.postAnswer = answer;
    watchClick('watch');
    await settle();
    notices.push(watchToasts().at(-1));
  }
  expect(notices).toEqual([
    'ok watch all beta: the watcher of beta (pid 7) starts',
    'ok watch all beta: the watcher has not taken the command yet',
    'bad watch all beta: sail watch: no workflow declares a watch',
    'bad watch all beta: the watch could not be sent: the dashboard did not answer',
  ]);
});

describe('all clear', () => {
  const badge = () => host.regions.attention?.match(/<span class="badge">(\d+)<\/span>/)?.[1];
  const pushIndex = (change?: (repos: ReturnType<typeof index>) => void) => {
    const repos = index(m.registryDir);
    change?.(repos);
    host.push(host.open('index')[0], { kind: 'index', repos });
    host.advance(100);
  };
  const bootOpen = (change?: (repos: ReturnType<typeof index>) => void) => {
    page = boot(host);
    pushIndex(change);
    host.click({ action: 'toggle-attention' });
    host.advance(100);
  };

  test('one click empties the list and the count, shows nothing needs attention, posts nothing and leaves the failed run in the rail', () => {
    bootOpen();
    host.click({ action: 'toggle-group', group: 'alpha' });
    host.click({ action: 'toggle-group', group: 'alpha/ticket-to-pr' });
    host.click({ action: 'toggle-section', section: 'alpha/ticket-to-pr:failed' });
    host.advance(100);
    expect(host.regions.rail).toContain(`data-run="${FAKE_2_ID}"`);
    expect(badge()).toBe('4');
    expect(host.regions.attention).toContain('data-action="clear-attention">all clear</button>');
    host.click({ action: 'clear-attention' });
    host.advance(100);
    expect(badge()).toBeUndefined();
    expect(host.regions.attention).toContain('nothing needs attention');
    expect(host.regions.attention).not.toContain('all clear');
    expect(host.posts).toEqual([]);
    expect(host.regions.rail).toContain(`data-run="${FAKE_2_ID}"`);
  });

  test('all clear answers in a toast with an undo, which lists the same items again and takes only its own identities out of storage', async () => {
    bootOpen();
    const other = 'another tab: a cleared thing';
    host.storage.set(CLEARED_KEY, JSON.stringify([other]));
    host.click({ action: 'clear-attention' });
    host.advance(100);
    expect(toasts()).toEqual(['ok all clear: 4 hidden']);
    expect(page?.ui.toasts[0]?.undo).toBe(true);
    expect(badge()).toBeUndefined();
    const saved: string[] = JSON.parse(host.storage.get(CLEARED_KEY) ?? '[]');
    expect(saved).toContain(other);
    expect(saved).toHaveLength(5);
    host.click({ action: 'undo-toast', toast: '1' });
    host.advance(100);
    expect(badge()).toBe('4');
    expect(JSON.parse(host.storage.get(CLEARED_KEY) ?? '[]')).toEqual([other]);
    expect(page?.ui.toasts).toEqual([]);
    expect(host.posts).toEqual([]);
  });

  test('the clear survives a reboot over the same storage', () => {
    bootOpen();
    host.click({ action: 'clear-attention' });
    page?.stop();
    bootOpen();
    expect(badge()).toBeUndefined();
    expect(host.regions.attention).toContain('nothing needs attention');
  });

  test('a new failure, and a cleared parked item whose attempts changed, are listed after a clear', () => {
    bootOpen();
    host.click({ action: 'clear-attention' });
    pushIndex((repos) => {
      const run = repos.find((repo) => repo.name === 'beta')?.runs.find((each) => each.runId === FAKE_3_ID);
      if (run) run.status = { status: 'failed', stopReason: 'stage_error' };
    });
    expect(badge()).toBe('1');
    expect(host.regions.attention).toContain('failed: stage_error');
    pushIndex((repos) => {
      for (const view of repos.find((repo) => repo.name === 'beta')?.queues ?? [])
        for (const item of view.queue?.items ?? []) if (item.state === 'parked') item.attempts = 3;
    });
    expect(badge()).toBe('1');
    expect(host.regions.attention).toContain('ticket:FAKE-6 parked after 3 attempts');
  });

  test('a failure that arrives before the pane is drawn again is not cleared with the rows on screen', () => {
    bootOpen();
    host.push(host.open('index')[0], {
      kind: 'index',
      repos: (() => {
        const repos = index(m.registryDir);
        const run = repos.find((repo) => repo.name === 'beta')?.runs.find((each) => each.runId === FAKE_3_ID);
        if (run) run.status = { status: 'failed', stopReason: 'stage_error' };
        return repos;
      })(),
    });
    host.click({ action: 'clear-attention' });
    host.advance(100);
    expect(badge()).toBe('1');
    expect(host.regions.attention).toContain('failed: stage_error');
  });

  test('a prune keeps what another tab cleared in storage since this one loaded it', () => {
    const fails = (repos: ReturnType<typeof index>) => {
      const run = repos.find((repo) => repo.name === 'beta')?.runs.find((each) => each.runId === FAKE_3_ID);
      if (run) run.status = { status: 'failed', stopReason: 'stage_error' };
    };
    const changed = (repos: ReturnType<typeof index>) => {
      fails(repos);
      for (const view of repos.find((repo) => repo.name === 'beta')?.queues ?? [])
        for (const item of view.queue?.items ?? []) if (item.state === 'parked') item.attempts = 3;
    };
    bootOpen();
    host.click({ action: 'clear-attention' });
    // Another tab clears the new failure: its identity joins the four this tab cleared.
    const failure = (() => {
      const repos = index(m.registryDir);
      fails(repos);
      return attention(repos).find((item) => item.kind === 'failed' && item.runId === FAKE_3_ID);
    })();
    if (failure === undefined) throw new Error('no failure of FAKE-3');
    const stored: string[] = JSON.parse(host.storage.get(CLEARED_KEY) ?? '[]');
    host.storage.set(CLEARED_KEY, JSON.stringify([...stored, identity(failure)]));
    // This tab's next index no longer lists the parked item it cleared, so it prunes and saves.
    pushIndex(changed);
    page?.stop();
    bootOpen(changed);
    expect(badge()).toBe('1');
    expect(host.regions.attention).toContain('ticket:FAKE-6 parked after 3 attempts');
    expect(host.regions.attention).not.toContain('failed: stage_error');
  });

  test('identities the newest index no longer lists are dropped from storage, and the listed ones stay', () => {
    host.storage.set(CLEARED_KEY, JSON.stringify(['gone']));
    bootOpen();
    expect(host.storage.get(CLEARED_KEY)).toBe('[]');
    host.click({ action: 'clear-attention' });
    const kept = host.storage.get(CLEARED_KEY);
    expect(JSON.parse(kept ?? '[]')).toHaveLength(4);
    pushIndex();
    expect(host.storage.get(CLEARED_KEY)).toBe(kept);
  });

  test('a stored value that is not a list of strings clears nothing', () => {
    for (const bad of ['nope', '{"a":1}', '[1,"a"]']) {
      host.storage.set(CLEARED_KEY, bad);
      bootOpen();
      expect(badge()).toBe('4');
      page?.stop();
    }
  });
});
