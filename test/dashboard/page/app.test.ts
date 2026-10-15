// The page's shell, driven through a fake host (D3, D10): sockets the test pushes messages into, timers it runs by
// hand, and REST reads answered from the seeded fixtures' own files through the dashboard's file module. Every
// assertion is on what the shell rendered into a region, or on the sockets and reads it asked the host for.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { callFile, findRepo, findRunDir, index } from '../../../src/dashboard/files';
import { boot, type Page, THEME_KEY } from '../../../src/dashboard/page/app';
import type { ConnectHandlers, PageHost, Region } from '../../../src/dashboard/page/host';
import { readEvents } from '../../../src/events/consumers/ndjson';
import {
  FAKE_2_ID,
  fake2Dir,
  GOLDEN_RUN_ID,
  type Machine,
  QUEUE_WORKFLOW,
  queueDirOf,
  RUNNING_ID,
  runningCopy,
  seedFixtures,
} from '../../helpers/dashboard';

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
  clock = Date.parse('2026-10-01T12:00:00.000Z');
  private timers = new Map<number, { at: number; fn: () => void }>();
  private next = 1;
  private action?: (action: string, data: Record<string, string>) => void;
  private key?: (key: string, inInput: boolean) => void;

  constructor(private readonly machine: Machine) {}

  render(region: Region, html: string) {
    this.regions[region] = html;
    this.renders.push(region);
  }
  onAction(handler: (action: string, data: Record<string, string>) => void) {
    this.action = handler;
  }
  onKey(handler: (key: string, inInput: boolean) => void) {
    this.key = handler;
  }
  get(path: string) {
    return new Promise<{ status: number; body: string }>((done) => {
      const read = { path, resolve: () => done(this.answer(path)) };
      this.reads.push(read);
      if (!this.hold) read.resolve();
    });
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
  async copy(text: string) {
    this.copied.push(text);
    return true;
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
  press(key: string, inInput = false) {
    this.key?.(key, inInput);
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

test('boot renders the rail with alpha and beta from the first index, opens the newest run, and renders its nine cards, each region once a flush', () => {
  page = boot(host);
  expect(host.sockets.map((socket) => socket.query)).toEqual(['index=1']);
  host.advance(100);
  expect(host.renders.sort()).toEqual(['attention', 'inspector', 'main', 'queues', 'rail', 'status']);
  host.push(host.open('index')[0], indexMessage());
  expect(host.open('run=').map((socket) => socket.query)).toEqual([runQuery('alpha', GOLDEN_RUN_ID)]);
  replay(host.open('run=')[0], GOLDEN());
  host.renders = [];
  host.advance(99);
  expect(host.renders).toEqual([]);
  host.advance(1);
  expect(host.renders.sort()).toEqual(['attention', 'inspector', 'main', 'queues', 'rail', 'status']);
  expect(host.regions.rail).toContain('<span class="nm">alpha</span>');
  expect(host.regions.rail).toContain('<span class="nm">beta</span>');
  expect(host.regions.rail).toContain(
    `<button class="run sel" data-action="select-run" data-repo="alpha" data-run="${GOLDEN_RUN_ID}">`,
  );
  expect(cards(host.regions.main)).toEqual([
    'intake#1',
    'spec#1',
    'implement#1',
    'tests#1',
    'implement#2',
    'tests#2',
    'self-review#1',
    'describe#1',
    'open#1',
  ]);
  expect(host.regions.status).toContain('<span>ended completed</span>');
  expect(host.regions.attention).toContain('needs attention · 6');
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
  expect(host.regions.main).toContain('<div class="card cursor sel" data-action="select-card" data-key="implement#1">');
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
  expect(host.regions.main).toMatch(/<span class="c-name">tests#1<\/span><span class="pill p-fail">failed<\/span>/);
  expect(host.regions.status).toContain('<span>● live</span>');
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
  expect(cards(host.regions.main)).toHaveLength(9);
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
  host.advance(100);
  expect(host.regions.queues).toContain('<span class="pill p-skip">unknown</span>');
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
  expect(host.regions.main).toContain('data-key="open#1"');
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

test("with no queue the queues region is empty and no queue socket opens; with beta's, queue=beta/ticket-to-pr renders its recent events and watched", () => {
  rmSync(join(m.beta.clone, '.sail-runs', 'queue'), { recursive: true });
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  host.advance(100);
  expect([host.regions.queues, host.open('queue=')]).toEqual(['', []]);
  page.stop();
  m.remove();
  m = seedFixtures();
  host = new FakeHost(m);
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  const sockets = host.open('queue=');
  expect(sockets.map((socket) => socket.query)).toEqual([`queue=${encodeURIComponent(`beta/${QUEUE_WORKFLOW}`)}`]);
  for (const event of readEvents(queueDirOf(m))) host.push(sockets[0], { kind: 'queue-event', event });
  host.advance(100);
  expect(host.regions.queues).toContain('<span class="pill p-pass">watched</span>');
  expect(host.regions.queues).toContain('<span class="tname">queue:parked</span>');
  expect(host.regions.queues?.match(/<div class="ev">/g)).toHaveLength(9);
  rmSync(join(m.beta.clone, '.sail-runs', 'queue'), { recursive: true });
  host.push(host.open('index')[0], indexMessage());
  expect([sockets[0]?.closed, host.open('queue=')]).toEqual([true, []]);
});

test('keys move the cursor, Enter selects, ] and [ step, Escape deselects, i toggles the inspector, and a key typed in an input does nothing', () => {
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  replay(host.open('run=')[0], GOLDEN());
  const cursor = () =>
    /<div class="card cursor[^"]*" data-action="select-card" data-key="([^"]+)"/.exec(host.regions.main ?? '')?.[1];
  host.press('j');
  host.press('ArrowDown');
  host.press('j', true);
  host.advance(100);
  expect(cursor()).toBe('implement#1');
  host.press('k');
  host.press('Enter');
  expect(page.ui.key).toBe('spec#1');
  host.press(']');
  host.press(']');
  expect(page.ui.key).toBe('tests#1');
  host.press('[');
  expect(page.ui.key).toBe('implement#1');
  host.press('Escape');
  expect(page.ui.key).toBeUndefined();
  host.press('i');
  expect(host.inspector).toBe(false);
  host.press('i');
  expect(host.inspector).toBe(true);
  for (let i = 0; i < 20; i++) host.press('ArrowRight');
  host.advance(100);
  expect(cursor()).toBe('open#1');
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
  host.click({ action: 'toggle-follow' });
  expect(page.ui.follow).toBe(false);
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
