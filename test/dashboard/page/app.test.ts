// The page's shell, driven through a fake host (D3, D10): sockets the test pushes messages into, timers it runs by
// hand, and REST reads answered from the seeded fixtures' own files through the dashboard's file module. Every
// assertion is on what the shell rendered into a region, or on the sockets and reads it asked the host for.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { takeLease } from '../../../src/adapters/leases';
import { runActions } from '../../../src/dashboard/actions';
import { callFile, findRepo, findRunDir, index } from '../../../src/dashboard/files';
import type { Subject } from '../../../src/dashboard/page/action-registry';
import {
  boot,
  CLEARED_KEY,
  COPIED_MS,
  FILTER_KEY,
  FLUSH_MS,
  LIST_KEY,
  type Page,
  THEME_KEY,
} from '../../../src/dashboard/page/app';
import { attention, identity } from '../../../src/dashboard/page/attention';
import { focused, setFocus } from '../../../src/dashboard/page/focus';
import { browserHost, type ConnectHandlers, type PageHost, type Region } from '../../../src/dashboard/page/host';
import { listRepos, newestFirst } from '../../../src/dashboard/page/index-model';
import { offerSignature, readSubjectOffers } from '../../../src/dashboard/page/reads';
import { sourceFor } from '../../../src/dashboard/page/store';
import { toast } from '../../../src/dashboard/page/toast';
import { HINT_MS } from '../../../src/dashboard/page/toasts';
import type { QueueWatch } from '../../../src/dashboard/watch-state';
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
  /** What the host was told about the inspector, in order: whether it is open and whether it is pinned. */
  inspectors: [boolean, boolean][] = [];
  get inspector() {
    return this.inspectors.at(-1);
  }
  /** The query the page's URL holds, as start() gives it. */
  startAt: Record<string, string> = {};
  clock = Date.parse('2026-10-01T12:00:00.000Z');
  private timers = new Map<number, { at: number; fn: () => void }>();
  /** How many timers are waiting. */
  get pendingTimers() {
    return this.timers.size;
  }
  private next = 1;
  private action?: (action: string, data: Record<string, string>) => void;
  private key?: (key: string, inInput: boolean, on?: string, mod?: boolean) => boolean;

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
  onKey(handler: (key: string, inInput: boolean, on?: string, mod?: boolean) => boolean) {
    this.key = handler;
  }
  /** How many times the menu was asked to take the focus. */
  menuFocuses = 0;
  focusMenu() {
    this.menuFocuses++;
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
    this.dialogFields = {};
    this.dialogCloses++;
  }
  /** The values of the dialog's fields, by name, and how many times the dialog was drawn again. */
  dialogFields: Record<string, string> = {};
  dialogRedraws = 0;
  dialogValue(name: string) {
    return this.dialogFields[name];
  }
  /** Draws `html` into the dialog's `#dialog-body`, as the browser host does, leaving its buttons. */
  redrawDialog(html: string) {
    const body = /<div id="dialog-body">[\s\S]*<\/div>(?=<div class="dlg-acts">)/;
    this.dialog =
      this.dialog !== undefined && body.test(this.dialog)
        ? this.dialog.replace(body, () => `<div id="dialog-body">${html}</div>`)
        : html;
    this.dialogRedraws++;
  }
  /** The reads of a run's actions: answered at once, and kept apart from the reads of its calls. */
  actionReads: string[] = [];
  /** While set, the reads of a run's actions wait for it. */
  actionsHold: Promise<void> | undefined;
  /** When set, a run's actions wait for `releaseActions()`, as a slow answer lands after the page's flush. */
  holdActions = false;
  private heldActions: (() => void)[] = [];
  releaseActions() {
    for (const release of this.heldActions.splice(0)) release();
  }
  get(path: string) {
    if (path.endsWith('/actions')) {
      this.actionReads.push(path);
      if (this.actionsHold !== undefined) return this.actionsHold.then(() => this.actionsAnswer(path));
      if (!this.holdActions) return this.actionsAnswer(path);
      return new Promise<{ status: number; body: string }>((done) => {
        this.heldActions.push(() => done(this.actionsAnswer(path)));
      });
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
  /** While set, the POSTs wait for it. */
  postHold: Promise<void> | undefined;
  async post(path: string, body: unknown) {
    this.posts.push({ path, body });
    if (this.postHold !== undefined) await this.postHold;
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
  /** The links opened in a new tab, in order. */
  links: string[] = [];
  openLink(url: string) {
    this.links.push(url);
  }
  /** Whether the clipboard takes a copy. */
  copyTakes = true;
  async copy(text: string) {
    this.copied.push(text);
    return this.copyTakes;
  }
  href() {
    const query = this.urls.at(-1)?.query ?? new URLSearchParams(this.startAt).toString();
    return `http://dashboard/${query === '' ? '' : `?${query}`}`;
  }
  setTheme(theme: string) {
    this.theme = theme;
  }
  /** What the host was told about a run or queue beside the list, in order. */
  details: boolean[] = [];
  setDetail(open: boolean) {
    this.details.push(open);
  }
  /** What the host was told of the keyed pane, in order: `none` while only one pane shows. */
  keyPanes: string[] = [];
  setKeys(pane: 'list' | 'centre' | undefined) {
    this.keyPanes.push(pane ?? 'none');
  }
  private press_?: (region: Region | undefined) => void;
  onPress(handler: (region: Region | undefined) => void) {
    this.press_ = handler;
  }
  /** A mouse button going down in `region`, before the click it makes. */
  pressIn(region: Region | undefined) {
    this.press_?.(region);
  }
  /** Whether the window is under 800px, where no first row is selected: most tests leave it so, and the ones about selecting set it false. */
  narrowed = true;
  narrow() {
    return this.narrowed;
  }
  /** The filter field's typing handler, the fields focused by name, the blurs, and the regions revealed. */
  private input?: (name: string, value: string) => void;
  focused: string[] = [];
  private point_?: (
    kind: 'hover' | 'context' | 'focus',
    data: Record<string, string> | undefined,
    at: { x: number; y: number },
  ) => boolean | undefined;
  onPoint(handler: NonNullable<FakeHost['point_']>) {
    this.point_ = handler;
  }
  /** The pointer reaching a row's dataset (or no row), as the browser host reports it. */
  point(kind: 'hover' | 'context' | 'focus', data: Record<string, string> | undefined, at = { x: 0, y: 0 }) {
    return this.point_?.(kind, data, at);
  }
  blurs = 0;
  revealed: Region[] = [];
  onInput(handler: (name: string, value: string) => void) {
    this.input = handler;
  }
  focus(name: string) {
    this.focused.push(name);
  }
  blur() {
    this.blurs++;
  }
  /** The regions whose selected row was revealed, apart from `revealed`'s cursor ones. */
  revealedOpen: Region[] = [];
  reveal(region: Region, what: 'cur' | 'sel' = 'cur') {
    (what === 'sel' ? this.revealedOpen : this.revealed).push(region);
  }
  /** Types `value` into the field `name`. */
  type(name: string, value: string) {
    this.input?.(name, value);
  }
  /** What the host was told about the folded sidebar, in order. */
  sidebars: boolean[] = [];
  setSidebar(open: boolean) {
    this.sidebars.push(open);
  }
  setInspector(open: boolean, pinned: boolean) {
    this.inspectors.push([open, pinned]);
  }
  offset() {
    return 0;
  }
  start() {
    return this.startAt;
  }
  private navigated?: (asked: Record<string, string>) => void;
  onNavigate(handler: (asked: Record<string, string>) => void) {
    this.navigated = handler;
  }
  /** The browser moving to the history entry whose query is `query`. */
  go(query: string) {
    this.navigated?.(Object.fromEntries(new URLSearchParams(query)));
  }
  /** The URL writes made, in order. */
  urls: { query: string; push: boolean }[] = [];
  setUrl(query: string, push: boolean) {
    this.urls.push({ query, push });
    return true;
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
  press(key: string, inInput = false, on?: string, mod = false) {
    return this.key?.(key, inInput, on, mod);
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
/**
 * `offers` as the server gives them for `watch`: each enabled while the workflow is watched, else disabled with its
 * reason, since the server says both from the one live watcher.
 */
function offersFor<T>(offers: T, watch: QueueWatch): T {
  const offer = watch.state === 'watched' ? { enabled: true } : { enabled: false, why: watch.why };
  const each = (value: unknown): unknown =>
    value !== null && typeof value === 'object'
      ? 'enabled' in value
        ? { ...offer }
        : Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, each(inner)]))
      : value;
  return each(offers) as T;
}
/** The index as the server sends it; the queues are watched, as `index()` gives them for a live watcher that watches them, unless `watch` says otherwise. */
const indexMessage = (watch: QueueWatch = { state: 'watched' }) => ({
  kind: 'index',
  repos: index(m.registryDir).map((repo) => ({
    ...repo,
    queues: repo.queues.map((queue) => ({ ...queue, watch, offers: offersFor(queue.offers, watch) })),
  })),
});
const replay = (socket: FakeSocket | undefined, dir: string, end = true) => {
  for (const event of readEvents(dir)) host.push(socket, { kind: 'event', event });
  if (end) host.push(socket, { kind: 'end' });
};
const cards = (region: string | undefined) => [...(region ?? '').matchAll(/data-key="([^"]+)"/g)].map(([, key]) => key);
const runQuery = (repo: string, runId: string) => `run=${encodeURIComponent(`${repo}/${runId}`)}`;
const GOLDEN = () => m.alpha.runDir;
/** The first index, then a click on the row of the newest running run, else the newest: the shell opens no run by itself. */
const firstIndex = (runId?: string) => {
  host.push(host.open('index')[0], indexMessage());
  const all = newestFirst(
    listRepos(index(m.registryDir), host.clock).flatMap((repo) =>
      repo.runs.map((run) => ({ ...run, repo: repo.name })),
    ),
  );
  const first = all.find((run) => run.runId === runId) ?? all.find((run) => run.status === 'running') ?? all[0];
  if (first !== undefined) host.click({ action: 'select-run', repo: first.repo, run: first.runId });
};
const plainIndex = () => host.push(host.open('index')[0], indexMessage());

describe('audit 2: rows say what they are (ADW-543)', () => {
  const FAKE_1 = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';
  const FAKE_1_ROW = `run:alpha/${FAKE_1}`;
  const FAKE_2_ROW = `run:alpha/${FAKE_2_ID}`;
  /** The dataset of a run's row, as the browser host reads it from the element the focus reached. */
  const runRowData = (runId: string) => ({ row: `run:alpha/${runId}`, subject: 'run', repo: 'alpha', run: runId });
  /** History from 800px up, its first row FAKE-1 opened unasked: entries 09-25, FAKE-1, 09-23, FAKE-2, 09-22, FAKE-4. */
  const onHistory = () => {
    host.narrowed = false;
    page = boot(host);
    plainIndex();
    host.press('4');
    host.advance(100);
    return page;
  };

  test('a view opens with the list cursor on the row it opened: x picks it, and the picked row carries a tick', () => {
    const p = onHistory();
    expect([p.ui.runId, p.ui.listCursor]).toEqual([FAKE_1, FAKE_1_ROW]);
    expect(host.regions.list).toContain(`class="run lrow sel cur" data-row="${FAKE_1_ROW}"`);
    host.press('x');
    host.advance(100);
    expect(p.ui.listSelected).toEqual([FAKE_1_ROW]);
    expect(host.regions.list).toContain(
      `data-run="${FAKE_1}"><span class="r-line"><span class="r-tick" aria-hidden="true">✓</span>`,
    );
    expect(host.regions.list?.match(/class="r-tick"/g)).toHaveLength(1);
  });

  test('a click that opens a row puts the list cursor on it', () => {
    const p = onHistory();
    host.click({ action: 'select-run', repo: 'alpha', run: FAKE_2_ID });
    expect([p.ui.runId, p.ui.listCursor]).toEqual([FAKE_2_ID, FAKE_2_ROW]);
  });

  test('the focus reaching a row, by Tab, takes the list cursor, the keys and the subject, so . opens that row', () => {
    const p = onHistory();
    host.pressIn('main');
    expect(p.ui.pane).toBe('centre');
    host.point('focus', runRowData(FAKE_2_ID));
    expect([p.ui.listCursor, p.ui.pane, p.ui.runId]).toEqual([FAKE_2_ROW, 'list', FAKE_1]);
    expect(focused(p.ui)).toEqual({ kind: 'run', repo: 'alpha', runId: FAKE_2_ID });
    host.advance(100);
    expect(host.regions.list).toContain(`class="run lrow cur" data-row="${FAKE_2_ROW}"`);
    host.press('.');
    expect([p.ui.runId, p.ui.runMenu?.runId]).toEqual([FAKE_2_ID, FAKE_2_ID]);
  });

  test('a focus on the row that has the cursor, on no row, or while the menu is open changes nothing and draws nothing', () => {
    const p = onHistory();
    host.advance(100);
    host.renders = [];
    host.point('focus', runRowData(FAKE_1));
    host.point('focus', undefined);
    host.advance(100);
    expect(host.renders).toEqual([]);
    expect(p.ui.listCursor).toBe(FAKE_1_ROW);
    host.press('k', false, undefined, true);
    host.advance(100);
    expect(p.ui.menu).toBeDefined();
    host.point('focus', runRowData(FAKE_2_ID));
    expect([p.ui.listCursor, focused(p.ui)]).toEqual([FAKE_1_ROW, { kind: 'run', repo: 'alpha', runId: FAKE_1 }]);
  });

  test('a queue item the focus reaches is the subject, and moves no list cursor; under 800px a row takes the cursor alone', () => {
    host.narrowed = true;
    page = boot(host);
    plainIndex();
    host.press('4');
    host.advance(100);
    const pane = page.ui.pane;
    host.point('focus', runRowData(FAKE_2_ID));
    expect([page.ui.listCursor, page.ui.pane]).toEqual([FAKE_2_ROW, pane]);
    host.point('focus', { subject: 'item', repo: 'beta', workflow: QUEUE_WORKFLOW, item: 'ticket:FAKE-6' });
    expect(page.ui.listCursor).toBe(FAKE_2_ROW);
    expect(focused(page.ui)).toEqual({ kind: 'item', repo: 'beta', workflow: QUEUE_WORKFLOW, item: 'ticket:FAKE-6' });
  });
});

test('boot draws the sidebar and the list from the first index and opens no run; a click on a row opens it beside the list with its eight cards, each region once a flush', () => {
  page = boot(host);
  expect(host.sockets.map((socket) => socket.query)).toEqual(['index=1']);
  host.advance(100);
  expect(host.renders.sort()).toEqual([
    'drawer',
    'inspector',
    'link',
    'list',
    'main',
    'menu',
    'sidebar',
    'status',
    'toasts',
  ]);
  plainIndex();
  expect(host.open('run=')).toEqual([]);
  host.renders = [];
  host.advance(100);
  expect(host.renders.sort()).toEqual(['list', 'main', 'sidebar', 'status']);
  expect(host.regions.status).toContain('<span>Active</span><span>1 waiting on you</span>');
  expect(host.regions.sidebar).toContain('<span class="nm">alpha</span>');
  expect(host.regions.sidebar).toContain('<span class="nm">beta</span>');
  expect(host.regions.list).toContain('<span class="lh-t">Active</span><span class="c">1</span>');
  expect(host.regions.main).toContain('No run selected');
  expect(host.details).toEqual([false]);
  host.click({ action: 'select-view', view: 'history' });
  host.advance(100);
  expect(host.regions.list).toContain(`data-action="select-run" data-repo="alpha" data-run="${GOLDEN_RUN_ID}"`);
  host.click({ action: 'select-run', repo: 'alpha', run: GOLDEN_RUN_ID });
  expect(host.open('run=').map((socket) => socket.query)).toEqual([runQuery('alpha', GOLDEN_RUN_ID)]);
  replay(host.open('run=')[0], GOLDEN());
  host.renders = [];
  host.advance(99);
  expect(host.renders).toEqual([]);
  host.advance(1);
  expect(host.renders.sort()).toEqual(['list', 'main', 'status']);
  expect(host.regions.list).toContain(`class="run lrow sel cur" data-row="run:alpha/${GOLDEN_RUN_ID}"`);
  expect(host.details).toEqual([false, true]);
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
  expect(host.regions.sidebar).toContain('data-view="inbox"');
  expect(Object.keys(host.regions)).not.toContain('attention');
});

test("opening FAKE-2's denial closes the golden run's socket, opens FAKE-2's, reads implement#1's result, and renders its permissions tab", async () => {
  page = boot(host);
  firstIndex();
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
  plainIndex();
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

test('a URL naming a run no repository lists opens no run and leaves the list alone in the centre (review R12)', () => {
  host.startAt = { repo: 'alpha', run: 'FAKE-9-01M5PY0000000000000000000' };
  page = boot(host);
  plainIndex();
  host.advance(100);
  expect([host.open('run='), page.ui.runId, host.details.at(-1) ?? false]).toEqual([[], undefined, false]);
  expect(host.regions.toasts).toContain('run FAKE-9-01M5PY0000000000000000000 of alpha is not listed');
  expect(host.urls).toEqual([{ query: '', push: false }]);
});

test('the URL is read on the first index only: a run picked since stays open through the next index', () => {
  host.startAt = { repo: 'alpha', run: FAKE_2_ID };
  page = boot(host);
  plainIndex();
  expect(host.open('run=').map((socket) => socket.query)).toEqual([runQuery('alpha', FAKE_2_ID)]);
  host.click({ action: 'select-run', repo: 'alpha', run: GOLDEN_RUN_ID });
  firstIndex();
  expect(host.open('run=').map((socket) => socket.query)).toEqual([runQuery('alpha', GOLDEN_RUN_ID)]);
});

test("live: events pushed one by one show tests#1 running, then settled, and a running call's log is read again at most once a second", async () => {
  const { dir, rest } = runningCopy(m, 1);
  page = boot(host);
  firstIndex();
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
  firstIndex();
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
  firstIndex();
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

test("the open run, then the open queue, is the open source's subject", () => {
  page = boot(host);
  firstIndex(GOLDEN_RUN_ID);
  host.advance(100);
  expect(page.ui.focus.open?.subject).toEqual({ kind: 'run', repo: 'alpha', runId: GOLDEN_RUN_ID });
  host.click({ action: 'select-queue', queue: `beta/${QUEUE_WORKFLOW}` });
  host.advance(100);
  expect(page.ui.focus.open?.subject).toEqual({ kind: 'workflow', repo: 'beta', workflow: QUEUE_WORKFLOW });
});

const ITEM_ROW = { subject: 'item', repo: 'beta', workflow: QUEUE_WORKFLOW, item: 'ticket:FAKE-5' };

test("hovering a queue item's row makes it the subject, and leaving it gives back the open queue", () => {
  page = boot(host);
  firstIndex(GOLDEN_RUN_ID);
  host.click({ action: 'select-queue', queue: `beta/${QUEUE_WORKFLOW}` });
  host.advance(100);
  const queue: Subject = { kind: 'workflow', repo: 'beta', workflow: QUEUE_WORKFLOW };
  expect(host.regions.main).toContain(
    `<div class="qrow2" data-subject="item" data-repo="beta" data-workflow="${QUEUE_WORKFLOW}" data-item="ticket:FAKE-5">`,
  );
  host.point('hover', ITEM_ROW);
  expect(focused(page.ui)).toEqual({ kind: 'item', repo: 'beta', workflow: QUEUE_WORKFLOW, item: 'ticket:FAKE-5' });
  host.point('hover', undefined);
  expect(focused(page.ui)).toEqual(queue);
});

test('the list draws each row with its subject: a run, a queue and a repository', () => {
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  host.advance(100);
  expect(host.regions.list).toContain(`data-subject="run" data-repo="beta" data-run="${FAKE_3_ID}"`);
  host.click({ action: 'select-view', view: 'queues' });
  host.advance(100);
  expect(host.regions.list).toContain(`data-subject="workflow" data-repo="beta" data-workflow="${QUEUE_WORKFLOW}"`);
  expect(host.regions.list).toContain('data-subject="repo" data-repo="beta"');
});

test('the offers of a run that is not open are read once into the store, and the open run keeps its own', async () => {
  page = boot(host);
  firstIndex(GOLDEN_RUN_ID);
  await settle();
  const other = { kind: 'run', repo: 'alpha', runId: FAKE_2_ID } as const;
  expect(sourceFor(page.store, other).run).toBeUndefined();
  readSubjectOffers(page.store, other);
  await settle();
  expect(sourceFor(page.store, other).run?.clean?.enabled).toBe(true);
  expect(sourceFor(page.store, { kind: 'run', repo: 'alpha', runId: GOLDEN_RUN_ID }).run).toBe(page.store.offers);
});

test('a queue opened over a run stays open when that run leaves the index, and the run alone closes (review R10)', () => {
  page = boot(host);
  firstIndex(GOLDEN_RUN_ID);
  host.click({ action: 'select-queue', queue: `beta/${QUEUE_WORKFLOW}` });
  host.advance(100);
  const repos = index(m.registryDir).map((repo) => ({
    ...repo,
    runs: repo.runs.filter((entry) => entry.runId !== GOLDEN_RUN_ID),
  }));
  host.push(host.open('index')[0], { kind: 'index', repos });
  host.advance(100);
  expect([page.ui.queue, page.ui.runId, host.open('run=')]).toEqual([`beta/${QUEUE_WORKFLOW}`, undefined, []]);
  expect(host.regions.main).toStartWith('<div class="d-h"><span class="d-title">ticket-to-pr queue</span>');
});

test('a run socket closed without end reconnects after 2 s into a fresh model, one closed after end stays closed, and the index socket reconnects', () => {
  page = boot(host);
  firstIndex();
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
  expect(host.regions.main).toContain('<span class="pill p-pass">watched</span>');
});

test('a run stream that sends an error and closes is not reopened, keeps its cards and its error, and clicking the run opens it again from empty (ADW-209)', () => {
  const runSockets = () => host.sockets.filter((socket) => socket.query.startsWith('run='));
  page = boot(host);
  firstIndex();
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
  firstIndex();
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
  firstIndex();
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

test("with no queue the list has no queue row and no queue socket opens; with beta's, its row opens queue=beta/ticket-to-pr in the centre with its recent events, until the queue leaves the index", () => {
  rmSync(join(m.beta.clone, '.sail-runs', 'queue'), { recursive: true });
  page = boot(host);
  firstIndex();
  host.click({ action: 'select-view', view: 'queues' });
  host.advance(100);
  expect([host.regions.list?.includes('select-queue'), host.open('queue=')]).toEqual([false, []]);
  page.stop();
  m.remove();
  m = seedFixtures();
  host = new FakeHost(m);
  page = boot(host);
  firstIndex();
  const sockets = host.open('queue=');
  expect(sockets.map((socket) => socket.query)).toEqual([`queue=${encodeURIComponent(`beta/${QUEUE_WORKFLOW}`)}`]);
  replay(host.open('run=')[0], GOLDEN());
  host.click({ action: 'select-view', view: 'queues' });
  host.advance(100);
  expect(host.regions.list).toContain(
    `<div class="q-row" data-row="queue:beta/${QUEUE_WORKFLOW}" data-subject="workflow" data-repo="beta" data-workflow="${QUEUE_WORKFLOW}"><button class="q-open" data-action="select-queue"`,
  );
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
  expect(host.regions.list).toContain(
    `<div class="q-row sel cur" data-row="queue:beta/${QUEUE_WORKFLOW}" data-subject="workflow" data-repo="beta" data-workflow="${QUEUE_WORKFLOW}"><button class="q-open" data-action="select-queue"`,
  );
  expect(host.regions.list).not.toMatch(/<div class="run[^"]* sel">/);
  host.renders = [];
  host.push(sockets[0], {
    kind: 'queue-event',
    event: { seq: 99, ts: '2026-09-24T11:09:00.000Z', type: 'watch:removed', workflow: QUEUE_WORKFLOW },
  });
  host.advance(100);
  // The pill is the live watcher's word, which only the index carries: the queue's own watch:removed changes nothing.
  expect([host.regions.main?.includes('<span class="pill p-pass">watched</span>'), host.regions.main]).toEqual([
    true,
    expect.not.stringContaining('not watched'),
  ]);
  rmSync(join(m.beta.clone, '.sail-runs', 'queue'), { recursive: true });
  firstIndex();
  expect([sockets[0]?.closed, host.open('queue=')]).toEqual([true, []]);
  host.advance(100);
  expect([page.ui.queue, cards(host.regions.main)]).toEqual([undefined, expect.arrayContaining(['publish#1'])]);
});

test('a queue stream that sends an error and closes is not reopened and shows its error, and clicking its row opens it again from empty (ADW-209)', () => {
  const queueSockets = () => host.sockets.filter((socket) => socket.query.startsWith('queue='));
  const queue = `beta/${QUEUE_WORKFLOW}`;
  page = boot(host);
  firstIndex();
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
  expect(host.regions.main).toContain('<span class="pill p-pass">watched</span>');
  host.click({ action: 'select-queue', queue });
  expect(queueSockets()).toHaveLength(2);
});

test('a failed queue reopened before its old socket closes keeps one open socket when the old one closes (review R1) (ADW-209)', () => {
  const queue = `beta/${QUEUE_WORKFLOW}`;
  page = boot(host);
  firstIndex();
  const old = host.open('queue=')[0];
  host.click({ action: 'select-queue', queue });
  host.push(old, { kind: 'error', message: "events.ndjson:2 can't be read" });
  host.click({ action: 'select-queue', queue });
  host.drop(old);
  host.advance(10_000);
  expect(host.sockets.filter((socket) => socket.query.startsWith('queue='))).toHaveLength(2);
  expect(host.open('queue=')).toHaveLength(1);
});

test('keys move the cursor, Enter opens a timeline, ] and [ step it, Escape goes back to the cards then deselects, and a key typed in an input does nothing', () => {
  page = boot(host);
  firstIndex();
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
  for (let i = 0; i < 20; i++) host.press('ArrowRight');
  host.advance(100);
  expect(cursor()).toBe('publish#1');
});

test('the inspector opens when a card is selected and closes when it is deselected (ADW-528)', () => {
  page = boot(host);
  firstIndex();
  replay(host.open('run=')[0], GOLDEN());
  host.advance(100);
  expect(host.inspector).toEqual([false, false]);
  host.click({ action: 'select-card', key: 'implement#1' });
  host.advance(100);
  expect(host.inspector).toEqual([true, false]);
  host.press('Escape');
  host.press('Escape');
  host.advance(100);
  expect(page.ui.key).toBeUndefined();
  expect(host.inspector).toEqual([false, false]);
});

test('i pins the inspector open with no card selected, and i again unpins it (ADW-528)', () => {
  page = boot(host);
  firstIndex();
  replay(host.open('run=')[0], GOLDEN());
  host.advance(100);
  host.press('i');
  host.advance(100);
  expect(host.inspector).toEqual([true, true]);
  expect(host.regions.inspector).toContain('select a stage card');
  host.press('i');
  host.advance(100);
  expect(host.inspector).toEqual([false, false]);
});

test('a queue open over a selected card closes the inspector, and a pinned one shows no card (ADW-528)', () => {
  page = boot(host);
  firstIndex();
  replay(host.open('run=')[0], GOLDEN());
  host.click({ action: 'select-card', key: 'implement#1' });
  host.advance(100);
  expect(host.inspector).toEqual([true, false]);
  host.click({ action: 'select-queue', queue: `beta/${QUEUE_WORKFLOW}` });
  host.advance(100);
  expect(host.inspector).toEqual([false, false]);
  host.press('i');
  host.advance(100);
  expect(host.inspector).toEqual([true, true]);
  expect(host.regions.inspector).toContain('select a stage card');
  expect(host.regions.inspector).not.toContain('implement#1');
});

test('the status bar names the view with nothing open, the queue while one is open, and the view again after Esc (ADW-548)', () => {
  page = boot(host);
  plainIndex();
  host.advance(100);
  expect(host.regions.status).toContain('<span>Active</span><span>1 waiting on you</span>');
  host.click({ action: 'select-view', view: 'history' });
  host.advance(100);
  expect(host.regions.status).toContain('<span>History</span><span>');
  host.click({ action: 'select-queue', queue: `beta/${QUEUE_WORKFLOW}` });
  host.advance(100);
  expect(host.regions.status).toContain(`<span>beta / ${QUEUE_WORKFLOW}</span><span>watched</span>`);
  host.press('Escape');
  host.advance(100);
  expect(host.regions.status).toContain('<span>History</span><span>');
  expect(host.regions.status).not.toContain('beta /');
});

test('the status bar names the queue while one is open and describes the run again once it is back (ADW-528, ADW-548)', () => {
  page = boot(host);
  expect(host.regions.status ?? '').toBe('');
  firstIndex();
  replay(host.open('run=')[0], GOLDEN());
  host.advance(100);
  expect(host.regions.status).toContain('calls <b>');
  host.click({ action: 'select-queue', queue: `beta/${QUEUE_WORKFLOW}` });
  host.advance(100);
  expect(host.regions.status).toBe(
    `<span>beta / ${QUEUE_WORKFLOW}</span><span>watched</span><span>waiting <b>1</b></span><span>running <b>1</b></span>`,
  );
  host.click({ action: 'select-run', repo: 'alpha', run: GOLDEN_RUN_ID });
  host.advance(100);
  expect(host.regions.status).toContain('calls <b>');
});

test('the sidebar button opens the folded sidebar, and choosing a view or pressing Escape shuts it (ADW-528)', () => {
  page = boot(host);
  firstIndex();
  host.click({ action: 'toggle-sidebar' });
  expect(host.sidebars).toEqual([true]);
  host.click({ action: 'toggle-sidebar' });
  expect(host.sidebars).toEqual([true, false]);
  host.click({ action: 'toggle-sidebar' });
  host.click({ action: 'select-view', view: 'history' });
  expect([host.sidebars, page.ui.view]).toEqual([[true, false, true, false], 'history']);
  replay(host.open('run=')[0], GOLDEN());
  host.click({ action: 'select-run', repo: 'alpha', run: GOLDEN_RUN_ID });
  host.click({ action: 'toggle-sidebar' });
  host.press('Escape');
  expect(host.sidebars.slice(-2)).toEqual([true, false]);
  host.advance(100);
  expect(host.regions.main).not.toContain('No run selected');
  host.press('Escape');
  host.advance(100);
  expect(host.regions.main).toContain('No run selected');
});

test('a key that changes the list or moves its cursor shuts the open sidebar too (review R1) (ADW-528)', () => {
  page = boot(host);
  firstIndex();
  host.click({ action: 'toggle-sidebar' });
  host.press('4');
  expect([host.sidebars, page.ui.view]).toEqual([[true, false], 'history']);
  host.click({ action: 'toggle-sidebar' });
  host.press('j');
  expect(host.sidebars).toEqual([true, false, true, false]);
  host.click({ action: 'toggle-sidebar' });
  host.press('Escape');
  expect(host.sidebars).toEqual([true, false, true, false, true, false]);
});

test('a view or repository chosen in the open sidebar over an open run closes the run, so the list shows (review R3) (ADW-528)', () => {
  page = boot(host);
  firstIndex();
  replay(host.open('run=')[0], GOLDEN());
  host.click({ action: 'select-run', repo: 'alpha', run: GOLDEN_RUN_ID });
  host.advance(100);
  expect(host.regions.main).not.toContain('No run selected');
  host.click({ action: 'toggle-sidebar' });
  host.click({ action: 'select-view', view: 'history' });
  host.advance(100);
  expect([page.ui.view, host.regions.main]).toEqual(['history', expect.stringContaining('No run selected')]);
  host.click({ action: 'select-queue', queue: `beta/${QUEUE_WORKFLOW}` });
  host.click({ action: 'toggle-sidebar' });
  host.click({ action: 'filter-repo', repo: 'beta' });
  host.advance(100);
  expect([page.ui.repoFilter, page.ui.queue]).toEqual(['beta', undefined]);
  // With the sidebar shut, as it is from 800px, choosing a view keeps the open run beside the list.
  host.click({ action: 'select-run', repo: 'alpha', run: GOLDEN_RUN_ID });
  host.click({ action: 'select-view', view: 'active' });
  host.advance(100);
  expect(host.regions.main).not.toContain('No run selected');
});

test("the inspector's close button unpins it and deselects its card, so a pointer closes it (review R2) (ADW-528)", () => {
  page = boot(host);
  firstIndex();
  replay(host.open('run=')[0], GOLDEN());
  host.click({ action: 'select-card', key: 'implement#1' });
  host.click({ action: 'toggle-inspector' });
  host.advance(100);
  expect(host.inspector).toEqual([true, true]);
  host.click({ action: 'close-inspector' });
  host.advance(100);
  expect([host.inspector, page.ui.key, page.ui.pinned]).toEqual([[false, false], undefined, false]);
});

test('a copy that took draws one ok toast reading what it copied, and 4,000 ms on it is gone', async () => {
  page = boot(host);
  host.click({ action: 'copy', text: 'sail show X' });
  await settle();
  host.advance(100);
  expect(host.regions.toasts).toContain('<div class="toast ok" role="status" data-toast="1">');
  expect(host.regions.toasts).toContain(
    '<span class="toast-head">copy</span> — <span class="toast-text">copied sail show X</span>',
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

describe('a copy button says whether the copy took', () => {
  const text = `sail show ${GOLDEN_RUN_ID}`;
  const open = () => {
    page = boot(host);
    firstIndex();
    replay(host.open('run=')[0], GOLDEN(), false);
    host.advance(FLUSH_MS);
  };
  const button = (label: string) => `data-text="${text}">${label}</button>`;

  test('a copy the clipboard took reads copied, and COPIED_MS later copy again', async () => {
    open();
    expect(host.regions.main).toContain(button('copy'));
    host.click({ action: 'copy', text });
    await settle();
    host.advance(FLUSH_MS);
    expect(host.regions.main).toContain(button('copied'));
    expect(page?.ui.copied).toEqual({ text, ok: true });
    host.advance(COPIED_MS + FLUSH_MS);
    expect(host.regions.main).toContain(button('copy'));
    expect(host.regions.main).not.toContain('>copied</button>');
    expect(page?.ui.copied).toBeUndefined();
  });

  test('a copy the clipboard refused reads copy failed, then copy again', async () => {
    open();
    host.copyTakes = false;
    host.click({ action: 'copy', text });
    await settle();
    host.advance(FLUSH_MS);
    expect(host.regions.main).toContain(button('copy failed'));
    expect(page?.ui.copied).toEqual({ text, ok: false });
    host.advance(COPIED_MS + FLUSH_MS);
    expect(host.regions.main).toContain(button('copy'));
    expect(page?.ui.copied).toBeUndefined();
  });

  test('a second copy 1 s after the first keeps the label until COPIED_MS after the second', async () => {
    open();
    host.click({ action: 'copy', text });
    await settle();
    host.advance(1000);
    host.click({ action: 'copy', text });
    await settle();
    host.advance(COPIED_MS - 1);
    expect(page?.ui.copied).toEqual({ text, ok: true });
    host.advance(1 + FLUSH_MS);
    expect(page?.ui.copied).toBeUndefined();
    expect(host.regions.main).toContain(button('copy'));
  });

  test('a page stopped before the clipboard answers sets nothing and leaves no timer', async () => {
    open();
    host.click({ action: 'copy', text });
    page?.stop();
    await settle();
    expect(page?.ui.copied).toBeUndefined();
    expect(host.pendingTimers).toBe(0);
  });

  test('stopping a page while the label shows cancels its timer', async () => {
    open();
    host.click({ action: 'copy', text });
    await settle();
    page?.stop();
    expect(host.pendingTimers).toBe(0);
  });
});

test('the theme cycles and is saved, a section toggles, copy copies, follow toggles, and the stream buttons read that stream', async () => {
  host.storage.set(THEME_KEY, 'light');
  page = boot(host);
  expect(host.theme).toBe('light');
  host.click({ action: 'toggle-theme' });
  expect([host.theme, host.storage.get(THEME_KEY)]).toEqual(['system', 'system']);
  host.click({ action: 'toggle-theme' });
  expect(host.theme).toBe('dark');
  firstIndex();
  replay(host.open('run=')[0], GOLDEN(), false);
  host.click({ action: 'toggle-list-group', group: 'active:running' });
  expect(page.ui.listFolded).toEqual(['active:running']);
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
  firstIndex();
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
  firstIndex();
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
  firstIndex();
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
  firstIndex();
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
  firstIndex();
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
  firstIndex();
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
  firstIndex();
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
  firstIndex();
  const socket = host.open('run=')[0];
  replay(socket, dir, false);
  for (const event of lines.slice(0, start + 1)) host.push(socket, { kind: 'event', event });
  host.click({ action: 'select-card', key: 'tests#1' });
  host.advance(100);
  expect(host.regions.main).toContain('<span class="d-agent">1.1s');
  host.renders = [];
  host.advance(1000);
  expect(host.regions.main).toContain('<span class="d-agent">2.1s');
  expect(host.renders.sort()).toEqual(['list', 'main']);
  host.advance(1000);
  expect(host.regions.main).toContain('<span class="d-agent">3.1s');
  page.stop();
  page = undefined;

  // The seeded machine alone runs nothing: no tick draws anything.
  host = new FakeHost(m);
  rmSync(dir, { recursive: true });
  page = boot(host);
  firstIndex();
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
  firstIndex();
  const socket = host.open('run=')[0];
  replay(socket, dir, false);
  for (const event of lines.slice(0, start + 1)) host.push(socket, { kind: 'event', event });
  host.click({ action: 'select-card', key: 'implement#1' });
  host.click({ action: 'toggle-follow' });
  host.advance(100);
  expect(host.scrolls).toEqual(['main']);
  host.renders = [];
  host.scrolls = [];
  host.advance(2500);
  expect([host.renders, host.scrolls]).toEqual([[], []]);
  host.advance(60_000);
  expect(host.renders).toContain('main');
  expect(host.renders).toContain('list');
  expect([...new Set(host.scrolls)]).toEqual(['main']);
});

test('an add that took writes main though its markup is what was last drawn (ADW-504)', async () => {
  page = boot(host);
  firstIndex();
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

test('a switch of run draws the list and the run view fresh, and a tick does not (ADW-504)', () => {
  const { dir, rest } = runningCopy(m, 1);
  const start = rest.map((line) => JSON.parse(line)).find((event) => event.type === 'stage:start');
  host.clock = Date.parse(start.ts) + 1000;
  page = boot(host);
  firstIndex();
  replay(host.open('run=')[0], dir, false);
  host.advance(100);
  expect(host.freshes).toEqual(['list', 'main']);
  host.renders = [];
  host.freshes = [];
  host.advance(2500);
  expect(host.renders).toContain('list');
  expect(host.freshes).toEqual([]);
  host.click({ action: 'select-run', repo: 'alpha', run: GOLDEN_RUN_ID });
  host.advance(100);
  expect(host.freshes).toEqual(['list', 'main']);
});

test('the open run, once ended, opens its stream again when the index says it runs again, folds past its old run:end as live, and leaves one socket (review R1-2)', () => {
  const beta = join(m.beta.clone, '.sail-runs', FAKE_3_ID);
  page = boot(host);
  firstIndex();
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
  firstIndex();
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
  firstIndex();
  replay(host.open('run=')[0], GOLDEN());
  host.advance(100);
  // A summary of no shape, as the server never sends one: the list and needs attention read it, the open run doesn't.
  const broken = indexMessage();
  for (const repo of broken.repos)
    for (const run of repo.runs) if (run.runId === FAKE_3_ID) run.summary = {} as typeof run.summary;
  host.renders = [];
  host.push(host.open('index')[0], broken);
  expect(() => host.advance(100)).not.toThrow();
  expect(host.renders.sort()).toEqual(['list', 'sidebar']);
  expect(host.regions.list).toContain('this part of the page could not be drawn');
  expect(cards(host.regions.main)).toHaveLength(8);
});

test("a corrective try's end reads the call's result.json again though the first try's was loaded (review R2-2)", async () => {
  const { dir, rest } = runningCopy(m, 1);
  page = boot(host);
  firstIndex();
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
  firstIndex();
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
  host.click({ action: 'select-run', repo: 'alpha', run: RUNNING_ID });
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
  firstIndex();
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

test('a click on a list row opens the run beside the list, the host is told, and Escape with no card selected closes it and tells the host again (ADW-522)', () => {
  page = boot(host);
  plainIndex();
  host.advance(100);
  host.click({ action: 'select-run', repo: 'alpha', run: FAKE_2_ID });
  replay(host.open('run=')[0], fake2Dir(m));
  host.advance(100);
  expect(host.details).toEqual([false, true]);
  expect(cards(host.regions.main)).toHaveLength(3);
  host.press('Escape');
  host.advance(100);
  expect(host.details).toEqual([false, true, false]);
  expect([page.ui.runId, page.ui.repo]).toEqual([undefined, undefined]);
  expect(host.open('run=')).toEqual([]);
  expect(host.regions.main).toContain('No run selected');
});

test('Escape steps back through a selected card before it closes the run (ADW-522)', () => {
  page = boot(host);
  plainIndex();
  host.click({ action: 'select-run', repo: 'alpha', run: FAKE_2_ID });
  replay(host.open('run=')[0], fake2Dir(m));
  host.click({ action: 'select-card', key: 'implement#1' });
  host.press('Escape');
  expect([page.ui.timeline, page.ui.key, page.ui.runId]).toEqual([false, 'implement#1', FAKE_2_ID]);
  host.press('Escape');
  expect([page.ui.key, page.ui.runId]).toEqual([undefined, FAKE_2_ID]);
  host.advance(100);
  expect(host.details.at(-1)).toBe(true);
  host.press('Escape');
  host.advance(100);
  expect([page.ui.runId, host.details.at(-1)]).toEqual([undefined, false]);
});

test('Escape closes an open queue and gives the list the centre back (ADW-522)', () => {
  page = boot(host);
  plainIndex();
  host.click({ action: 'select-view', view: 'queues' });
  host.click({ action: 'select-queue', queue: `beta/${QUEUE_WORKFLOW}` });
  host.advance(100);
  expect(host.details.at(-1)).toBe(true);
  host.press('Escape');
  host.advance(100);
  expect([page.ui.queue, host.details.at(-1)]).toEqual([undefined, false]);
});

test('select-view redraws the list with History and Queues rows, and filter-repo narrows the list and the sidebar counts to a repository until a second click (ADW-522)', () => {
  page = boot(host);
  plainIndex();
  host.advance(100);
  const counts = () =>
    [
      ...(host.regions.sidebar ?? '').matchAll(
        /data-view="(\w+)"[^>]*><span class="nm">\w+<\/span><span class="c">(\d+)<\/span>/g,
      ),
    ].map(([, view, n]) => `${view} ${n}`);
  expect(counts()).toEqual(['inbox 3', 'active 1', 'queues 1', 'history 3']);
  host.click({ action: 'select-view', view: 'history' });
  host.advance(100);
  expect(host.regions.list).toContain('<span class="lh-t">History</span><span class="c">3</span>');
  expect(host.regions.list).toContain(`data-run="${FAKE_2_ID}"`);
  host.click({ action: 'select-view', view: 'queues' });
  host.advance(100);
  expect(host.regions.list).toContain(`data-queue="beta/${QUEUE_WORKFLOW}"`);
  host.click({ action: 'filter-repo', repo: 'alpha' });
  host.advance(100);
  expect(counts()).toEqual(['inbox 1', 'active 0', 'queues 0', 'history 2']);
  expect(host.regions.sidebar).toContain('data-repo="alpha" aria-pressed="true"');
  expect(host.regions.list).not.toContain('data-queue=');
  host.click({ action: 'select-view', view: 'history' });
  host.advance(100);
  expect(host.regions.list).toContain('<span class="lh-t">History</span><span class="c">2</span>');
  host.click({ action: 'filter-repo', repo: 'beta' });
  host.advance(100);
  expect(host.regions.list).not.toContain(`data-run="${FAKE_2_ID}"`);
  host.click({ action: 'filter-repo', repo: 'beta' });
  host.advance(100);
  expect(host.regions.sidebar).not.toContain('aria-pressed="true"');
  expect(host.regions.list).toContain(`data-run="${FAKE_2_ID}"`);
});

test('booted with ?view=history the list draws History, and with ?view=nope or no view, Active (ADW-522)', () => {
  for (const [startAt, view, head] of [
    [{ view: 'history' }, 'history', 'History'],
    [{ view: 'queues' }, 'queues', 'Queues'],
    [{ view: 'nope' }, 'active', 'Active'],
    [{}, 'active', 'Active'],
  ] as const) {
    host = new FakeHost(m);
    host.startAt = { ...startAt };
    page = boot(host);
    plainIndex();
    host.advance(100);
    expect([page.ui.view, host.regions.list?.includes(`<span class="lh-t">${head}</span>`)]).toEqual([view, true]);
    page.stop();
  }
});

test('select-view pushes the view into the URL, a view that is none writes nothing, and Back shows the view its entry names (ADW-522, ADW-513)', () => {
  page = boot(host);
  plainIndex();
  host.urls = [];
  host.click({ action: 'select-view', view: 'queues' });
  host.press('4');
  host.click({ action: 'select-view', view: 'bogus' });
  host.click({ action: 'select-view', view: 'active' });
  expect(host.urls).toEqual([
    { query: 'view=queues', push: true },
    { query: 'view=history', push: true },
    { query: '', push: true },
  ]);
  host.go('view=queues');
  host.advance(100);
  expect([page.ui.view, host.regions.list?.includes('<span class="lh-t">Queues</span>')]).toEqual(['queues', true]);
  host.go('');
  expect(page.ui.view).toBe('active');
});

test('booted with ?repo=&run=&view=history the run opens beside the History list (ADW-522)', () => {
  host.startAt = { repo: 'alpha', run: FAKE_2_ID, view: 'history' };
  page = boot(host);
  plainIndex();
  host.advance(100);
  expect(host.open('run=').map((socket) => socket.query)).toEqual([runQuery('alpha', FAKE_2_ID)]);
  expect(host.regions.list).toContain('<span class="lh-t">History</span>');
  expect(host.regions.list).toContain(`class="run lrow sel" data-row="run:alpha/${FAKE_2_ID}"`);
  expect(host.details.at(-1)).toBe(true);
});

describe('the list by keyboard (ADW-522)', () => {
  /** Boots on the first index in History: one group per start day, FAKE-1 (09-25), FAKE-2 (09-23), FAKE-4 (09-22). */
  const bootHistory = () => {
    page = boot(host);
    plainIndex();
    host.press('4');
    host.advance(100);
    return page;
  };

  /** Moves the cursor onto FAKE-2's row: its group header is the third entry, the row the fourth. */
  const toFake2 = () => {
    for (let i = 0; i < 4; i++) host.press('j');
  };

  test('j and k move the cursor one entry and stop at both ends', () => {
    const p = bootHistory();
    expect(p.ui.view).toBe('history');
    host.press('j');
    expect(p.ui.listCursor).toBe('history:2026-09-25');
    host.press('j');
    expect(p.ui.listCursor?.startsWith('run:alpha/FAKE-1-')).toBe(true);
    host.press('k');
    host.press('k');
    expect(p.ui.listCursor).toBe('history:2026-09-25');
    for (let i = 0; i < 9; i++) host.press('ArrowDown');
    const last = p.ui.listCursor;
    expect(last?.startsWith('run:')).toBe(true);
    host.press('ArrowDown');
    expect(p.ui.listCursor).toBe(last);
    host.advance(100);
    expect(host.regions.list).toContain(`class="run lrow cur" data-row="${last}"`);
  });

  test('an index that drops the cursor run leaves the cursor alone until the next move, which lands on the first entry', () => {
    const p = bootHistory();
    toFake2();
    expect(p.ui.listCursor).toBe(`run:alpha/${FAKE_2_ID}`);
    const repos = index(m.registryDir).map((repo) => ({
      ...repo,
      runs: repo.runs.filter((run) => run.runId !== FAKE_2_ID),
    }));
    host.push(host.open('index')[0], { kind: 'index', repos });
    host.advance(100);
    expect(p.ui.listCursor).toBe(`run:alpha/${FAKE_2_ID}`);
    expect(host.regions.list).not.toContain(' cur"');
    host.press('j');
    expect(p.ui.listCursor).toBe('history:2026-09-25');
    host.press('k');
    host.press('k');
    expect(p.ui.listCursor).toBe('history:2026-09-25');
  });

  test('Enter opens the row under the cursor, and folds the group under it', () => {
    const p = bootHistory();
    host.press('j');
    host.press('Enter');
    expect(p.ui.listFolded).toEqual(['history:2026-09-25']);
    host.advance(100);
    expect(host.regions.list).not.toContain('data-run="FAKE-1-');
    host.press('Enter');
    expect(p.ui.listFolded).toEqual([]);
    for (let i = 0; i < 3; i++) host.press('j');
    host.press('Enter');
    expect(host.open('run=').map((socket) => socket.query)).toEqual([runQuery('alpha', FAKE_2_ID)]);
    expect([p.ui.repo, p.ui.runId]).toEqual(['alpha', FAKE_2_ID]);
  });

  test('Enter on a queue row opens the queue beside the list', () => {
    const p = bootHistory();
    host.press('3');
    for (let i = 0; i < 3; i++) host.press('j');
    expect(p.ui.listCursor).toBe(`queue:beta/${QUEUE_WORKFLOW}`);
    host.press('Enter');
    expect(p.ui.queue).toBe(`beta/${QUEUE_WORKFLOW}`);
  });

  test('. opens the menu of the run under the cursor', () => {
    const p = bootHistory();
    toFake2();
    host.press('.');
    expect([p.ui.runId, p.ui.runMenu]).toEqual([FAKE_2_ID, { runId: FAKE_2_ID, at: 'row' }]);
    host.advance(100);
    expect(host.regions.list).toContain('class="r-menu"');
  });

  test('. on a group header, or with no cursor, does nothing', () => {
    const p = bootHistory();
    host.press('.');
    host.press('j');
    host.press('.');
    expect([p.ui.runMenu, p.ui.runId]).toEqual([undefined, undefined]);
  });

  test('/ focuses the filter field and asks for its default to be suppressed; typing narrows the rows and the head reads n of m', () => {
    const p = bootHistory();
    expect(host.press('/')).toBe(true);
    expect(host.focused).toEqual(['list-filter']);
    host.type('list-filter', 'fake-2');
    host.advance(100);
    expect(p.ui.listFilter).toBe('fake-2');
    expect(host.regions.list).toContain('<span class="lh-t">History</span><span class="c">1 of 3</span>');
    expect(host.regions.list).toContain('value="fake-2"');
    expect(host.regions.list).toContain(`data-run="${FAKE_2_ID}"`);
    expect(host.regions.list).not.toContain(`data-run="${GOLDEN_RUN_ID}"`);
    host.type('list-filter', '');
    host.advance(100);
    expect(host.regions.list).toContain('<span class="c">3</span>');
  });

  test("choosing a status narrows the list and the cursor, leaves the sidebar's count, and a change of view empties it", () => {
    const p = bootHistory();
    const sidebar = host.regions.sidebar;
    host.type('list-status', 'failed');
    host.advance(100);
    expect(p.ui.historyStatus).toBe('failed');
    expect(host.regions.list).toContain('<span class="c">1 of 3</span>');
    expect(host.regions.list).toContain(`data-run="${FAKE_2_ID}"`);
    expect(host.regions.list).not.toContain(`data-run="${GOLDEN_RUN_ID}"`);
    expect(host.regions.sidebar).toBe(sidebar);
    for (let i = 0; i < 9; i++) host.press('j');
    expect(p.ui.listCursor).toBe(`run:alpha/${FAKE_2_ID}`);
    host.type('list-filter', 'zzz');
    host.advance(100);
    expect(host.regions.list).toContain('nothing matches');
    host.type('list-filter', '');
    host.type('list-workflow', 'no-such-workflow');
    host.advance(100);
    expect(host.regions.list).toContain('nothing matches');
    host.type('list-workflow', '');
    host.type('list-status', 'bogus');
    host.advance(100);
    expect(p.ui.historyStatus).toBe('failed');
    host.press('2');
    host.press('4');
    host.advance(100);
    expect([p.ui.historyStatus, p.ui.historyWorkflow]).toEqual([undefined, undefined]);
    expect(host.regions.list).toContain('<span class="c">3</span>');
  });

  test('x marks and unmarks the History run under the cursor and the head counts the marks', () => {
    const p = bootHistory();
    toFake2();
    host.press('x');
    host.advance(100);
    expect(p.ui.listSelected).toEqual([`run:alpha/${FAKE_2_ID}`]);
    expect(host.regions.list).toContain(`class="run lrow picked cur" data-row="run:alpha/${FAKE_2_ID}"`);
    expect(host.regions.list).toContain('<span class="lh-sel">1 selected</span>');
    host.press('x');
    host.advance(100);
    expect(p.ui.listSelected).toEqual([]);
    expect(host.regions.list).not.toContain('lh-sel');
    expect(host.regions.list).not.toContain('picked');
  });

  test('x selects nothing on a group, in Active or Queues, with a run open, or typed in the filter field', () => {
    const p = bootHistory();
    host.press('j');
    host.press('x');
    expect(p.ui.listSelected).toEqual([]);
    host.press('x', true);
    expect(p.ui.listSelected).toEqual([]);
    host.press('j');
    host.press('Enter');
    replay(host.open('run=')[0], fake2Dir(m));
    host.advance(100);
    host.press('x');
    expect(p.ui.listSelected).toEqual([]);
    host.press('Escape');
    host.press('2');
    host.press('j');
    host.press('j');
    host.press('x');
    expect(p.ui.listSelected).toEqual([]);
    host.press('3');
    host.press('j');
    host.press('x');
    expect(p.ui.listSelected).toEqual([]);
    host.press('4');
    host.type('list-filter', 'x');
    host.advance(100);
    expect(p.ui.listFilter).toBe('x');
    expect(p.ui.listSelected).toEqual([]);
  });

  test('a selected row a filter hides is not counted', () => {
    const p = bootHistory();
    toFake2();
    host.press('x');
    host.press('j');
    host.press('j');
    host.press('x');
    host.advance(100);
    expect(p.ui.listSelected).toHaveLength(2);
    expect(host.regions.list).toContain('2 selected');
    host.type('list-status', 'failed');
    host.advance(100);
    expect(host.regions.list).toContain('<span class="lh-sel">1 selected</span>');
  });

  test('Escape clears the selection only with no run open, and clear and a change of view empty it', () => {
    const p = bootHistory();
    toFake2();
    host.press('x');
    host.press('Enter');
    replay(host.open('run=')[0], fake2Dir(m));
    host.advance(100);
    host.press('Escape');
    host.advance(100);
    expect([p.ui.runId, p.ui.listSelected]).toEqual([undefined, [`run:alpha/${FAKE_2_ID}`]]);
    host.press('Escape');
    host.advance(100);
    expect(p.ui.listSelected).toEqual([]);
    host.press('x');
    host.click({ action: 'clear-selection' });
    expect(p.ui.listSelected).toEqual([]);
    host.press('x');
    host.press('1');
    expect(p.ui.listSelected).toEqual([]);
  });

  /** Marks FAKE-1 (the first run row) and FAKE-2 (the second) in History. */
  const markFirstTwo = () => {
    host.press('j');
    host.press('j');
    host.press('x');
    host.press('j');
    host.press('j');
    host.press('x');
  };

  test("clean on a selection reads each run's offers, reads checking… meanwhile, and drops a read of an older selection", async () => {
    const p = bootHistory();
    markFirstTwo();
    host.advance(100);
    expect(p.ui.listSelected).toHaveLength(2);
    expect(host.regions.list).toContain('data-action="clean-selected">clean</button>');
    let release = () => {};
    host.actionsHold = new Promise<void>((done) => {
      release = done;
    });
    host.actionReads = [];
    host.click({ action: 'clean-selected' });
    host.advance(100);
    expect(host.actionReads.map((path) => path.replace(/-01M\w+/, '')).sort()).toEqual([
      '/api/repos/alpha/runs/FAKE-1/actions',
      '/api/repos/alpha/runs/FAKE-2/actions',
    ]);
    expect(host.regions.list).toContain('<span class="busy">checking 2 runs…</span>');
    expect(host.regions.list).not.toContain('data-action="clean-selected"');
    expect(host.dialog).toBeUndefined();
    release();
    host.actionsHold = undefined;
    await Bun.sleep(50);
    host.advance(100);
    expect(dialogTitle()).toBe('clean 2 runs');
    expect(dialogVerb()).toBe('clean');
    const lines = dialogLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith('skips FAKE-1-');
    expect(lines[1]).toStartWith(`${FAKE_2_ID}: removes `);
    expect(p.ui.listSelected).toEqual([]);
    expect(host.regions.list).not.toContain('checking');
    host.postAnswer = { status: 200, body: '{"message":"cleaned it"}' };
    host.click({ action: 'dialog-confirm' });
    await Bun.sleep(10);
    host.advance(100);
    expect(host.posts).toEqual([{ path: `${FAKE_2_PATH}/clean`, body: {} }]);
    expect(toasts()).toEqual([`ok clean ${FAKE_2_ID}: cleaned it`]);

    // A selection changed before the answers come opens no dialog.
    host.posts = [];
    markFirstTwo();
    host.advance(100);
    host.actionsHold = new Promise<void>((done) => {
      release = done;
    });
    host.click({ action: 'clean-selected' });
    host.press('Escape');
    host.advance(100);
    release();
    host.actionsHold = undefined;
    await Bun.sleep(50);
    host.advance(100);
    expect([host.dialog, p.ui.underway.selection, p.ui.listSelected]).toEqual([undefined, undefined, []]);
    expect(host.regions.list).not.toContain('checking');
  });

  test('narrowing to a repository drops a workflow filter it has no finished run of, and keeps one it has (review R6)', () => {
    const p = bootHistory();
    host.type('list-workflow', 'review');
    host.advance(100);
    expect(p.ui.historyWorkflow).toBe('review');
    expect(host.regions.list).toContain('<span class="c">1 of 3</span>');
    host.click({ action: 'filter-repo', repo: 'alpha' });
    host.advance(100);
    expect(p.ui.historyWorkflow).toBeUndefined();
    expect(host.regions.list).not.toContain('nothing matches');
    expect(host.regions.list).toContain('<span class="lh-t">History</span><span class="c">2</span>');
    expect(host.regions.list).toContain('<option value="" selected>any workflow</option>');
    host.type('list-workflow', 'ticket-to-pr');
    host.click({ action: 'filter-repo', repo: 'alpha' });
    host.click({ action: 'filter-repo', repo: 'alpha' });
    host.advance(100);
    expect(p.ui.historyWorkflow).toBe('ticket-to-pr');
    expect(host.regions.list).toContain('<option value="ticket-to-pr" selected>ticket-to-pr</option>');
  });

  test('a read of the offers is dropped when x or a filter changes the shown selection meanwhile, and the marks stay (review R4)', async () => {
    const p = bootHistory();
    const cleanWhile = async (change: () => void) => {
      let release = () => {};
      host.actionsHold = new Promise<void>((done) => {
        release = done;
      });
      host.click({ action: 'clean-selected' });
      host.advance(100);
      change();
      host.advance(100);
      release();
      host.actionsHold = undefined;
      await Bun.sleep(50);
      host.advance(100);
    };
    markFirstTwo();
    await cleanWhile(() => host.press('x'));
    expect([host.dialog, p.ui.underway.selection, p.ui.listSelected.length]).toEqual([undefined, undefined, 1]);
    expect(host.regions.list).not.toContain('checking');
    expect(host.regions.list).toContain('<span class="lh-sel">1 selected</span>');
    host.press('x');
    await cleanWhile(() => host.type('list-status', 'failed'));
    expect([host.dialog, p.ui.underway.selection, p.ui.listSelected.length]).toEqual([undefined, undefined, 2]);
    expect(host.regions.list).toContain('<span class="lh-sel">1 selected</span>');
    await cleanWhile(() => host.type('list-filter', 'fake-2'));
    expect(dialogTitle()).toBe('clean 1 run');
  });

  test('clean on a selection while a run request is out keeps the marks and toasts why (review R3)', async () => {
    const p = bootHistory();
    markFirstTwo();
    host.click({ action: 'clean-selected' });
    await Bun.sleep(50);
    host.advance(100);
    let release = () => {};
    host.postHold = new Promise<void>((done) => {
      release = done;
    });
    host.click({ action: 'dialog-confirm' });
    host.advance(100);
    expect(host.posts).toEqual([{ path: `${FAKE_2_PATH}/clean`, body: {} }]);
    host.press('x');
    host.advance(100);
    const marked = [...p.ui.listSelected];
    expect(marked).toHaveLength(1);
    host.click({ action: 'clean-selected' });
    await Bun.sleep(50);
    host.advance(100);
    expect([host.dialog, p.ui.listSelected, p.ui.underway.selection]).toEqual([undefined, marked, undefined]);
    expect(toasts()).toEqual(['bad clean 1 run: another run action is under way: try again once it is answered']);
    expect(host.regions.list).toContain('<span class="lh-sel">1 selected</span>');
    host.postHold = undefined;
    release();
  });

  test('clean on a selection none of whose runs can be cleaned opens no dialog and toasts the reasons', async () => {
    const p = bootHistory();
    host.press('j');
    host.press('j');
    host.press('x');
    host.click({ action: 'clean-selected' });
    await Bun.sleep(50);
    host.advance(100);
    expect([host.dialog, host.posts]).toEqual([undefined, []]);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]).toStartWith('bad clean 1 run: FAKE-1-');
    expect(p.ui.listSelected).toEqual([]);
  });

  test('Escape in the filter field blurs it and changes nothing else; any other key typed there changes only the filter', () => {
    const p = bootHistory();
    host.press('j');
    host.press('Escape', true);
    expect(host.blurs).toBe(1);
    host.press('3', true);
    host.press('j', true);
    host.press('Enter', true);
    host.press('/', true);
    expect([p.ui.view, p.ui.listCursor, p.ui.runId, host.focused]).toEqual([
      'history',
      'history:2026-09-25',
      undefined,
      [],
    ]);
  });

  test('the filter text survives a redraw of the list', () => {
    const dom = new DomHost(m);
    host = dom;
    const p = bootHistory();
    dom.field('list', 'list-filter').value = 'fake';
    host.type('list-filter', 'fake');
    host.advance(100);
    host.click({ action: 'toggle-list-group', group: 'history:2026-09-22' });
    host.advance(100);
    expect(dom.field('list', 'list-filter').value).toBe('fake');
    expect(p.ui.listFilter).toBe('fake');
  });

  test('a change of view draws the list fresh, so its filter field gives up the text the filter no longer holds (review R7)', () => {
    const p = bootHistory();
    host.type('list-filter', 'fake');
    host.advance(100);
    host.freshes = [];
    host.press('2');
    host.advance(100);
    expect(p.ui.listFilter).toBe('');
    expect(host.freshes).toContain('list');
  });

  test("1 to 4 select the views in the sidebar's order, and clear the filter and the cursor", () => {
    const p = bootHistory();
    host.type('list-filter', 'x');
    host.press('j');
    host.press('2');
    expect([p.ui.view, p.ui.listFilter, p.ui.listCursor]).toEqual(['active', '', undefined]);
    host.press('1');
    expect(p.ui.view).toBe('inbox');
    host.press('3');
    expect(p.ui.view).toBe('queues');
    host.press('4');
    expect(p.ui.view).toBe('history');
    // A bare `a` is no key of its own: `g` then `a` opens Active, and Inbox is `1` or `g` then `i` (ADW-542).
    host.press('a');
    expect(p.ui.view).toBe('history');
    host.press('g');
    host.press('a');
    expect(p.ui.view).toBe('active');
  });

  test('with a run open, j and k move the card cursor as before and leave the list cursor alone, and Escape steps back to the list', () => {
    const p = bootHistory();
    toFake2();
    host.press('Enter');
    replay(host.open('run=')[0], fake2Dir(m));
    host.advance(100);
    host.press('j');
    expect([p.ui.cursor, p.ui.listCursor]).toEqual([1, `run:alpha/${FAKE_2_ID}`]);
    host.press('k');
    expect(p.ui.cursor).toBe(0);
    host.press('Escape');
    host.advance(100);
    expect([p.ui.runId, host.details.at(-1)]).toEqual([undefined, false]);
    host.press('j');
    expect(p.ui.listCursor).toBe('history:2026-09-22');
  });

  test('a redraw of the list that moves no cursor, such as the tick, leaves its scroll alone (review R8)', () => {
    bootHistory();
    host.press('j');
    host.advance(100);
    host.revealed = [];
    host.click({ action: 'toggle-list-group', group: 'history:2026-09-22' });
    host.advance(100);
    expect(host.regions.list).toBeDefined();
    expect(host.revealed).toEqual([]);
  });

  test('a cursor move that moves nothing, k at the first entry, leaves no reveal for a later redraw (review R10)', () => {
    bootHistory();
    host.press('j');
    host.advance(100);
    host.press('k');
    host.advance(100);
    host.revealed = [];
    host.click({ action: 'toggle-list-group', group: 'history:2026-09-22' });
    host.advance(100);
    expect(host.regions.list).toBeDefined();
    expect(host.revealed).toEqual([]);
  });

  test('the list is revealed after it is drawn, so the cursor stays in sight', () => {
    bootHistory();
    host.press('j');
    host.advance(100);
    expect(host.revealed).toContain('list');
  });
});

test('Escape with a run open in the Inbox closes the timeline, the selection, then the run, and the view stays inbox', () => {
  page = boot(host);
  firstIndex();
  host.click({ action: 'select-view', view: 'inbox' });
  host.click({ action: 'open', repo: 'alpha', run: FAKE_2_ID, key: 'implement#1', tab: 'permissions' });
  replay(host.open('run=')[0], fake2Dir(m));
  host.advance(100);
  expect([page.ui.view, page.ui.runId, page.ui.key]).toEqual(['inbox', FAKE_2_ID, 'implement#1']);
  host.click({ action: 'select-card', key: 'implement#1' });
  host.advance(100);
  expect(page.ui.timeline).toBe(true);
  host.press('Escape');
  expect([page.ui.timeline, page.ui.key, page.ui.runId]).toEqual([false, 'implement#1', FAKE_2_ID]);
  host.press('Escape');
  expect([page.ui.key, page.ui.runId]).toEqual([undefined, FAKE_2_ID]);
  host.press('Escape');
  host.advance(100);
  expect([page.ui.runId, page.ui.view]).toEqual([undefined, 'inbox']);
});

test('a group folds and opens again from its header, remembered across a boot, and opening a run from the list gives the centre back from a queue', () => {
  page = boot(host);
  plainIndex();
  host.click({ action: 'select-view', view: 'queues' });
  host.advance(100);
  expect(page.ui.listFolded).toEqual([]);
  expect(host.regions.list).toContain(`data-queue="beta/${QUEUE_WORKFLOW}"`);
  host.click({ action: 'toggle-list-group', group: 'queues:beta' });
  host.advance(100);
  expect(page.ui.listFolded).toEqual(['queues:beta']);
  expect(host.storage.get(LIST_KEY)).toBe(JSON.stringify(['queues:beta']));
  expect(host.regions.list).toContain('data-action="toggle-list-group" data-group="queues:beta" aria-expanded="false"');
  expect(host.regions.list).not.toContain(`data-queue="beta/${QUEUE_WORKFLOW}"`);
  host.click({ action: 'toggle-list-group', group: 'queues:beta' });
  host.advance(100);
  expect(page.ui.listFolded).toEqual([]);
  expect(host.storage.get(LIST_KEY)).toBe('[]');
  expect(host.regions.list).toContain(`data-queue="beta/${QUEUE_WORKFLOW}"`);
  host.click({ action: 'select-queue', queue: `beta/${QUEUE_WORKFLOW}` });
  host.advance(100);
  expect(cards(host.regions.main)).toEqual([]);
  expect(host.details.at(-1)).toBe(true);
  host.click({ action: 'select-run', repo: 'alpha', run: GOLDEN_RUN_ID });
  replay(host.open('run=')[0], GOLDEN());
  host.advance(100);
  expect([page.ui.queue, cards(host.regions.main)]).toEqual([undefined, expect.arrayContaining(['publish#1'])]);
  expect(host.sockets.filter((socket) => socket.query.startsWith('run='))).toHaveLength(1);
});

test('the list restores the folds it saved and ignores a stored value that is not a list of names', () => {
  host.storage.set(LIST_KEY, JSON.stringify(['active:running', 'queues:beta']));
  const restored = boot(host);
  expect(restored.ui.listFolded).toEqual(['active:running', 'queues:beta']);
  restored.stop();
  for (const bad of ['nope', '{"a":1}', '[1,"a"]']) {
    host.storage.set(LIST_KEY, bad);
    const malformed = boot(host);
    expect(malformed.ui.listFolded).toEqual([]);
    malformed.stop();
  }
  host.storage.delete(LIST_KEY);
  page = boot(host);
  host.click({ action: 'toggle-list-group', group: 'active:waiting' });
  page.stop();
  const again = boot(host);
  expect(again.ui.listFolded).toEqual(['active:waiting']);
  again.stop();
});

test("a click on a waiting row's down button posts the move to the queue's move route, a 409 is a red toast quoting its error, and a 202 an ok one", async () => {
  const file = join(queueDirOf(m), 'queue.json');
  const queue = JSON.parse(readFileSync(file, 'utf8'));
  const waiting = queue.items.find((item: { state: string }) => item.state === 'queued');
  queue.items.push({ ...waiting, dedupKey: 'ticket:FAKE-7', source: { kind: 'ticket', ticketKey: 'FAKE-7' } });
  writeFileSync(file, JSON.stringify(queue));
  page = boot(host);
  firstIndex();
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
  [
    ...(region ?? '').matchAll(
      /<button class="btn"( disabled)? ?(?:data-action="(\w+-run(?:-now)?)")?(?: title="[^"]*")?>([^<]*)<\/button>/g,
    ),
  ].map(([, disabled, action, label]) => [label, action, disabled === undefined ? '' : 'disabled']);

/** The lines of the dialog open now, and its primary button's verb. */
const dialogLines = () => [...(host.dialog ?? '').matchAll(/<li>([^<]*)<\/li>/g)].map(([, line]) => line);
const dialogVerb = () => host.dialog?.match(/data-action="dialog-confirm"(?: autofocus)?>([^<]*)<\/button>/)?.[1];
/** The subject of the dialog open now: its title, or undefined when none is open. */
const dialogTitle = () => host.dialog?.match(/<h2 id="dialog-title">([^<]*)<\/h2>/)?.[1];

/** Boots the page on `run` of `repo`, its events replayed, its actions read and its ⋯ menu open, and settled. */
async function openOffering(repo: string, runId: string, dir: string) {
  page = boot(host);
  firstIndex();
  // The row is in the list of the view its status belongs to.
  const status = listRepos(index(m.registryDir), host.clock)
    .find((each) => each.name === repo)
    ?.runs.find((run) => run.runId === runId)?.status;
  host.click({ action: 'select-view', view: status === 'failed' || status === 'completed' ? 'history' : 'active' });
  host.click({ action: 'open', repo, run: runId });
  replay(host.open('run=')[0], dir);
  host.click({ action: 'run-menu', repo, run: runId });
  await settle();
  host.advance(100);
}

/** FAKE-3 read `running`, its branch leased by this live process, as a run its process still holds is. */
const holdLive = () => {
  writeFileSync(join(m.beta.runDir, 'STATUS'), 'running\n');
  takeLease(join(m.root, 'leases'), 'fake://origin', 'sail/FAKE-3-escape-b-this-b-that', {
    runId: FAKE_3_ID,
    runDir: m.beta.runDir,
    pid: process.pid,
  });
};

/** The queue item of FAKE-3 as the watcher leaves it when it has let go: settled, so nothing holds the run. */
const settleQueue = () => {
  const file = join(queueDirOf(m), 'queue.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"state": "dispatched"', '"state": "done"'));
};

test("a failed run's view offers Restart with its stages and the failed one chosen, and no Resume; the first click opens the dialog and posts nothing, its confirm posts the stage and opens the new run", async () => {
  await openOffering('alpha', FAKE_2_ID, fake2Dir(m));
  expect(host.actionReads).toEqual([`${GOLDEN_PATH}/actions`, `${FAKE_2_PATH}/actions`]);
  expect(buttons(host.regions.list).filter(([, action]) => action?.endsWith('-run'))).toEqual([
    ['restart', 'restart-run', ''],
    ['clean', 'clean-run', ''],
  ]);
  expect(host.regions.list).not.toContain('name="stage"');
  host.click({ action: 'restart-run' });
  host.advance(100);
  expect(host.dialog).toContain(
    '<option value="implement" title="implement#1 and everything after it, in loop fix from iteration 1" selected>',
  );
  expect([host.posts, dialogTitle(), dialogVerb()]).toEqual([[], `restart FAKE-2`, 'restart']);
  expect(dialogLines()).toEqual([
    'runs again: implement#1 and everything after it, in loop fix from iteration 1',
    'budget $25.00',
    `starts a new run seeded from ${FAKE_2_ID}`,
  ]);
  expect(host.regions.list).not.toContain('armed');
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
test('a stage chosen in the restart dialog is the one its runs again line names and its confirm posts', async () => {
  await openOffering('alpha', FAKE_2_ID, fake2Dir(m));
  host.click({ action: 'restart-run' });
  expect(dialogLines()[0]).toBe('runs again: implement#1 and everything after it, in loop fix from iteration 1');
  host.dialogFields.stage = 'spec';
  host.click({ action: 'dialog-change' });
  expect([host.dialogRedraws, dialogLines()[0]]).toEqual([1, 'runs again: spec#1 and everything after it']);
  host.click({ action: 'dialog-cancel' });
  host.click({ action: 'restart-run' });
  expect([host.posts, dialogLines()[0]]).toEqual([
    [],
    'runs again: implement#1 and everything after it, in loop fix from iteration 1',
  ]);
  host.dialogFields.stage = 'spec';
  host.click({ action: 'dialog-change' });
  host.click({ action: 'dialog-confirm' });
  await settle();
  expect(host.posts).toEqual([{ path: `${FAKE_2_PATH}/restart`, body: { stage: 'spec' } }]);
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
  expect(buttons(host.regions.list).find(([, action]) => action === 'restart-run')?.[0]).toBe('restart');
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
  expect(dialogTitle()).toBe(`restart FAKE-2`);
  host.click({ action: 'run-menu', repo: 'alpha', run: FAKE_2_ID });
  host.advance(100);
  expect([host.dialog, page?.ui.runMenu, host.posts]).toEqual([undefined, undefined, []]);
  host.click({ action: 'run-menu', repo: 'alpha', run: FAKE_2_ID });
  host.advance(100);
  host.click({ action: 'restart-run' });
  await settle();
  expect(dialogTitle()).toBe(`restart FAKE-2`);
  expect(host.posts).toEqual([]);
});
test("a run's ⋯ opens the run and its menu under its row, reading what it offers; its ⋯ again or Escape shuts it, and another run's ⋯ moves it there (ADW-466)", async () => {
  page = boot(host);
  firstIndex();
  await settle();
  host.advance(100);
  expect(host.regions.list).not.toContain('class="r-menu"');
  host.click({ action: 'select-view', view: 'history' });
  host.click({ action: 'run-menu', repo: 'alpha', run: FAKE_2_ID });
  host.advance(100);
  expect([page?.ui.runId, page?.ui.runMenu]).toEqual([FAKE_2_ID, { runId: FAKE_2_ID, at: 'row' }]);
  expect(host.regions.list).toContain(
    '<div class="r-menu"><span class="act-why">reading what the run offers…</span></div>',
  );
  await settle();
  host.advance(100);
  expect(buttons(host.regions.list).map(([label]) => label)).toEqual(['restart', 'clean']);
  expect(host.regions.main).not.toContain('data-action="restart-run"');
  host.click({ action: 'run-menu', repo: 'alpha', run: FAKE_2_ID });
  host.advance(100);
  expect([page?.ui.runId, page?.ui.runMenu, host.regions.list?.includes('class="r-menu"')]).toEqual([
    FAKE_2_ID,
    undefined,
    false,
  ]);
  host.click({ action: 'run-menu', repo: 'alpha', run: FAKE_2_ID });
  host.click({ action: 'restart-run' });
  host.press('Escape');
  host.advance(100);
  expect([page?.ui.runMenu, host.dialog]).toEqual([{ runId: FAKE_2_ID, at: 'row' }, undefined]);
  host.press('Escape');
  host.advance(100);
  expect([page?.ui.runId, page?.ui.runMenu]).toEqual([FAKE_2_ID, undefined]);
  host.click({ action: 'run-menu', repo: 'alpha', run: FAKE_2_ID });
  host.click({ action: 'run-menu', repo: 'alpha', run: GOLDEN_RUN_ID });
  await settle();
  host.advance(100);
  expect([page?.ui.runId, page?.ui.runMenu, host.regions.list?.match(/class="r-menu"/g)?.length]).toEqual([
    GOLDEN_RUN_ID,
    { runId: GOLDEN_RUN_ID, at: 'row' },
    1,
  ]);
  expect(host.regions.list).toContain(
    '<div class="r-menu"><div class="acts"><span class="act"><button class="btn" data-action="restart-run" title="restart (⇧R)">restart</button><kbd>⇧R</kbd></span></div></div>',
  );
});

test('a suspended run over its dollars offers Resume and no Restart; its dialog asks the raise, keeps open with the refusal while none is typed, and posts the raise it reads and reads the run again', async () => {
  settleQueue();
  await openOffering('beta', FAKE_3_ID, m.beta.runDir);
  expect(host.regions.list).not.toContain('name="raise"');
  expect(buttons(host.regions.list).filter(([, action]) => action?.endsWith('-run'))).toEqual([
    ['resume', 'resume-run', ''],
    ['stop', 'stop-run', ''],
  ]);
  host.click({ action: 'resume-run' });
  host.advance(100);
  expect([dialogTitle(), dialogLines(), dialogVerb(), host.posts]).toEqual([
    'resume FAKE-3',
    ['spent $1.06 of $1.00'],
    'resume',
    [],
  ]);
  expect(host.dialog).toContain('name="raise"');
  host.click({ action: 'dialog-confirm' });
  expect([host.posts, toasts(), host.dialogCloses]).toEqual([[], [], 0]);
  expect(host.dialog).toContain('give the dollars to raise the budget by: at least 0.01');
  host.dialogFields.raise = '5';
  host.click({ action: 'dialog-change' });
  expect([dialogTitle(), dialogLines(), dialogVerb()]).toEqual([
    'resume FAKE-3',
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
    buttons(host.regions.list).filter(
      ([, action]) => action === undefined && ['resume', 'restart'].includes(action ?? ''),
    ),
  ).toEqual([]);
  expect(host.regions.list).toContain('<button class="btn" disabled>resume</button>');
  expect(host.regions.list).toContain('ticket-to-pr&#39;s watcher has this run: ticket:FAKE-3 is dispatched');
  host.click({ action: 'resume-run' });
  host.click({ action: 'resume-run' });
  await settle();
  expect(host.posts).toEqual([]);
});

test("the open run's actions are read again when the index shows its status change, and the open dialog closes with nothing sent", async () => {
  await openOffering('alpha', FAKE_2_ID, fake2Dir(m));
  host.click({ action: 'restart-run' });
  writeFileSync(join(fake2Dir(m), 'STATUS'), 'running\n');
  // A live process holds the run, so it reads running and offers nothing to resume.
  takeLease(join(m.root, 'leases'), 'fake://origin', 'sail/FAKE-2-print-the-version-with-version', {
    runId: FAKE_2_ID,
    runDir: fake2Dir(m),
    pid: process.pid,
  });
  plainIndex();
  await settle();
  host.advance(100);
  expect(host.actionReads).toEqual([`${GOLDEN_PATH}/actions`, `${FAKE_2_PATH}/actions`, `${FAKE_2_PATH}/actions`]);
  expect([host.dialog, host.posts]).toEqual([undefined, []]);
  // The run is Active now: its row, and the menu still open under it, move to that view with the next index.
  if (page !== undefined) page.ui.view = 'active';
  plainIndex();
  host.advance(100);
  expect(host.regions.list).toContain(`run ${FAKE_2_ID} is running`);
  plainIndex();
  await settle();
  expect(host.actionReads).toHaveLength(3);
});

test("a stage chosen in one run's dialog doesn't carry over to the next opened, whose dialog starts at its own failed stage (review R7)", async () => {
  await openOffering('alpha', FAKE_2_ID, fake2Dir(m));
  host.click({ action: 'restart-run' });
  host.dialogFields.stage = 'spec';
  host.click({ action: 'dialog-change' });
  expect(dialogLines()[0]).toBe('runs again: spec#1 and everything after it');
  host.click({ action: 'select-run', repo: 'alpha', run: GOLDEN_RUN_ID });
  host.advance(100);
  expect([host.dialog, page?.ui.act.drafts]).toEqual([undefined, {}]);
  host.click({ action: 'run-menu', repo: 'alpha', run: FAKE_2_ID });
  replay(host.open('run=')[0], fake2Dir(m));
  await settle();
  host.advance(100);
  host.click({ action: 'restart-run' });
  expect(dialogLines()[0]).toBe('runs again: implement#1 and everything after it, in loop fix from iteration 1');
});

/** The beta queue open in the centre with its stream replayed, and the posts and renders cleared. */
function openBetaQueue() {
  page = boot(host);
  firstIndex();
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
  const answers: (string | undefined)[] = [];
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
    answers.push(toasts().at(-1));
  }
  expect(host.posts).toEqual(Array(4).fill({ path: `${QUEUE_PATH}/poll`, body: {} }));
  const head = `poll beta / ${QUEUE_WORKFLOW}`;
  expect(answers).toEqual([
    `ok ${head}: sail queue: polled ticket-to-pr`,
    `ok ${head}: the watcher has not taken the command yet`,
    `bad ${head}: no watcher is running for 'beta'`,
    `bad ${head}: the poll could not be sent: the dashboard did not answer`,
  ]);
  expect(host.regions.toasts).toContain('role="alert"');
});

test('the add form shows once the queue stream has polled tickets, with add and add, skipping its checks and no box; add posts the typed key, an empty key posts nothing, and the key is kept across a draw (ADW-460)', async () => {
  page = boot(host);
  firstIndex();
  const [socket] = host.open('queue=');
  host.click({ action: 'select-queue', queue: `beta/${QUEUE_WORKFLOW}` });
  host.advance(100);
  expect(host.regions.main).not.toContain('name="add-ticket"');
  for (const event of readEvents(queueDirOf(m))) host.push(socket, { kind: 'queue-event', event });
  host.advance(100);
  expect(host.regions.main).toContain('name="add-ticket"');
  expect(host.regions.main).toContain('data-action="add-ticket-force"');
  expect(host.regions.main).not.toContain('type="checkbox"');
  host.click({ action: 'add-ticket', ...BETA });
  host.click({ action: 'add-ticket-force', ...BETA });
  await settle();
  expect([host.posts, host.dialog]).toEqual([[], undefined]);
  host.fields['add-ticket'] = '  FAKE-9 ';
  host.postAnswer = { status: 200, body: JSON.stringify({ message: 'sail queue: queued ticket:FAKE-9 Nine' }) };
  host.click({ action: 'add-ticket', ...BETA });
  await settle();
  host.advance(100);
  expect(host.posts).toEqual([{ path: `${QUEUE_PATH}/add`, body: { ticketKey: 'FAKE-9' } }]);
  expect(toasts()).toEqual([`ok add a ticket… beta / ${QUEUE_WORKFLOW}: sail queue: queued ticket:FAKE-9 Nine`]);
  expect(host.regions.main).toContain('value=""');
  host.fields['add-ticket'] = 'FAKE-10';
  host.click({ action: 'add-ticket-force', ...BETA });
  expect([host.posts.length, dialogTitle()]).toEqual([1, 'add FAKE-10, skipping its checks']);
  host.click({ action: 'dialog-confirm' });
  await settle();
  expect(host.posts[1]).toEqual({ path: `${QUEUE_PATH}/add`, body: { ticketKey: 'FAKE-10', force: true } });
});

test("a skipping add's dialog closes with nothing sent when its workflow stops being watched", () => {
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  host.click({ action: 'select-queue', queue: `beta/${QUEUE_WORKFLOW}` });
  host.advance(100);
  host.fields['add-ticket'] = 'FAKE-10';
  host.click({ action: 'add-ticket-force', ...BETA });
  expect(dialogTitle()).toBe('add FAKE-10, skipping its checks');
  host.push(
    host.open('index')[0],
    indexMessage({
      state: 'watcher not running',
      why: "no watcher is running for 'beta': sail watch ticket-to-pr first",
    }),
  );
  host.advance(100);
  expect([host.dialog, host.posts]).toEqual([undefined, []]);
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
  const before = [page?.ui.view, page?.ui.pinned, page?.ui.cursor];
  for (const key of ['j', 'a', 'i']) host.press(key);
  expect([page?.ui.view, page?.ui.pinned, page?.ui.cursor]).toEqual(before);
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
    'stop FAKE-3',
    ['stops at its next call boundary', 'the run fails as stopped'],
    'stop',
  ]);
  host.postAnswer = {
    status: 202,
    body: JSON.stringify({ message: `run ${FAKE_3_ID} stops at its next call boundary (pid 7)` }),
  };
  host.click({ action: 'dialog-confirm' });
  host.advance(100);
  expect(host.regions.list).toContain('<span class="busy">stopping…</span>');
  expect(host.regions.list).not.toMatch(
    new RegExp(`data-run="${FAKE_3_ID}"><span class="r-line"><span class="st [^"]*"></span>`),
  );
  await settle();
  host.advance(100);
  expect(host.posts).toEqual([{ path: `${FAKE_3_PATH}/stop`, body: { now: false } }]);
  expect(toasts()).toEqual([`ok stop ${FAKE_3_ID}: run ${FAKE_3_ID} stops at its next call boundary (pid 7)`]);
  expect(host.regions.list).not.toContain('stopping…');
  expect(host.actionReads.filter((path) => path === `${FAKE_3_PATH}/actions`).length).toBeGreaterThan(1);
});
test('the run menu offers stop and stop now as two buttons; Stop now opens its own dialog and the post is { now: true }', async () => {
  settleQueue();
  await openOffering('beta', FAKE_3_ID, m.beta.runDir);
  expect(buttons(host.regions.list).filter(([, action]) => action?.startsWith('stop-run'))).toEqual([
    ['stop', 'stop-run', ''],
    ['stop now', 'stop-run-now', ''],
  ]);
  expect(host.regions.list).not.toContain('type="checkbox"');
  host.click({ action: 'stop-run-now' });
  expect([dialogTitle(), dialogLines()[0], dialogVerb(), host.posts]).toEqual([
    'stop FAKE-3 now',
    'ends its running call now',
    'stop now',
    [],
  ]);
  host.postAnswer = { status: 202, body: JSON.stringify({ message: 'run X ends its running call now (pid 7)' }) };
  host.click({ action: 'dialog-confirm' });
  await settle();
  expect(host.posts).toEqual([{ path: `${FAKE_3_PATH}/stop`, body: { now: true } }]);
});
test('Suspend and hold opens its dialog and posts nothing; its confirm posts { now: false, suspend: true }, shows suspending… meanwhile, toasts the answer and reads the run again', async () => {
  holdLive();
  await openOffering('beta', FAKE_3_ID, m.beta.runDir);
  expect(buttons(host.regions.list).filter(([, action]) => action === 'suspend-run')).toEqual([
    ['suspend and hold', 'suspend-run', ''],
  ]);
  host.click({ action: 'suspend-run' });
  host.advance(100);
  expect([host.posts, dialogTitle(), dialogLines(), dialogVerb()]).toEqual([
    [],
    'suspend and hold FAKE-3',
    [
      'ends its running call now',
      'the run is suspended and held: it keeps its workspace and its branch, and the watcher leaves it until Resume',
      'unlike stop, the run does not fail',
    ],
    'suspend and hold',
  ]);
  const message = `run ${FAKE_3_ID} suspends now, held until sail resume ${FAKE_3_ID} (pid 7)`;
  host.postAnswer = { status: 202, body: JSON.stringify({ message }) };
  host.click({ action: 'dialog-confirm' });
  host.advance(100);
  expect(host.regions.list).toContain('<span class="busy">suspending…</span>');
  await settle();
  host.advance(100);
  expect(host.posts).toEqual([{ path: `${FAKE_3_PATH}/stop`, body: { now: false, suspend: true } }]);
  expect(toasts()).toEqual([`ok suspend and hold ${FAKE_3_ID}: ${message}`]);
  expect(host.actionReads.filter((path) => path === `${FAKE_3_PATH}/actions`).length).toBeGreaterThan(1);
});
test('a refused suspend and hold toasts the server words', async () => {
  holdLive();
  await openOffering('beta', FAKE_3_ID, m.beta.runDir);
  host.click({ action: 'suspend-run' });
  host.postAnswer = { status: 409, body: JSON.stringify({ error: 'run X is still starting' }) };
  host.click({ action: 'dialog-confirm' });
  await settle();
  host.advance(100);
  expect(toasts()).toEqual([`bad suspend and hold ${FAKE_3_ID}: run X is still starting`]);
});
test('the dispatch of the removed stop-now action does nothing', async () => {
  settleQueue();
  await openOffering('beta', FAKE_3_ID, m.beta.runDir);
  host.fields.now = 'on';
  host.click({ action: 'stop-now' });
  host.advance(100);
  expect([page?.ui.act.drafts, host.dialog, host.posts]).toEqual([{}, undefined, []]);
});

// The open run's header carries its actions (ADW-516): buttons for its status and a ⋯ for the rest, from the registry.
/** Boots the page on `run` of `repo`, its events replayed, with its row's menu shut. */
async function openRun(repo: string, runId: string, dir: string, read = true) {
  page = boot(host);
  firstIndex();
  const status = listRepos(index(m.registryDir), host.clock)
    .find((each) => each.name === repo)
    ?.runs.find((run) => run.runId === runId)?.status;
  host.click({ action: 'select-view', view: status === 'failed' || status === 'completed' ? 'history' : 'active' });
  host.click({ action: 'open', repo, run: runId });
  replay(host.open('run=')[0], dir);
  if (read) await settle();
  host.advance(100);
}
const occurrences = (needle: string) => `${host.regions.list ?? ''}${host.regions.main ?? ''}`.split(needle).length - 1;

test("a failed run's header draws restart and clean once the offers answer arrives, with no other event, and no ⋯", async () => {
  await openRun('alpha', FAKE_2_ID, fake2Dir(m), false);
  expect(host.regions.main).not.toContain('data-action="restart-run"');
  await settle();
  host.advance(100);
  expect(buttons(host.regions.main).filter(([, action]) => action?.endsWith('-run'))).toEqual([
    ['restart', 'restart-run', ''],
    ['clean', 'clean-run', ''],
  ]);
  expect(host.regions.main).not.toContain('data-at="header"');
  expect(host.regions.list).not.toContain('class="r-menu"');
});

test("a run whose summary can't be read has Rebuild in its header's ⋯ menu, which posts at once with no dialog and toasts the server's line", async () => {
  writeFileSync(join(fake2Dir(m), 'summary.json'), '{}');
  await openRun('alpha', FAKE_2_ID, fake2Dir(m));
  host.click({ action: 'run-menu', repo: 'alpha', run: FAKE_2_ID, at: 'header' });
  host.advance(100);
  expect(host.regions.main).toContain('<button class="btn" data-action="rebuild-run">rebuild</button>');
  host.postAnswer = { status: 200, body: JSON.stringify({ message: `rebuilt .sail-runs/${FAKE_2_ID}/summary.json` }) };
  host.click({ action: 'rebuild-run' });
  await settle();
  expect(host.dialog).toBeUndefined();
  expect(host.posts).toEqual([{ path: `/api/repos/alpha/runs/${FAKE_2_ID}/rebuild`, body: {} }]);
  expect(toasts()).toEqual([`ok rebuild ${FAKE_2_ID}: rebuilt .sail-runs/${FAKE_2_ID}/summary.json`]);
});

test("the open run's offers are read again when its summary problem goes, with its status unchanged", () => {
  const open = { repo: 'alpha', runId: 'R' } as never;
  const store = (problem?: string) =>
    ({
      index: [
        {
          name: 'alpha',
          queues: [],
          runs: [{ runId: 'R', status: { status: 'failed' }, ...(problem ? { problem } : {}) }],
        },
      ],
    }) as never;
  expect(offerSignature(store('summary.json is not a sail.summary.v1'), open)).not.toBe(offerSignature(store(), open));
});

test("the header's ⋯ opens a menu of the actions it has no button for; its ⋯ again, Escape or any other click shuts it", async () => {
  settleQueue();
  await openRun('beta', FAKE_3_ID, m.beta.runDir);
  const more = { action: 'run-menu', repo: 'beta', run: FAKE_3_ID, at: 'header' };
  expect(host.regions.main).toContain('data-action="resume-run" title="resume (R)">resume</button>');
  expect(host.regions.main).not.toContain('class="h-menu"');
  host.click(more);
  host.advance(100);
  expect(page?.ui.runMenu).toEqual({ runId: FAKE_3_ID, at: 'header' });
  expect(host.regions.main).toContain('<div class="h-menu">');
  expect(host.regions.main).toContain('data-action="stop-run" title="stop (S)">stop</button><kbd>S</kbd>');
  expect(host.regions.list).not.toContain('class="r-menu"');
  host.click(more);
  host.advance(100);
  expect([page?.ui.runMenu, host.regions.main?.includes('class="h-menu"')]).toEqual([undefined, false]);
  host.click(more);
  host.press('Escape');
  host.advance(100);
  expect([page?.ui.runMenu, host.regions.main?.includes('class="h-menu"')]).toEqual([undefined, false]);
  host.click(more);
  host.click({ action: 'toggle-follow' });
  host.advance(100);
  expect([page?.ui.runMenu, host.regions.main?.includes('class="h-menu"')]).toEqual([undefined, false]);
});

test("the header's ⋯ opens only the header's menu, and the row's ⋯ only the row's", async () => {
  settleQueue();
  await openRun('beta', FAKE_3_ID, m.beta.runDir);
  host.click({ action: 'run-menu', repo: 'beta', run: FAKE_3_ID, at: 'header' });
  host.click({ action: 'run-menu', repo: 'beta', run: FAKE_3_ID });
  host.advance(100);
  expect(page?.ui.runMenu).toEqual({ runId: FAKE_3_ID, at: 'row' });
  expect(host.regions.main).not.toContain('class="h-menu"');
  expect(host.regions.list).toContain('class="r-menu"');
});

test("the header's actions yield to an open row menu, so no run action is on the page twice", async () => {
  settleQueue();
  await openRun('beta', FAKE_3_ID, m.beta.runDir);
  const counts = () => [occurrences('data-action="resume-run"'), occurrences('data-action="stop-run"')];
  expect(counts()).toEqual([1, 0]);
  host.click({ action: 'run-menu', repo: 'beta', run: FAKE_3_ID });
  host.advance(100);
  expect(host.regions.main).not.toContain('data-action="resume-run"');
  expect(counts()).toEqual([1, 1]);
  host.click({ action: 'run-menu', repo: 'beta', run: FAKE_3_ID });
  host.click({ action: 'run-menu', repo: 'beta', run: FAKE_3_ID, at: 'header' });
  host.advance(100);
  expect(counts()).toEqual([1, 1]);
});

test("the header's stop, behind its ⋯, opens the dialog and its confirm posts the stop", async () => {
  settleQueue();
  await openRun('beta', FAKE_3_ID, m.beta.runDir);
  host.click({ action: 'run-menu', repo: 'beta', run: FAKE_3_ID, at: 'header' });
  host.click({ action: 'stop-run' });
  expect([host.posts, dialogTitle()]).toEqual([[], `stop FAKE-3`]);
  host.click({ action: 'dialog-confirm' });
  await settle();
  expect(host.posts).toEqual([{ path: `${FAKE_3_PATH}/stop`, body: { now: false } }]);
});

const domHost = () => {
  const dom = new DomHost(m);
  host = dom;
  return dom;
};

test("the list's run menu holds no raise field, and a raise typed in the dialog is read at confirm and posted with the resume", async () => {
  settleQueue();
  const dom = domHost();
  await openOffering('beta', FAKE_3_ID, m.beta.runDir);
  expect(host.regions.list).not.toContain('name="raise"');
  host.click({ action: 'resume-run' });
  host.advance(100);
  dom.dialogFields.raise = '5';
  host.click({ action: 'dialog-confirm' });
  await settle();
  expect(toasts().at(-1)).toBe(`ok resume ${FAKE_3_ID}: resumed`);
  expect(host.posts).toEqual([{ path: `${FAKE_3_PATH}/resume`, body: { raise: { usd: 5 } } }]);
});

test("the list's run menu holds no stage choice, and the stage is asked in the dialog", async () => {
  await openOffering('alpha', FAKE_2_ID, fake2Dir(m));
  expect(host.regions.list).not.toContain('<select name="stage"');
  host.click({ action: 'restart-run' });
  host.advance(100);
  expect(host.dialog).toContain('<select name="stage" autofocus>');
});

test('Clean opens the dialog with what it removes and where the run directory goes, posts {} on confirm, and leaves the run for the index with the cleaned line as a toast', async () => {
  await openOffering('alpha', FAKE_2_ID, fake2Dir(m));
  host.click({ action: 'clean-run' });
  host.advance(100);
  expect([host.posts, dialogTitle(), dialogVerb()]).toEqual([[], `clean FAKE-2`, 'clean']);
  expect(dialogLines()[0]).toBe('removes the run ref that keeps its commits');
  expect(dialogLines()[1]).toStartWith('moves its run directory to ');
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
  expect(buttons(host.regions.list).find(([, action]) => action === 'clean-run')?.[0]).toBe('clean');
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
          queues: repo.queues.map((queue) => ({
            ...queue,
            watch: workflows.includes(queue.workflow) ? { state: 'watched' as const } : queue.watch,
          })),
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
  host.click({ action: 'select-view', view: 'queues' });
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
  expect(host.regions.list).not.toContain('<div class="lgrp-p">sail watch: it watches ticket-to-pr</div>');
});

test('an Unwatch click posts the workflow to the unwatch route at once, with no dialog and no armed button', async () => {
  bootWatching([QUEUE_WORKFLOW]);
  host.click({ action: 'select-queue', queue: `beta/${QUEUE_WORKFLOW}` });
  host.advance(100);
  expect(host.regions.main).toContain(
    'data-action="unwatch" data-repo="beta" data-workflow="ticket-to-pr">unwatch</button>',
  );
  expect(host.regions.main).not.toContain('armed');
  host.postAnswer = { status: 200, body: JSON.stringify({ message: 'sail unwatch: done' }) };
  watchClick('unwatch', QUEUE_WORKFLOW);
  expect(host.posts).toEqual([{ path: '/api/repos/beta/unwatch', body: { workflows: [QUEUE_WORKFLOW] } }]);
  expect([host.dialog, page?.ui.underway]).toEqual([undefined, { [`watch:beta/${QUEUE_WORKFLOW}`]: 'unwatching…' }]);
  host.advance(100);
  expect(host.regions.list).not.toContain('armed');
});

test("an unwatched workflow's queue header draws poll disabled with its reason and a watch whose click posts the workflow to the watch route", async () => {
  bootWatching();
  host.click({ action: 'select-queue', queue: `beta/${QUEUE_WORKFLOW}` });
  host.advance(100);
  const header = host.regions.main?.match(/<div class="srcbar"[^>]*>.*?<\/span><\/span><\/div>/s)?.[0] ?? '';
  expect(header).toContain('<button class="btn" disabled>poll</button><span class="act-why">');
  expect(header).toContain(`data-action="watch" data-repo="beta" data-workflow="${QUEUE_WORKFLOW}">watch</button>`);
  expect(header).not.toContain('data-action="unwatch"');
  host.postAnswer = { status: 200, body: JSON.stringify({ message: 'sail watch: done' }) };
  watchClick('watch', QUEUE_WORKFLOW);
  await settle();
  expect(host.posts).toEqual([{ path: '/api/repos/beta/watch', body: { workflows: [QUEUE_WORKFLOW] } }]);
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
  const answers: (string | undefined)[] = [];
  for (const answer of [
    { status: 202, body: JSON.stringify({ message: 'the watcher of beta (pid 7) starts', pid: 7 }) },
    { status: 202, body: JSON.stringify({ waiting: 'the watcher has not taken the command yet' }) },
    { status: 409, body: JSON.stringify({ error: 'sail watch: no workflow declares a watch' }) },
    { status: 0, body: '' },
  ]) {
    host.postAnswer = answer;
    watchClick('watch');
    await settle();
    answers.push(watchToasts().at(-1));
  }
  expect(answers).toEqual([
    'ok watch all beta: the watcher of beta (pid 7) starts',
    'ok watch all beta: the watcher has not taken the command yet',
    'bad watch all beta: sail watch: no workflow declares a watch',
    'bad watch all beta: the watch could not be sent: the dashboard did not answer',
  ]);
});

describe('all clear', () => {
  const badge = () =>
    host.regions.sidebar?.match(
      /data-view="inbox"[^>]*><span class="nm">Inbox<\/span><span class="c">(\d+)<\/span>/,
    )?.[1];
  const listed = () => host.regions.list ?? '';
  const pushIndex = (change?: (repos: ReturnType<typeof index>) => void) => {
    const repos = index(m.registryDir);
    change?.(repos);
    host.push(host.open('index')[0], { kind: 'index', repos });
    host.advance(100);
  };
  const bootOpen = (change?: (repos: ReturnType<typeof index>) => void) => {
    page = boot(host);
    pushIndex(change);
    host.click({ action: 'select-view', view: 'inbox' });
    host.advance(100);
  };

  test('one click empties the list and the count, shows nothing needs attention, posts nothing and leaves the failed run in the list', () => {
    bootOpen();
    expect(badge()).toBe('3');
    expect(listed()).toContain('data-action="clear-attention" title="all clear (⇧E)">all clear</button>');
    host.click({ action: 'clear-attention' });
    host.advance(100);
    expect(badge()).toBe('0');
    expect(listed()).toContain('nothing needs attention');
    expect(listed()).not.toContain('all clear</button>');
    expect(host.posts).toEqual([]);
    host.click({ action: 'select-view', view: 'history' });
    host.advance(100);
    expect(host.regions.list).toContain(`data-run="${FAKE_2_ID}"`);
  });

  test('with a repository filter on, all clear hides only that repository, and the others are listed once the filter is off', () => {
    bootOpen();
    host.click({ action: 'filter-repo', repo: 'beta' });
    host.advance(100);
    expect(badge()).toBe('2');
    host.click({ action: 'clear-attention' });
    host.advance(100);
    expect(toasts()).toEqual(['ok all clear: 2 rows are hidden from the Inbox']);
    host.click({ action: 'filter-repo', repo: 'beta' });
    host.advance(100);
    expect(badge()).toBe('1');
    expect(listed()).toContain('failed: stage_error');
    expect(listed()).not.toContain('ticket:FAKE-6');
  });

  test('clear-attention while another view is shown hides nothing and draws no toast', () => {
    bootOpen();
    host.click({ action: 'select-view', view: 'active' });
    host.advance(100);
    host.click({ action: 'clear-attention' });
    host.advance(100);
    expect([badge(), toasts()]).toEqual(['3', []]);
    expect(host.storage.get(CLEARED_KEY)).toBe('[]');
  });

  test('all clear answers in a toast with an undo, which lists the same items again and takes only its own identities out of storage', async () => {
    bootOpen();
    const other = 'another tab: a cleared thing';
    host.storage.set(CLEARED_KEY, JSON.stringify([other]));
    host.click({ action: 'clear-attention' });
    host.advance(100);
    expect(toasts()).toEqual(['ok all clear: 3 rows are hidden from the Inbox']);
    expect(page?.ui.toasts[0]?.undo).toBe(true);
    expect(badge()).toBe('0');
    const saved: string[] = JSON.parse(host.storage.get(CLEARED_KEY) ?? '[]');
    expect(saved).toContain(other);
    expect(saved).toHaveLength(4);
    host.click({ action: 'undo-toast', toast: '1' });
    host.advance(100);
    expect(badge()).toBe('3');
    expect(JSON.parse(host.storage.get(CLEARED_KEY) ?? '[]')).toEqual([other]);
    expect(page?.ui.toasts).toEqual([]);
    expect(host.posts).toEqual([]);
  });

  test('a dismissed row returns when its detail changes: a cleared run whose row gains another call in error is listed again, with it in the row', () => {
    bootOpen();
    host.click({ action: 'clear-attention' });
    pushIndex((repos) => {
      const run = repos.find((repo) => repo.name === 'alpha')?.runs.find((each) => each.runId === FAKE_2_ID);
      for (const call of run?.summary?.calls ?? []) if (call.key === 'spec#1') call.outcome = 'error';
    });
    expect(badge()).toBe('1');
    expect(listed()).toContain('also in error: spec#1');
  });

  test('the clear survives a reboot over the same storage', () => {
    bootOpen();
    host.click({ action: 'clear-attention' });
    page?.stop();
    bootOpen();
    expect(badge()).toBe('0');
    expect(listed()).toContain('nothing needs attention');
  });

  test('a new failure, and a cleared parked item whose attempts changed, are listed after a clear', () => {
    bootOpen();
    host.click({ action: 'clear-attention' });
    pushIndex((repos) => {
      const run = repos.find((repo) => repo.name === 'beta')?.runs.find((each) => each.runId === FAKE_3_ID);
      if (run) run.status = { status: 'failed', stopReason: 'stage_error' };
    });
    expect(badge()).toBe('1');
    expect(listed()).toContain('failed: stage_error');
    pushIndex((repos) => {
      for (const view of repos.find((repo) => repo.name === 'beta')?.queues ?? [])
        for (const item of view.queue?.items ?? []) if (item.state === 'parked') item.attempts = 3;
    });
    // FAKE-3's cleared error row was pruned while its run's row read as failed, so it is listed again with the parked one.
    expect(badge()).toBe('2');
    expect(listed()).toContain('<span class="r-id">FAKE-6</span><b class="r-title">parked after 3 attempts</b>');
  });

  test('a failure that arrives before the Inbox is drawn again is not cleared with the rows on screen', () => {
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
    expect(listed()).toContain('failed: stage_error');
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
    // Another tab clears the new failure: its identity joins the three this tab cleared.
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
    expect(listed()).toContain('<span class="r-id">FAKE-6</span><b class="r-title">parked after 3 attempts</b>');
    expect(listed()).not.toContain('failed: stage_error');
  });

  test('identities the newest index no longer lists are dropped from storage, and the listed ones stay', () => {
    host.storage.set(CLEARED_KEY, JSON.stringify(['gone']));
    bootOpen();
    expect(host.storage.get(CLEARED_KEY)).toBe('[]');
    host.click({ action: 'clear-attention' });
    const kept = host.storage.get(CLEARED_KEY);
    expect(JSON.parse(kept ?? '[]')).toHaveLength(3);
    pushIndex();
    expect(host.storage.get(CLEARED_KEY)).toBe(kept);
  });

  test('a stored value that is not a list of strings clears nothing', () => {
    for (const bad of ['nope', '{"a":1}', '[1,"a"]']) {
      host.storage.set(CLEARED_KEY, bad);
      bootOpen();
      expect(badge()).toBe('3');
      page?.stop();
    }
  });
});

test('an index that turns the open queue to watcher not running redraws main with the disabled poll, shuts the open menu and closes the drop dialog, and a poll posts nothing', async () => {
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  host.click({ action: 'select-queue', queue: `beta/${QUEUE_WORKFLOW}` });
  host.advance(100);
  host.click({ action: 'item-menu', item: 'ticket:FAKE-6' });
  host.click({ action: 'drop-item', repo: 'beta', workflow: QUEUE_WORKFLOW, item: 'ticket:FAKE-6' });
  host.advance(100);
  expect([page.ui.itemMenu, dialogTitle()]).toEqual(['ticket:FAKE-6', 'drop ticket:FAKE-6']);
  host.renders = [];
  const why = "no watcher is running for 'beta': sail watch ticket-to-pr first";
  host.push(host.open('index')[0], indexMessage({ state: 'watcher not running', why }));
  host.advance(100);
  expect(host.renders).toContain('main');
  expect(host.regions.main).toContain(
    `<button class="btn" disabled>poll</button><span class="act-why">no watcher is running for &#39;beta&#39;: sail watch ticket-to-pr first</span>`,
  );
  expect(host.regions.main).toContain('<span class="pill p-skip">watcher not running</span>');
  expect([page.ui.itemMenu, dialogTitle(), host.posts]).toEqual([undefined, undefined, []]);
  const posts = host.posts.length;
  host.click({ action: 'poll-queue', repo: 'beta', workflow: QUEUE_WORKFLOW });
  await settle();
  expect(host.posts.length).toBe(posts);
});

// The command menu (ADW-520): opened on Cmd+K over the focused subject, filtered, moved and run by key.
const cmdk = () => host.regions.menu ?? '';
const menuLabels = () => [...cmdk().matchAll(/<span class="cmdk-label">([^<]*)<\/span>/g)].map(([, label]) => label);
const menuLeads = () => [...cmdk().matchAll(/<span class="cmdk-key">([^<]*)<\/span>/g)].map(([, lead]) => lead);
const menuSel = () => cmdk().match(/class="cmdk-row sel"[^>]*><span class="cmdk-label">([^<]*)</)?.[1];
const menuHead = () => cmdk().match(/<div class="cmdk-subj">([^<]*)<\/div>/)?.[1];
const cmdK = () => host.press('k', false, undefined, true);
/** Boots with `runId` open and its offers read, the menu closed. */
async function openRunPage(runId: string) {
  page = boot(host);
  firstIndex(runId);
  await settle();
  host.advance(100);
}

test('Cmd+K and Ctrl+K open the command menu from anywhere, an input included, and the handler reports the key handled; the same key or the backdrop closes it, and Escape lets go of the subject first', async () => {
  await openRunPage(FAKE_2_ID);
  expect(cmdK()).toBe(true);
  host.advance(100);
  expect(cmdk()).toContain('class="cmdk"');
  expect(host.menuFocuses).toBe(1);
  expect(cmdK()).toBe(true);
  host.advance(100);
  expect(cmdk()).toBe('');
  expect(host.press('k', true, undefined, true)).toBe(true);
  host.advance(100);
  expect(cmdk()).toContain('class="cmdk"');
  // The first Escape lets go of the subject: its chip and its actions go, the menu stays, and the second closes it.
  expect(menuHead()).toBe('FAKE-2 · Print the version with --version');
  expect(menuLabels()).toContain('clean');
  expect(host.press('Escape', true)).toBe(true);
  host.advance(100);
  expect(cmdk()).toContain('class="cmdk"');
  expect(menuHead()).toBeUndefined();
  expect(menuLabels()).not.toContain('clean');
  expect(menuLabels()).toContain('switch theme');
  expect(host.press('Escape', true)).toBe(true);
  host.advance(100);
  expect(cmdk()).toBe('');
  expect(host.press('K', false, undefined, true)).toBe(true);
  host.advance(100);
  host.click({ action: 'menu-close' });
  host.advance(100);
  expect(cmdk()).toBe('');
});

test('Backspace in the menu’s empty field lets go of the subject once, and with text typed or no subject it is the field’s own', async () => {
  await openRunPage(FAKE_2_ID);
  cmdK();
  host.advance(100);
  expect(menuHead()).toBe('FAKE-2 · Print the version with --version');
  // With text in the field Backspace deletes a character: the page takes no key, and the chip stays.
  host.type('menu-query', 'cl');
  host.advance(100);
  expect(host.press('Backspace', true)).toBe(false);
  expect(menuHead()).toBe('FAKE-2 · Print the version with --version');
  host.type('menu-query', '');
  host.advance(100);
  expect(host.press('Backspace', true)).toBe(true);
  host.advance(100);
  expect(cmdk()).toContain('class="cmdk"');
  expect(menuHead()).toBeUndefined();
  expect(menuLabels()).not.toContain('clean');
  // No subject is left to let go of: the key is the field's, and the menu stays open.
  expect(host.press('Backspace', true)).toBe(false);
  expect(cmdk()).toContain('class="cmdk"');
});

test('Backspace in a step’s empty field lets go of nothing', async () => {
  await openRunPage(FAKE_2_ID);
  cmdK();
  host.advance(100);
  typeIn('restart');
  enter();
  expect(stepLabel()).toBe('From');
  expect(host.press('Backspace', true)).toBe(false);
  expect(stepLabel()).toBe('From');
  expect(menuHead()).toBe('FAKE-2 · Print the version with --version');
});

test('Cmd+K does nothing while the confirmation dialog is open, and another key with Cmd held does nothing at all', async () => {
  await openRunPage(FAKE_2_ID);
  host.click({ action: 'clean-run' });
  expect(cmdK()).toBe(false);
  host.advance(100);
  expect(cmdk()).toBe('');
  host.press('Escape');
  expect(host.press('a', false, undefined, true)).toBe(false);
  expect(page?.ui.view).not.toBe('inbox');
});

test('with a run open the head reads its ticket key and title and the first group is that run offered actions; with nothing focused there is no head', async () => {
  await openRunPage(FAKE_2_ID);
  cmdK();
  host.advance(100);
  expect(menuHead()).toBe('FAKE-2 · Print the version with --version');
  expect(menuLabels().slice(0, 2)).toEqual(['restart', 'clean']);
  cmdK();
  page?.stop();
  page = boot(new FakeHost(m));
  const bare = (page as Page).store.host as FakeHost;
  bare.press('k', false, undefined, true);
  bare.advance(100);
  expect(bare.regions.menu).not.toContain('cmdk-subj');
  expect(bare.regions.menu).toContain('switch theme');
});

test('the subject follows hover, cursor and open object, the last changed winning, and does not change while the menu is open', async () => {
  await openRunPage(FAKE_2_ID);
  host.point('hover', ITEM_ROW);
  cmdK();
  host.advance(100);
  expect(menuHead()).toBe('FAKE-5 · Link the changelog from the README');
  host.point('hover', { subject: 'run', repo: 'alpha', run: FAKE_2_ID });
  host.advance(100);
  expect(menuHead()).toBe('FAKE-5 · Link the changelog from the README');
  cmdK();
  host.point('hover', undefined);
  expect(focused((page as Page).ui)).toEqual({ kind: 'run', repo: 'alpha', runId: FAKE_2_ID });
});

test('with the cursor set after a hover the menu opens on the cursor, and with the hover set after it, on the hover', async () => {
  await openRunPage(FAKE_2_ID);
  host.point('hover', ITEM_ROW);
  setFocus((page as Page).ui, 'cursor', { kind: 'repo', repo: 'beta' });
  cmdK();
  host.advance(100);
  expect(menuHead()).toBe('beta');
  cmdK();
  host.point('hover', { subject: 'run', repo: 'beta', run: FAKE_3_ID });
  cmdK();
  host.advance(100);
  expect(menuHead()).toBe('FAKE-3 · Escape &lt;b&gt;this&lt;/b&gt; &amp; &quot;that&quot;');
});

test('typing filters the rows within one flush and lists go-to rows, and the field holds what was typed', async () => {
  await openRunPage(FAKE_2_ID);
  cmdK();
  host.advance(100);
  const before = menuLabels();
  host.type('menu-query', 'switch theme');
  host.advance(100);
  expect(menuLabels()).toEqual(['switch theme']);
  expect(cmdk()).toContain('name="menu-query" type="text" value="switch theme"');
  expect(before.length).toBeGreaterThan(1);
  host.type('menu-query', FAKE_2_ID.slice(0, 8));
  host.advance(100);
  expect(cmdk()).toContain('<div class="cmdk-grp" id="cmdk-grp-goto" role="presentation">Go to</div>');
  expect(menuLeads()).toContain(FAKE_2_ID.replace(/-[^-]*$/, ''));
  expect(cmdk()).not.toContain('cmdk-id');
});

test('ArrowDown and ArrowUp move the highlight over enabled rows only, and j typed in the menu moves no card cursor', async () => {
  await openRunPage(FAKE_2_ID);
  cmdK();
  host.advance(100);
  expect(menuSel()).toBe('restart');
  expect(host.press('ArrowDown', true)).toBe(true);
  host.advance(100);
  expect(menuSel()).toBe('clean');
  host.press('ArrowDown', true);
  host.advance(100);
  expect(menuSel()).toBe('Inbox');
  host.press('ArrowUp', true);
  host.press('ArrowUp', true);
  host.advance(100);
  expect(menuSel()).toBe('restart');
  const cursor = page?.ui.cursor;
  expect(host.press('j', true)).toBe(false);
  expect(page?.ui.cursor).toBe(cursor);
});

test('Enter on a go-to row opens a run, a queue or an item opens the queue, and a repository unfolds it, each becoming the cursor subject with the menu closed', async () => {
  await openRunPage(FAKE_2_ID);
  const goTo = (query: string, row: string) => {
    cmdK();
    host.type('menu-query', query);
    host.advance(100);
    expect(menuLeads()[0] ?? menuLabels()[0]).toBe(row);
    host.press('Enter', true);
    host.advance(100);
    expect(cmdk()).toBe('');
  };
  goTo(FAKE_3_ID.slice(0, 10), FAKE_3_ID.replace(/-[^-]*$/, ''));
  expect(page?.store.run?.runId).toBe(FAKE_3_ID);
  expect(focused((page as Page).ui)).toEqual({ kind: 'run', repo: 'beta', runId: FAKE_3_ID });
  goTo('ticket:FAKE-5', 'FAKE-5');
  expect(page?.ui.queue).toBe(`beta/${QUEUE_WORKFLOW}`);
  expect(page?.ui.focus.cursor?.subject).toEqual({
    kind: 'item',
    repo: 'beta',
    workflow: QUEUE_WORKFLOW,
    item: 'ticket:FAKE-5',
  });
  page?.ui.listFolded.push('queues:alpha');
  goTo('alph', 'alpha');
  expect(page?.ui.view).toBe('queues');
  expect(page?.ui.listFolded).not.toContain('queues:alpha');
  expect(page?.ui.focus.cursor?.subject).toEqual({ kind: 'repo', repo: 'alpha' });
});

test('Enter on a view’s go-to row opens the view, and typing queue puts the Queues view first', async () => {
  await openRunPage(FAKE_2_ID);
  cmdK();
  host.type('menu-query', 'queue');
  host.advance(100);
  expect(menuSel()).toBe('Queues');
  host.press('Enter', true);
  host.advance(100);
  expect(cmdk()).toBe('');
  expect(page?.ui.view).toBe('queues');
});

test('Enter on a go-to row pushes the URL of what it opened, and a key that changes nothing writes none', async () => {
  await openRunPage(FAKE_2_ID);
  const enterOn = (query: string) => {
    cmdK();
    host.type('menu-query', query);
    host.advance(100);
    host.urls = [];
    host.press('Enter', true);
    host.advance(100);
    return host.urls;
  };
  expect(enterOn(FAKE_3_ID.slice(0, 10))).toEqual([{ query: `repo=beta&run=${FAKE_3_ID}`, push: true }]);
  expect(enterOn('ticket:FAKE-5')).toEqual([{ query: `queue=beta%2F${QUEUE_WORKFLOW}`, push: true }]);
  const repo = enterOn('alph');
  expect(repo).toHaveLength(1);
  expect(repo[0]?.query).toContain('view=queues');
  expect(repo[0]?.push).toBe(true);
  // Keys that only move the highlight, close the menu or type write nothing.
  cmdK();
  host.type('menu-query', 'a');
  host.advance(100);
  host.urls = [];
  host.press('ArrowDown', true);
  host.press('ArrowUp', true);
  host.type('menu-query', 'ab');
  host.press('Escape', true);
  host.press('Escape', true);
  expect(host.urls).toEqual([]);
});

test('Enter on switch theme changes the theme and on pin inspector the inspector, and Enter on a disabled row does nothing', async () => {
  await openRunPage(FAKE_2_ID);
  cmdK();
  host.type('menu-query', 'switch theme');
  host.advance(100);
  host.press('Enter', true);
  expect(page?.ui.theme).toBe('light');
  cmdK();
  host.type('menu-query', 'pin inspector');
  host.advance(100);
  host.press('Enter', true);
  expect(page?.ui.pinned).toBe(true);
  cmdK();
  host.push(host.open('index')[0], indexMessage({ state: 'watcher not running', why: 'no watcher is running' }));
  host.type('menu-query', 'poll every');
  host.advance(100);
  expect(cmdk()).toContain('disabled');
  expect(host.press('Enter', true)).toBe(true);
  host.click({ action: 'menu-run', row: '0' });
  expect([host.posts, cmdk() === '']).toEqual([[], false]);
});

test('moving the list cursor over a run row and then a queue row makes each the cursor subject', async () => {
  await openRunPage(FAKE_2_ID);
  host.click({ action: 'close-detail' });
  host.press('j');
  host.press('j');
  const first = page?.ui.focus.cursor?.subject;
  expect(first?.kind).toBe('run');
  host.click({ action: 'select-view', view: 'queues' });
  for (let at = 0; at < 3; at++) host.press('j');
  expect(page?.ui.focus.cursor?.subject).toEqual({ kind: 'workflow', repo: 'beta', workflow: QUEUE_WORKFLOW });
});

// Every action of the registry, carried out from the command menu by key presses and typing alone (ADW-520).
const typeIn = (text: string) => {
  host.type('menu-query', text);
  host.advance(100);
};
const enter = () => {
  host.press('Enter', true);
  host.advance(100);
};
/** Opens the menu on the row `data` names, its offers read. */
async function menuOn(data: Record<string, string>) {
  host.point('hover', data);
  cmdK();
  await settle();
  host.advance(100);
}
const stepLabel = () => cmdk().match(/<div class="cmdk-step">([^<]*)<\/div>/)?.[1];
const FAKE_3_ROW = { subject: 'run', repo: 'beta', run: FAKE_3_ID };
const FAKE_2_ROW = { subject: 'run', repo: 'alpha', run: FAKE_2_ID };
const ITEM_6 = { ...ITEM_ROW, item: 'ticket:FAKE-6' };
const WORKFLOW_ROW = { subject: 'workflow', repo: 'beta', workflow: QUEUE_WORKFLOW };
/** Boots on the first index with the menu closed and nothing open. */
function bootIndexed() {
  page = boot(host);
  host.push(host.open('index')[0], indexMessage());
  host.advance(100);
}

test('by keyboard alone: stop', async () => {
  settleQueue();
  bootIndexed();
  await menuOn(FAKE_3_ROW);
  typeIn('stop');
  enter();
  expect(dialogTitle()).toBe(`stop FAKE-3`);
  expect(host.posts).toEqual([]);
  host.press('Enter');
  expect(host.posts).toEqual([{ path: `${FAKE_3_PATH}/stop`, body: { now: false } }]);
});

test('by keyboard alone: stop now', async () => {
  settleQueue();
  bootIndexed();
  await menuOn(FAKE_3_ROW);
  typeIn('stop');
  host.press('ArrowDown', true);
  enter();
  expect(dialogTitle()).toBe(`stop FAKE-3 now`);
  expect(dialogLines()[0]).toBe('ends its running call now');
  expect(host.posts).toEqual([]);
  host.press('Enter');
  expect(host.posts).toEqual([{ path: `${FAKE_3_PATH}/stop`, body: { now: true } }]);
});

test('by keyboard alone: resume, the amount asked beside what was spent', async () => {
  settleQueue();
  bootIndexed();
  await menuOn(FAKE_3_ROW);
  typeIn('resume');
  enter();
  expect(stepLabel()).toBe('Raise $');
  expect(cmdk()).toContain('<div class="cmdk-line">spent $1.06 of $1.00</div>');
  typeIn('5');
  expect(cmdk()).toContain('<div class="cmdk-line">raises the budget by $5.00</div>');
  enter();
  expect([dialogTitle(), dialogLines(), host.posts]).toEqual([
    'resume FAKE-3',
    ['spent $1.06 of $1.00', 'raises the budget by $5.00'],
    [],
  ]);
  host.press('Enter');
  expect(host.posts).toEqual([{ path: `${FAKE_3_PATH}/resume`, body: { raise: { usd: 5 } } }]);
});

test('an invalid raise stays in the menu: its words shown, nothing sent and no dialog', async () => {
  settleQueue();
  bootIndexed();
  await menuOn(FAKE_3_ROW);
  typeIn('resume');
  enter();
  typeIn('0');
  enter();
  expect(cmdk()).toContain('<div class="cmdk-err">give the dollars to raise the budget by: at least 0.01</div>');
  expect([stepLabel(), host.posts, host.dialog]).toEqual(['Raise $', [], undefined]);
  typeIn('3');
  expect(cmdk()).not.toContain('cmdk-err');
});

test('by keyboard alone: restart from a chosen stage', async () => {
  bootIndexed();
  await menuOn(FAKE_2_ROW);
  typeIn('restart');
  enter();
  expect(stepLabel()).toBe('From');
  const stages = [...cmdk().matchAll(/<span class="cmdk-label">([^<]*)<\/span>/g)].map(([, label]) => label);
  expect(stages.length).toBeGreaterThan(1);
  const start = cmdk().match(/class="cmdk-row sel"[^>]*><span class="cmdk-label">([^<]*)</)?.[1];
  const other = stages.find((stage) => stage !== start);
  host.press('ArrowUp', true);
  host.press('ArrowDown', true);
  host.press('ArrowDown', true);
  host.advance(100);
  const chosen = cmdk().match(/class="cmdk-row sel"[^>]*><span class="cmdk-label">([^<]*)</)?.[1];
  expect(chosen).not.toBe(start);
  expect(other).toBeDefined();
  enter();
  expect(dialogTitle()).toBe(`restart FAKE-2`);
  expect(host.posts).toEqual([]);
  host.press('Enter');
  expect(host.posts).toEqual([{ path: `/api/repos/alpha/runs/${FAKE_2_ID}/restart`, body: { stage: chosen } }]);
});

test('by keyboard alone: clean', async () => {
  bootIndexed();
  await menuOn(FAKE_2_ROW);
  typeIn('clean');
  enter();
  expect(dialogTitle()).toBe(`clean FAKE-2`);
  expect(host.posts).toEqual([]);
  host.press('Enter');
  expect(host.posts).toEqual([{ path: `/api/repos/alpha/runs/${FAKE_2_ID}/clean`, body: {} }]);
});

test('by keyboard alone: requeue', async () => {
  bootIndexed();
  await menuOn(ITEM_6);
  typeIn('requeue');
  enter();
  expect(host.posts).toEqual([{ path: `${QUEUE_PATH}/requeue`, body: { dedupKey: 'ticket:FAKE-6' } }]);
  expect(cmdk()).toBe('');
});

test('by keyboard alone: drop', async () => {
  bootIndexed();
  await menuOn(ITEM_6);
  typeIn('drop');
  enter();
  expect(dialogTitle()).toBe('drop ticket:FAKE-6');
  expect(host.posts).toEqual([]);
  host.press('Enter');
  expect(host.posts).toEqual([{ path: `${QUEUE_PATH}/drop`, body: { dedupKey: 'ticket:FAKE-6' } }]);
});

/** Adds a second waiting item to the queue, so the first can move down and the second up. */
function twoWaiting() {
  const file = join(queueDirOf(m), 'queue.json');
  const queue = JSON.parse(readFileSync(file, 'utf8'));
  const waiting = queue.items.find((item: { state: string }) => item.state === 'queued');
  queue.items.push({ ...waiting, dedupKey: 'ticket:FAKE-7', source: { kind: 'ticket', ticketKey: 'FAKE-7' } });
  writeFileSync(file, JSON.stringify(queue));
}

test('by keyboard alone: move down and move up', async () => {
  twoWaiting();
  bootIndexed();
  await menuOn(ITEM_ROW);
  typeIn('move down');
  enter();
  await menuOn({ ...ITEM_ROW, item: 'ticket:FAKE-7' });
  typeIn('move up');
  enter();
  expect(host.posts).toEqual([
    { path: `${QUEUE_PATH}/move`, body: { dedupKey: 'ticket:FAKE-5', after: 'ticket:FAKE-7' } },
    { path: `${QUEUE_PATH}/move`, body: { dedupKey: 'ticket:FAKE-7', before: 'ticket:FAKE-5' } },
  ]);
});

test('by keyboard alone: poll', async () => {
  bootIndexed();
  await menuOn(WORKFLOW_ROW);
  typeIn('poll');
  enter();
  expect(host.posts).toEqual([{ path: `${QUEUE_PATH}/poll`, body: {} }]);
});

test('by keyboard alone: add, and add skipping its checks', async () => {
  bootIndexed();
  await menuOn(WORKFLOW_ROW);
  typeIn('add');
  enter();
  expect(stepLabel()).toBe('Ticket key');
  typeIn('FAKE-9');
  enter();
  expect(host.posts).toEqual([{ path: `${QUEUE_PATH}/add`, body: { ticketKey: 'FAKE-9' } }]);
  await settle();
  await menuOn(WORKFLOW_ROW);
  typeIn('add');
  host.press('ArrowDown', true);
  enter();
  expect(stepLabel()).toBe('Ticket key');
  typeIn('FAKE-10');
  enter();
  expect([dialogTitle(), host.posts.length]).toEqual(['add FAKE-10, skipping its checks', 1]);
  host.press('Enter');
  expect(host.posts.at(-1)).toEqual({ path: `${QUEUE_PATH}/add`, body: { ticketKey: 'FAKE-10', force: true } });
});

test('by keyboard alone: watch and unwatch', async () => {
  bootWatching(['ticket-to-pr']);
  await menuOn({ subject: 'workflow', repo: 'beta', workflow: QUEUE_WORKFLOW });
  typeIn('unwatch');
  enter();
  expect(host.posts).toEqual([{ path: '/api/repos/beta/unwatch', body: { workflows: [QUEUE_WORKFLOW] } }]);
  await settle();
  await menuOn({ subject: 'repo', repo: 'beta' });
  typeIn('watch all');
  enter();
  expect(host.posts.at(-1)).toEqual({ path: '/api/repos/beta/watch', body: { workflows: [] } });
});

test('by keyboard alone: all clear, which hides the rows the Inbox shows', async () => {
  bootIndexed();
  host.press('1');
  host.advance(100);
  cmdK();
  host.advance(100);
  typeIn('all clear');
  enter();
  expect(toasts()).toEqual(['ok all clear: 3 rows are hidden from the Inbox']);
  expect(host.posts).toEqual([]);
});

test('by keyboard alone: dismiss, which hides the Inbox row under the cursor, as e does', async () => {
  bootIndexed();
  host.press('1');
  host.press('j');
  host.press('j');
  host.advance(100);
  expect(page?.ui.listCursor).toContain('inbox:');
  cmdK();
  host.advance(100);
  typeIn('dismiss');
  enter();
  expect(toasts()).toEqual(['ok dismiss: FAKE-2 failed: stage_error is hidden from the Inbox']);
  expect(host.posts).toEqual([]);
});

test('a cursor on an Inbox row makes its run the subject', async () => {
  bootIndexed();
  host.press('1');
  host.press('j');
  host.press('j');
  cmdK();
  host.advance(100);
  expect(menuHead()).toBe('FAKE-2 · Print the version with --version');
});

test('Esc steps back through add’s steps, then closes', async () => {
  bootIndexed();
  cmdK();
  host.advance(100);
  typeIn('add a ticket');
  enter();
  expect(stepLabel()).toBe('Queue');
  enter();
  expect(stepLabel()).toBe('Ticket key');
  typeIn('FAKE-9');
  host.press('Escape', true);
  host.advance(100);
  expect(stepLabel()).toBe('Queue');
  host.press('Escape', true);
  host.advance(100);
  expect([stepLabel(), cmdk()]).toEqual([undefined, expect.stringContaining('switch theme')]);
  host.press('Escape', true);
  host.advance(100);
  expect(cmdk()).toBe('');
  expect(host.posts).toEqual([]);
});

test('poll every queue posts one poll for each queue that offers it enabled, and a disabled row sends nothing on Enter or a click', async () => {
  bootIndexed();
  cmdK();
  host.advance(100);
  typeIn('poll every');
  enter();
  expect(host.posts).toEqual([{ path: `${QUEUE_PATH}/poll`, body: {} }]);
  host.posts.length = 0;
  host.push(host.open('index')[0], indexMessage({ state: 'watcher not running', why: 'no watcher is running' }));
  cmdK();
  host.advance(100);
  typeIn('poll every');
  expect(cmdk()).toContain('<span class="cmdk-why">no watcher is running</span>');
  enter();
  host.click({ action: 'menu-run', row: '0' });
  expect(host.posts).toEqual([]);
});

// A right-click on a row opens its subject group in place (ADW-520).
test('a right-click on a row opens its subject group in place: its head, its offered actions, no field, no go to, no general group', async () => {
  bootIndexed();
  host.point('hover', FAKE_2_ROW);
  expect(host.point('context', ITEM_6, { x: 300, y: 140 })).toBe(true);
  await settle();
  host.advance(100);
  expect(menuHead()).toBe('FAKE-6 · Greet in French with --lang fr');
  expect(menuLabels()).toEqual(['requeue', 'drop']);
  expect(cmdk()).toContain('class="cmdk ctx"');
  expect(cmdk()).toContain('style="left:300px;top:140px"');
  expect(cmdk()).not.toContain('<input');
  expect(cmdk()).not.toContain('cmdk-grp');
  expect(host.menuFocuses).toBe(1);
});

test('the row right-clicked is the subject while another is open, and Enter on drop opens the dialog for the item', async () => {
  page = boot(host);
  firstIndex(GOLDEN_RUN_ID);
  host.advance(100);
  host.point('context', ITEM_6, { x: 0, y: 0 });
  host.advance(100);
  host.press('ArrowDown');
  host.advance(100);
  expect(menuSel()).toBe('drop');
  host.press('Enter');
  host.advance(100);
  expect([dialogTitle(), host.posts, cmdk()]).toEqual(['drop ticket:FAKE-6', [], '']);
  host.press('Enter');
  expect(host.posts).toEqual([{ path: `${QUEUE_PATH}/drop`, body: { dedupKey: 'ticket:FAKE-6' } }]);
});

test('the menu redraws when its subject’s offers land after it is drawn: a run that is not open', async () => {
  bootIndexed();
  host.holdActions = true;
  host.point('context', FAKE_2_ROW, { x: 0, y: 0 });
  await settle();
  host.advance(100);
  expect(menuHead()).toBe('FAKE-2 · Print the version with --version');
  expect(menuLabels()).not.toContain('clean');
  host.releaseActions();
  await settle();
  await settle();
  host.advance(100);
  expect(menuLabels()).toContain('clean');
});

test('the menu redraws when the open run’s offers land after it is drawn', async () => {
  host.holdActions = true;
  await openRunPage(FAKE_2_ID);
  cmdK();
  await settle();
  host.advance(100);
  expect(menuLabels()).not.toContain('clean');
  host.releaseActions();
  await settle();
  await settle();
  host.advance(100);
  expect(menuLabels()).toContain('clean');
});

test('a right-click off every row is the browser’s: nothing opens and it is not taken', () => {
  bootIndexed();
  expect(host.point('context', undefined)).toBe(false);
  expect(host.point('context', { repo: 'beta' })).toBe(false);
  host.advance(100);
  expect(cmdk()).toBe('');
});

test('a right-click while the confirmation dialog is open is the browser’s, and a context menu closes on Escape or the backdrop', async () => {
  bootIndexed();
  host.point('context', ITEM_6, { x: 0, y: 0 });
  host.advance(100);
  host.press('Escape');
  host.advance(100);
  expect(cmdk()).toBe('');
  host.point('context', ITEM_6, { x: 0, y: 0 });
  host.click({ action: 'menu-close' });
  host.advance(100);
  expect(cmdk()).toBe('');
  settleQueue();
  await menuOn(FAKE_3_ROW);
  typeIn('stop');
  enter();
  expect(dialogTitle()).toBe(`stop FAKE-3`);
  expect(host.point('context', ITEM_6)).toBe(false);
});

test('a context menu asks a typed step in its own field, and Escape steps back to the subject group before it closes', async () => {
  settleQueue();
  bootIndexed();
  host.point('context', FAKE_3_ROW, { x: 10, y: 10 });
  await settle();
  host.advance(100);
  expect(menuSel()).toBe('resume');
  host.press('Enter');
  host.advance(100);
  expect(stepLabel()).toBe('Raise $');
  expect(cmdk()).toContain('<input class="cmdk-in" name="menu-query" type="number"');
  host.press('Escape', true);
  host.advance(100);
  expect([stepLabel(), menuLabels()]).toEqual([undefined, ['resume', 'stop', 'stop now']]);
  host.press('Escape', true);
  host.advance(100);
  expect(cmdk()).toBe('');
});

describe('the page keeps its URL in step with what it shows (ADW-513)', () => {
  const QUEUE = `beta/${QUEUE_WORKFLOW}`;
  // The page loaded at the golden run: with nothing named, the first index opens no run.
  const open = () => {
    host.startAt = { repo: 'alpha', run: GOLDEN_RUN_ID };
    page = boot(host);
    host.push(host.open('index')[0], indexMessage());
    replay(host.open('run=')[0], GOLDEN());
    host.advance(100);
  };

  test('the first index writes the run it opened, in place of the current entry', () => {
    open();
    expect(host.urls).toEqual([{ query: `repo=alpha&run=${GOLDEN_RUN_ID}`, push: false }]);
  });

  test('selecting a run, a queue, a card, a tab, a file and closing it each push one entry naming the selection', () => {
    open();
    host.urls = [];
    host.click({ action: 'select-run', repo: 'alpha', run: FAKE_2_ID });
    expect(host.urls).toEqual([{ query: `repo=alpha&run=${FAKE_2_ID}`, push: true }]);
    host.urls = [];
    host.click({ action: 'select-queue', queue: QUEUE });
    expect(host.urls).toEqual([{ query: 'queue=beta%2Fticket-to-pr', push: true }]);
    host.urls = [];
    host.click({ action: 'select-run', repo: 'alpha', run: FAKE_2_ID });
    host.urls = [];
    host.click({ action: 'select-card', key: 'implement#1' });
    expect(host.urls).toEqual([{ query: `repo=alpha&run=${FAKE_2_ID}&key=implement%231&timeline=1`, push: true }]);
    host.urls = [];
    host.click({ action: 'tab', tab: 'files' });
    expect(host.urls).toEqual([
      { query: `repo=alpha&run=${FAKE_2_ID}&key=implement%231&tab=files&timeline=1`, push: true },
    ]);
    host.urls = [];
    host.click({ action: 'open-file', name: 'x.md', path: 'implement#1/out/x.md' });
    expect(host.urls.map((url) => [url.push, url.query.endsWith('&file=implement%231%2Fout%2Fx.md')])).toEqual([
      [true, true],
    ]);
    host.urls = [];
    host.click({ action: 'close-file' });
    expect(host.urls).toEqual([
      { query: `repo=alpha&run=${FAKE_2_ID}&key=implement%231&tab=files&timeline=1`, push: true },
    ]);
  });

  test('the keys Enter, ] and Escape push one entry each', () => {
    open();
    host.click({ action: 'select-run', repo: 'alpha', run: FAKE_2_ID });
    replay(host.open('run=')[0], fake2Dir(m));
    host.urls = [];
    host.press('Enter');
    expect(host.urls).toEqual([{ query: `repo=alpha&run=${FAKE_2_ID}&key=intake%231&timeline=1`, push: true }]);
    host.urls = [];
    host.press(']');
    expect(host.urls).toEqual([{ query: `repo=alpha&run=${FAKE_2_ID}&key=spec%231&timeline=1`, push: true }]);
    host.urls = [];
    host.press('Escape');
    host.press('Escape');
    expect(host.urls).toEqual([
      { query: `repo=alpha&run=${FAKE_2_ID}&key=spec%231`, push: true },
      { query: `repo=alpha&run=${FAKE_2_ID}`, push: true },
    ]);
  });

  test('toggling the theme, a group or follow writes nothing, and nothing is written before the first index', () => {
    page = boot(host);
    host.click({ action: 'toggle-theme' });
    host.click({ action: 'select-card', key: 'implement#1' });
    host.push(host.open('index')[0], indexMessage());
    expect(host.urls.map((url) => url.push)).toEqual([false]);
    host.urls = [];
    host.click({ action: 'toggle-theme' });
    host.click({ action: 'toggle-group', group: 'alpha' });
    host.click({ action: 'toggle-follow' });
    expect(host.urls).toEqual([]);
  });

  test('an index that no longer lists the open queue replaces the entry with the run', () => {
    open();
    host.click({ action: 'select-queue', queue: QUEUE });
    host.urls = [];
    const listed = indexMessage();
    host.push(host.open('index')[0], {
      ...listed,
      repos: listed.repos.map((repo) => ({ ...repo, queues: [] })),
    });
    expect(host.urls).toEqual([{ query: `repo=alpha&run=${GOLDEN_RUN_ID}`, push: false }]);
  });

  test("a restart's answer naming a new run replaces the entry with that run", async () => {
    await openOffering('alpha', FAKE_2_ID, fake2Dir(m));
    host.postAnswer = { status: 202, body: JSON.stringify({ runId: NEW_ID }) };
    host.click({ action: 'restart-run' });
    host.urls = [];
    host.click({ action: 'dialog-confirm' });
    await settle();
    expect(host.urls).toEqual([{ query: `repo=alpha&run=${NEW_ID}&view=history`, push: false }]);
  });
});

describe('loading a URL opens what it names (ADW-513)', () => {
  const FILE = 'implement#1/out/notes.txt';
  const FILE_READ = `${`/api/repos/alpha/runs/${FAKE_2_ID}`}/file?path=${encodeURIComponent(FILE)}`;
  const start = (query: Record<string, string>) => {
    host.startAt = query;
    page = boot(host);
    host.push(host.open('index')[0], indexMessage());
  };

  test('repo, run, call, tab and timeline open FAKE-2 at implement#1 on its permissions tab with its timeline, with no push', async () => {
    start({ repo: 'alpha', run: FAKE_2_ID, key: 'implement#1', tab: 'permissions', timeline: '1' });
    expect(host.open('run=').map((socket) => socket.query)).toEqual([runQuery('alpha', FAKE_2_ID)]);
    replay(host.open('run=')[0], fake2Dir(m));
    await settle();
    host.advance(100);
    expect(host.regions.inspector).toContain(
      '<button class="tab on" data-action="tab" data-tab="permissions">permissions</button>',
    );
    expect(host.regions.main).toContain('class="tl-top"');
    expect(host.urls.filter((url) => url.push)).toEqual([]);
  });

  test("a file in the URL is read for the drawer, named by the path's last segment", async () => {
    host.bodies.set(FILE_READ, { status: 200, body: 'hello notes' });
    start({ repo: 'alpha', run: FAKE_2_ID, file: FILE });
    await settle();
    host.advance(100);
    expect(host.reads.map((read) => read.path)).toEqual([FILE_READ]);
    expect(host.regions.drawer).toContain('<b>notes.txt</b>');
    expect(host.regions.drawer).toContain('hello notes');
  });

  test('a queue in the URL draws the queue view', () => {
    start({ queue: `beta/${QUEUE_WORKFLOW}` });
    host.advance(100);
    expect(host.regions.main).toStartWith('<div class="d-h"><span class="d-title">ticket-to-pr queue</span>');
  });

  test('a queue the index does not list says so and opens no run, leaving the list the centre', () => {
    start({ queue: 'beta/nope' });
    host.advance(100);
    expect(host.regions.toasts).toContain('queue beta/nope is not listed');
    expect(host.open('run=')).toEqual([]);
    expect(host.regions.main).toContain('No run selected');
    expect(host.urls).toEqual([{ query: '', push: false }]);
  });

  test("a call an ended run does not have is dropped at the stream's end, with a toast, and the URL replaced; before the end it stays", () => {
    start({ repo: 'alpha', run: FAKE_2_ID, key: 'nope#1' });
    const [socket] = host.open('run=');
    host.push(socket, { kind: 'event', event: readEvents(fake2Dir(m))[0] });
    expect(page?.ui.key).toBe('nope#1');
    replay(socket, fake2Dir(m));
    host.advance(100);
    expect(page?.ui.key).toBeUndefined();
    expect(host.regions.toasts).toContain(`call nope#1 is not in run ${FAKE_2_ID}`);
    expect(host.urls.at(-1)).toEqual({ query: `repo=alpha&run=${FAKE_2_ID}`, push: false });
  });

  test('a file whose read answers 404 leaves the drawer empty, says so, and replaces the URL without it', async () => {
    host.bodies.set(FILE_READ, { status: 404, body: '' });
    start({ repo: 'alpha', run: FAKE_2_ID, file: FILE });
    await settle();
    host.advance(100);
    expect(host.regions.drawer).toBe('');
    expect(host.regions.toasts).toContain(`file ${FILE} is not in run ${FAKE_2_ID}`);
    expect(host.urls.at(-1)).toEqual({ query: `repo=alpha&run=${FAKE_2_ID}`, push: false });
  });

  test('an unknown tab shows the overview and no toast', async () => {
    start({ repo: 'alpha', run: FAKE_2_ID, key: 'implement#1', tab: 'bogus' });
    replay(host.open('run=')[0], fake2Dir(m));
    await settle();
    host.advance(100);
    expect(host.regions.inspector).toContain('<button class="tab on" data-action="tab" data-tab="overview">');
    expect(host.regions.toasts).not.toContain('is not');
  });

  test('the not-listed toast shows until a run or a queue is selected', () => {
    start({ repo: 'alpha', run: 'NOPE-1' });
    host.advance(100);
    expect(host.regions.toasts).toContain('run NOPE-1 of alpha is not listed');
    host.click({ action: 'select-run', repo: 'alpha', run: FAKE_2_ID });
    host.advance(100);
    expect(host.regions.toasts).not.toContain('is not listed');
  });

  test('the not-listed toast goes once a needs-attention row opens a run (review R2)', () => {
    start({ repo: 'alpha', run: 'NOPE-1' });
    host.advance(100);
    expect(host.regions.toasts).toContain('run NOPE-1 of alpha is not listed');
    host.click({ action: 'open', repo: 'alpha', run: FAKE_2_ID, key: 'implement#1' });
    host.advance(100);
    expect(host.regions.toasts).not.toContain('is not listed');
  });
});

describe('Back and forward open what an entry names, and push nothing (ADW-513)', () => {
  const QUEUE = `beta/${QUEUE_WORKFLOW}`;
  const FILE = 'implement#1/out/notes.txt';
  const FILE_READ = `/api/repos/alpha/runs/${FAKE_2_ID}/file?path=${encodeURIComponent(FILE)}`;
  // The page loaded at the golden run: with nothing named, the first index opens no run.
  const open = () => {
    host.startAt = { repo: 'alpha', run: GOLDEN_RUN_ID };
    page = boot(host);
    host.push(host.open('index')[0], indexMessage());
    replay(host.open('run=')[0], GOLDEN());
    host.advance(100);
  };
  const query = (at: number) => host.urls[at]?.query ?? '';
  const pushes = () => host.urls.filter((url) => url.push).length;

  test('Back from a tab to its card, and from the card to the cards, reopens each; neither writes', () => {
    open();
    host.click({ action: 'select-run', repo: 'alpha', run: FAKE_2_ID });
    replay(host.open('run=')[0], fake2Dir(m));
    host.click({ action: 'select-card', key: 'implement#1' });
    host.click({ action: 'tab', tab: 'log' });
    host.advance(100);
    const written = host.urls.length;
    const [run, card] = [query(written - 3), query(written - 2)];
    host.go(card);
    host.advance(100);
    expect(page?.ui.key).toBe('implement#1');
    expect(page?.ui.tab).toBe('overview');
    host.go(run);
    host.advance(100);
    expect(page?.ui.key).toBeUndefined();
    expect(cards(host.regions.main)).toContain('implement#1');
    expect(host.regions.main).not.toContain(' sel"');
    expect(host.urls).toHaveLength(written);
  });

  test('a move from a run to a queue and back keeps the run socket and draws each', () => {
    open();
    host.click({ action: 'select-queue', queue: QUEUE });
    const run = query(0);
    const sockets = host.open('run=').length;
    host.go('queue=beta%2Fticket-to-pr');
    host.advance(100);
    expect(host.regions.main).toStartWith('<div class="d-h"><span class="d-title">ticket-to-pr queue</span>');
    host.go(run);
    host.advance(100);
    expect(cards(host.regions.main)).toContain('implement#1');
    expect([host.open('run=').length, host.sockets.filter((s) => s.query.startsWith('run=')).length]).toEqual([
      sockets,
      sockets,
    ]);
    expect(pushes()).toBe(1);
  });

  test('a move to an entry with an empty query closes the queue and the run, giving the list the centre (review R3)', () => {
    open();
    host.click({ action: 'select-queue', queue: QUEUE });
    const written = host.urls.length;
    host.go('');
    host.advance(100);
    expect([page?.ui.queue, page?.ui.runId]).toEqual([undefined, undefined]);
    expect(host.regions.main).toContain('No run selected');
    expect(host.urls).toHaveLength(written);
  });

  test('a move to a query with a file opens the drawer, and to one without it empties it', async () => {
    host.bodies.set(FILE_READ, { status: 200, body: 'hello notes' });
    open();
    host.click({ action: 'select-run', repo: 'alpha', run: FAKE_2_ID });
    replay(host.open('run=')[0], fake2Dir(m));
    const base = `repo=alpha&run=${FAKE_2_ID}`;
    host.go(`${base}&file=${encodeURIComponent(FILE)}`);
    await settle();
    host.advance(100);
    expect(host.regions.drawer).toContain('<b>notes.txt</b>');
    host.go(base);
    host.advance(100);
    expect(host.regions.drawer).toBe('');
  });

  test('a move to a run the index no longer lists keeps the open run, says so, and replaces the entry with the open run', () => {
    open();
    host.urls = [];
    host.go('repo=alpha&run=GONE-1');
    host.advance(100);
    expect(host.regions.toasts).toContain('run GONE-1 of alpha is not listed');
    expect(host.open('run=').map((socket) => socket.query)).toEqual([runQuery('alpha', GOLDEN_RUN_ID)]);
    expect(host.urls).toEqual([{ query: `repo=alpha&run=${GOLDEN_RUN_ID}`, push: false }]);
  });

  test('a move before the first index is what the first index opens, and writes nothing', () => {
    page = boot(host);
    host.go(`repo=alpha&run=${FAKE_2_ID}`);
    expect(host.urls).toEqual([]);
    host.push(host.open('index')[0], indexMessage());
    expect(host.open('run=').map((socket) => socket.query)).toEqual([runQuery('alpha', FAKE_2_ID)]);
  });

  test("a move before the first index shows the entry's view, and the first index keeps it in the URL", () => {
    host.startAt = { view: 'history' };
    page = boot(host);
    host.go(`repo=alpha&run=${FAKE_2_ID}&view=queues`);
    host.push(host.open('index')[0], indexMessage());
    host.advance(100);
    expect(page.ui.view).toBe('queues');
    expect(host.urls).toEqual([{ query: `repo=alpha&run=${FAKE_2_ID}&view=queues`, push: false }]);
  });
});

describe('Copy link (ADW-513)', () => {
  const select = () => {
    page = boot(host);
    host.push(host.open('index')[0], indexMessage());
    host.click({ action: 'select-run', repo: 'alpha', run: FAKE_2_ID });
    host.click({ action: 'select-card', key: 'implement#1' });
    host.advance(100);
  };

  test('the link region draws a Copy link button after the first flush', () => {
    page = boot(host);
    host.advance(100);
    expect(host.regions.link).toContain(
      '<button class="btn" type="button" data-action="copy-link" aria-label="copy link" title="copy link">',
    );
  });

  test('a click copies the current URL and toasts that it copied the link, and no URL is written', async () => {
    select();
    const written = host.urls.length;
    host.click({ action: 'copy-link' });
    await settle();
    host.advance(100);
    expect(host.copied).toEqual([`http://dashboard/?repo=alpha&run=${FAKE_2_ID}&key=implement%231&timeline=1`]);
    expect(host.regions.toasts).toContain('<span class="toast-head">copy link</span>');
    expect(host.regions.toasts).toContain('copied this page&#39;s link');
    expect(host.urls).toHaveLength(written);
  });

  test('the toast is gone four seconds later', async () => {
    select();
    host.click({ action: 'copy-link' });
    await settle();
    host.advance(3999);
    expect(host.regions.toasts).toContain('copied this page&#39;s link');
    host.advance(1);
    host.advance(100);
    expect(host.regions.toasts).not.toContain('link copied');
  });

  test('a clipboard that refuses toasts, in red, that the link could not be copied', async () => {
    select();
    host.copyTakes = false;
    host.click({ action: 'copy-link' });
    await settle();
    host.advance(100);
    expect(host.regions.toasts).toContain('toast bad');
    expect(host.regions.toasts).toContain('the link could not be copied');
  });
});

/** The index with beta's queue held, on `harnessKey` when given, and with no hold when `held` is false. */
const heldIndex = (held: boolean, harnessKey?: string) => {
  const message = indexMessage();
  return {
    ...message,
    repos: message.repos.map((repo) => ({
      ...repo,
      queues: repo.queues.map((queue) => ({
        ...queue,
        queue:
          repo.name === 'beta' && queue.queue !== undefined
            ? {
                ...queue.queue,
                ...(held
                  ? {
                      held: {
                        until: '2099-01-01T00:00:00.000Z',
                        runId: 'r',
                        reason: 'claude-code hit the usage limit',
                        at: '2026-11-10T10:00:00.000Z',
                        ...(harnessKey === undefined ? {} : { harnessKey }),
                      },
                    }
                  : {}),
              }
            : queue.queue,
      })),
    })),
  };
};
function openHeldBetaQueue() {
  const socket = openBetaQueue();
  host.push(host.open('index')[0], heldIndex(true, 'claude-code'));
  host.advance(100);
  return socket;
}

describe('audit 2: overlays behave (ADW-542)', () => {
  const NO_WATCHER: QueueWatch = {
    state: 'watcher not running',
    why: "no watcher is running for 'beta': sail watch ticket-to-pr first",
  };
  /** The index with beta's queue held on claude-code and no watcher running. */
  const heldUnwatched = () => {
    const held = heldIndex(true, 'claude-code');
    const off = indexMessage(NO_WATCHER);
    return {
      ...held,
      repos: held.repos.map((repo, at) => ({
        ...repo,
        queues: repo.queues.map((queue, place) => {
          const unwatched = off.repos[at]?.queues[place];
          return { ...queue, watch: NO_WATCHER, offers: unwatched?.offers };
        }),
      })),
    };
  };
  const press = (key: string) => {
    const handled = host.press(key);
    host.advance(100);
    return handled;
  };

  test('N1: release opens its dialog on a held queue with no watcher running, it stays open across draws, and its confirm posts', async () => {
    openBetaQueue();
    host.push(host.open('index')[0], heldUnwatched());
    host.advance(100);
    expect(host.regions.main).toContain('data-harness="claude-code"');
    host.click({ action: 'release-hold', ...BETA, harness: 'claude-code' });
    host.advance(100);
    host.push(host.open('index')[0], heldUnwatched());
    host.advance(100);
    expect([dialogTitle(), host.dialogCloses, page?.store.actor.dialogAction()]).toEqual([
      'release the usage-limit hold on claude-code',
      0,
      'release-hold',
    ]);
    host.postAnswer = { status: 200, body: JSON.stringify({ message: 'released' }) };
    host.click({ action: 'dialog-confirm' });
    await settle();
    expect(host.posts).toEqual([{ path: `${QUEUE_PATH}/release`, body: { harnessKey: 'claude-code' } }]);
  });

  test("N1: an add skipping its checks keeps its dialog across a draw of a watched queue that isn't held", () => {
    openBetaQueue();
    host.fields['add-ticket'] = 'FAKE-10';
    host.click({ action: 'add-ticket-force', ...BETA });
    host.push(host.open('index')[0], indexMessage());
    host.advance(100);
    expect([dialogTitle(), host.dialogCloses]).toEqual(['add FAKE-10, skipping its checks', 0]);
  });

  test("N3: a run's dialog names it by its ticket key, with its title and full id on a quiet line under it", async () => {
    await openOffering('alpha', FAKE_2_ID, fake2Dir(m));
    host.click({ action: 'restart-run' });
    expect(dialogTitle()).toBe('restart FAKE-2');
    expect(host.dialog).toContain(
      `<p class="dlg-sub"><span class="dlg-about">Print the version with --version</span><span class="dlg-id">${FAKE_2_ID}</span></p>`,
    );
  });

  test("N6: a key's hint is neutral, replaces the hint before it and leaves by itself; refusals stay, three show under a count of the rest, and Escape dismisses the newest", () => {
    bootIndexed();
    press('p');
    press('o');
    expect(toasts()).toEqual(['hint open (O): needs an open run']);
    expect(host.regions.toasts).toContain('<div class="toast quiet" role="status"');
    host.advance(HINT_MS);
    expect(toasts()).toEqual([]);
    for (const n of [1, 2, 3, 4, 5]) if (page !== undefined) toast(page.store, 'bad', `stop R${n}`, 'refused');
    host.advance(60_000);
    expect(toasts()).toHaveLength(5);
    expect(host.regions.toasts).toStartWith('<div class="toast-more">+2 more</div>');
    expect(host.regions.toasts?.match(/class="toast bad"/g)).toHaveLength(3);
    expect(host.regions.toasts).not.toContain('stop R2');
    press('Escape');
    expect(toasts().map((each) => each.split(':')[0])).toEqual([
      'bad stop R1',
      'bad stop R2',
      'bad stop R3',
      'bad stop R4',
    ]);
    expect(host.regions.toasts).toStartWith('<div class="toast-more">+1 more</div>');
  });

  test('N6: with a run open, Escape dismisses the toasts first, then closes the run', async () => {
    await openOffering('alpha', FAKE_2_ID, fake2Dir(m));
    // The run's menu shuts first.
    press('Escape');
    expect([page?.ui.runMenu, page?.ui.runId]).toEqual([undefined, FAKE_2_ID]);
    if (page !== undefined) toast(page.store, 'bad', 'stop', 'refused');
    press('Escape');
    expect([toasts(), page?.ui.runId]).toEqual([[], FAKE_2_ID]);
    press('Escape');
    expect(page?.ui.runId).toBeUndefined();
  });

  test("N16: a key not offered says why from the item's state, or that it isn't offered here, in a hint that replaces the last", () => {
    bootIndexed();
    host.point('hover', ITEM_ROW);
    press('r');
    expect(toasts()).toEqual(["hint requeue ticket:FAKE-5: isn't offered while the item is queued"]);
    host.point('hover', WORKFLOW_ROW);
    page?.store.index?.forEach((repo) => {
      for (const queue of repo.queues) delete (queue as { offers?: unknown }).offers;
    });
    press('p');
    expect(toasts()).toEqual([`hint poll beta / ${QUEUE_WORKFLOW}: isn't offered here`]);
  });

  test('N4: the menu reveals its highlighted row after each move, inside its own scroller', () => {
    bootIndexed();
    cmdK();
    host.advance(100);
    host.revealedOpen = [];
    for (let i = 0; i < 11; i++) {
      host.press('ArrowDown', true);
      host.advance(100);
    }
    expect(host.revealedOpen.filter((region) => region === 'menu')).toHaveLength(11);
    expect(cmdk()).toContain('<div class="cmdk-rows" id="cmdk-rows" data-scroll="menu-rows" role="listbox"');
  });

  test('N20: Tab stays in the shortcut sheet, and the bare a opens no view', () => {
    bootIndexed();
    expect(press('Tab')).toBe(false);
    press('?');
    expect(press('Tab')).toBe(true);
    press('Escape');
    const view = page?.ui.view;
    press('a');
    expect(page?.ui.view).toBe(view);
  });
});

test('the first click on release opens the dialog saying what it does and posts nothing, and its cancel and Escape close it with nothing sent (ADW-517)', () => {
  openHeldBetaQueue();
  const row = { ...BETA, harness: 'claude-code' };
  expect(host.regions.main).toContain('data-harness="claude-code"');
  host.click({ action: 'release-hold', ...row });
  host.advance(100);
  expect([host.posts, dialogTitle(), dialogVerb()]).toEqual([
    [],
    'release the usage-limit hold on claude-code',
    'release',
  ]);
  expect(dialogLines()).toEqual(['releasing ends every watcher&#39;s hold on claude-code, and dispatch resumes']);
  host.click({ action: 'dialog-cancel' });
  host.advance(100);
  expect([host.posts, host.dialog]).toEqual([[], undefined]);
  host.click({ action: 'release-hold', ...row });
  host.advance(100);
  expect(dialogTitle()).toBe('release the usage-limit hold on claude-code');
  host.press('Escape');
  host.advance(100);
  expect([host.posts, host.dialog]).toEqual([[], undefined]);
});

test("the dialog's confirm posts the key to the queue's release route, and the answer is a toast: a 200 its message, a 409 its error, no answer says so (ADW-517)", async () => {
  openHeldBetaQueue();
  const row = { ...BETA, harness: 'claude-code' };
  const answers: (string | undefined)[] = [];
  for (const answer of [
    { status: 200, body: JSON.stringify({ message: 'released the usage-limit hold on claude-code' }) },
    { status: 409, body: JSON.stringify({ error: 'nope' }) },
    { status: 0, body: '' },
  ]) {
    host.postAnswer = answer;
    host.click({ action: 'release-hold', ...row });
    host.click({ action: 'dialog-confirm' });
    await settle();
    host.advance(100);
    answers.push(toasts().at(-1));
  }
  expect(host.posts).toEqual(
    [0, 1, 2].map(() => ({ path: `${QUEUE_PATH}/release`, body: { harnessKey: 'claude-code' } })),
  );
  expect(answers).toEqual([
    'ok release beta / ticket-to-pr: released the usage-limit hold on claude-code',
    'bad release beta / ticket-to-pr: nope',
    'bad release beta / ticket-to-pr: the release could not be sent: the dashboard did not answer',
  ]);
});

test('once the index says the queue is no longer held, its banner, its button and an open release dialog are gone, and a hold that comes back asks again (ADW-517)', () => {
  openHeldBetaQueue();
  host.click({ action: 'release-hold', ...BETA, harness: 'claude-code' });
  host.advance(100);
  expect(dialogTitle()).toBe('release the usage-limit hold on claude-code');
  host.push(host.open('index')[0], heldIndex(false));
  host.advance(100);
  expect([host.dialog, host.regions.main?.includes('held until'), host.regions.main?.includes('release-hold')]).toEqual(
    [undefined, false, false],
  );
  host.push(host.open('index')[0], heldIndex(true, 'claude-code'));
  host.advance(100);
  expect([host.dialog, host.regions.main?.includes('data-action="release-hold"'), host.posts]).toEqual([
    undefined,
    true,
    [],
  ]);
});

test('the highlight stays on the row a person moved to when an index tick removes rows before it, and Enter runs that row', () => {
  bootIndexed();
  cmdK();
  host.advance(100);
  for (let i = 0; i < 7; i++) host.press('ArrowDown', true);
  host.advance(100);
  expect(menuSel()).toBe('switch theme');
  const message = indexMessage();
  host.push(host.open('index')[0], {
    ...message,
    repos: message.repos.map((repo) => ({
      ...repo,
      queues: repo.queues.map((queue) => ({ ...queue, offers: undefined })),
    })),
  });
  host.advance(100);
  expect(menuLabels()).not.toContain('poll every queue');
  expect(menuSel()).toBe('switch theme');
  host.press('Enter', true);
  expect([page?.ui.theme, page?.ui.pinned]).toEqual(['light', false]);
});

describe('the Inbox view (ADW-527)', () => {
  const items = () => attention(index(m.registryDir));
  const failed = () => items().find((item) => item.kind === 'failed' && item.runId === FAKE_2_ID);

  test('the sidebar draws the Inbox first, as a select-view button with the count of undismissed items', () => {
    page = boot(host);
    plainIndex();
    host.advance(100);
    expect(host.regions.sidebar).toMatch(
      /^<div class="side-views"><button class="side-ent" type="button" data-action="select-view" data-view="inbox"><span class="nm">Inbox<\/span><span class="c">3<\/span>/,
    );
    host.click({ action: 'select-view', view: 'inbox' });
    host.advance(100);
    expect(host.regions.list).toContain('<span class="lh-t">Inbox</span><span class="c">3</span>');
    expect(host.regions.list).toContain('<span class="r-id">FAKE-2</span><b class="r-title">failed: stage_error</b>');
    expect(host.regions.list).toContain(
      '<span class="r-id">FAKE-6</span><b class="r-title">parked after 2 attempts</b>',
    );
  });

  test('opening an Inbox row keeps the Inbox and opens its run at its call in error', () => {
    page = boot(host);
    plainIndex();
    host.click({ action: 'select-view', view: 'inbox' });
    host.advance(100);
    const item = failed();
    if (item === undefined) throw new Error('no failed item');
    host.click({
      action: 'open',
      repo: 'alpha',
      run: FAKE_2_ID,
      ...(item.opens?.key === undefined ? {} : { key: item.opens.key }),
    });
    host.advance(100);
    expect([page.ui.view, page.ui.runId, page.ui.key]).toEqual(['inbox', FAKE_2_ID, item.opens?.key]);
    expect(host.regions.list).toContain('<span class="lh-t">Inbox</span>');
    expect(host.regions.list).toMatch(/class="lrow in-row in-failed sel cur" data-row="inbox:/);
  });

  test('Enter on an Inbox row under the cursor opens its run', () => {
    page = boot(host);
    plainIndex();
    host.press('1');
    host.advance(100);
    expect(page.ui.view).toBe('inbox');
    host.press('j');
    host.press('j');
    host.press('Enter');
    host.advance(100);
    expect(page.ui.view).toBe('inbox');
    expect(page.ui.runId).toBe(FAKE_2_ID);
    expect(page.ui.listCursor).toContain('inbox:');
    expect(host.regions.list).toMatch(/class="lrow in-row in-failed sel cur" data-row="inbox:/);
  });

  test('a parked row with no listed run opens its queue, the view staying Inbox', () => {
    page = boot(host);
    plainIndex();
    host.click({ action: 'select-view', view: 'inbox' });
    host.advance(100);
    host.click({ action: 'select-queue', queue: `beta/${QUEUE_WORKFLOW}` });
    host.advance(100);
    expect([page.ui.view, page.ui.queue]).toEqual(['inbox', `beta/${QUEUE_WORKFLOW}`]);
    expect(host.regions.list).toMatch(/class="lrow in-row in-parked sel cur" data-row="inbox:/);
  });

  test('?view=inbox boots on the Inbox', () => {
    host.startAt = { view: 'inbox' };
    page = boot(host);
    plainIndex();
    host.advance(100);
    expect(page.ui.view).toBe('inbox');
    expect(host.regions.list).toContain('<span class="lh-t">Inbox</span>');
  });

  describe('dismissing', () => {
    const count = () =>
      host.regions.sidebar?.match(
        /data-view="inbox"[^>]*><span class="nm">Inbox<\/span><span class="c">(\d+)<\/span>/,
      )?.[1];
    const inbox = () => {
      page = boot(host);
      plainIndex();
      host.press('1');
      host.advance(100);
    };
    const rows = () => [...(host.regions.list ?? '').matchAll(/<b class="r-title">([^<]*)<\/b>/g)].map(([, t]) => t);

    test("e dismisses the row under the cursor and its toast's Undo lists it again", () => {
      inbox();
      host.press('j');
      host.press('j');
      expect(page?.ui.listCursor).toContain('inbox:');
      host.press('e');
      host.advance(100);
      expect(rows()).toEqual(['implement#1 ended in error', 'parked after 2 attempts']);
      expect(count()).toBe('2');
      expect(toasts()).toEqual(['ok dismiss: FAKE-2 failed: stage_error is hidden from the Inbox']);
      expect(page?.ui.toasts[0]?.undo).toBe(true);
      expect(host.posts).toEqual([]);
      expect(page?.ui.listCursor).toContain('implement#1 ended in error');
      host.click({ action: 'undo-toast', toast: '1' });
      host.advance(100);
      expect(rows()).toEqual(['failed: stage_error', 'implement#1 ended in error', 'parked after 2 attempts']);
      expect(count()).toBe('3');
    });

    test('an identity another tab saved meanwhile stays hidden after Undo', () => {
      inbox();
      host.press('j');
      host.press('j');
      host.press('e');
      host.storage.set(
        CLEARED_KEY,
        JSON.stringify([...JSON.parse(host.storage.get(CLEARED_KEY) ?? '[]'), 'other tab']),
      );
      host.click({ action: 'undo-toast', toast: '1' });
      expect(JSON.parse(host.storage.get(CLEARED_KEY) ?? '[]')).toEqual(['other tab']);
    });

    test('e on the last row moves the cursor to the previous row, and repeated e works through the list', () => {
      inbox();
      for (let i = 0; i < 5; i++) host.press('j');
      expect(page?.ui.listCursor).toContain('parked after 2 attempts');
      host.press('e');
      host.advance(100);
      expect(page?.ui.listCursor).toContain('implement#1 ended in error');
      host.press('e');
      host.press('e');
      host.advance(100);
      expect([count(), rows()]).toEqual(['0', []]);
      expect(page?.ui.listCursor).toBeUndefined();
    });

    test('with a row opened by a click, e dismisses the open run row and the run stays open', () => {
      inbox();
      host.click({ action: 'open', repo: 'alpha', run: FAKE_2_ID, key: 'implement#1' });
      host.advance(100);
      // The list's cursor goes to the row the click opened (ADW-543).
      expect(page?.ui.listCursor).toContain('failed: stage_error');
      host.press('e');
      host.advance(100);
      expect(count()).toBe('2');
      expect(rows()).not.toContain('failed: stage_error');
      expect([page?.ui.runId, page?.ui.view]).toEqual([FAKE_2_ID, 'inbox']);
    });

    test('with the list cursor on no row, e dismisses the row of the open run', () => {
      inbox();
      host.click({ action: 'open', repo: 'alpha', run: FAKE_2_ID, key: 'implement#1' });
      host.advance(100);
      // A run opened with no row under the cursor, as one a URL names is: the open run's own row is the one dismissed.
      if (page !== undefined) delete page.ui.listCursor;
      host.press('e');
      host.advance(100);
      expect(count()).toBe('2');
      expect(rows()).not.toContain('failed: stage_error');
      expect(page?.ui.runId).toBe(FAKE_2_ID);
    });

    test("a click on a row's ✕ does what e does and does not open the row", () => {
      inbox();
      expect(host.regions.list).toContain('data-action="dismiss-attention" data-item="');
      const item = attention(index(m.registryDir)).find((each) => each.kind === 'parked');
      if (item === undefined) throw new Error('no parked item');
      host.click({ action: 'dismiss-attention', item: identity(item) });
      host.advance(100);
      expect([count(), toasts()]).toEqual([
        '2',
        ['ok dismiss: FAKE-6 parked after 2 attempts is hidden from the Inbox'],
      ]);
      expect([page?.ui.runId, page?.ui.queue]).toEqual([undefined, undefined]);
    });

    test('Shift+E hides every row the Inbox shows, and its Undo lists them again', () => {
      inbox();
      host.press('E');
      host.advance(100);
      expect([count(), rows(), toasts()]).toEqual(['0', [], ['ok all clear: 3 rows are hidden from the Inbox']]);
      host.click({ action: 'undo-toast', toast: '1' });
      host.advance(100);
      expect(count()).toBe('3');
    });

    test('e and E dismiss nothing outside the Inbox, where a toast says where they work, and e does nothing in an input (ADW-523)', () => {
      inbox();
      host.press('2');
      host.press('e');
      host.press('E');
      host.press('4');
      host.press('e');
      host.press('E');
      host.press('1');
      host.press('j');
      host.press('e', true);
      host.press('E', true);
      host.advance(100);
      expect([count(), toasts()]).toEqual([
        '3',
        // A hint replaces the hint before it: one is shown at a time (ADW-542).
        ['hint all clear (⇧E): works in the Inbox'],
      ]);
    });

    test('e with no row under the cursor and no open run does nothing and draws no toast', () => {
      inbox();
      host.press('e');
      expect([count(), toasts()]).toEqual(['3', []]);
    });

    test('a dismissed row stays hidden after the page boots again on the same storage', () => {
      inbox();
      host.press('j');
      host.press('j');
      host.press('e');
      page?.stop();
      inbox();
      expect(count()).toBe('2');
      expect(rows()).not.toContain('failed: stage_error');
    });
  });
});

// Start a run from the command menu (ADW-524): the steps, the dialog with the roster, the run it opens, and start anyway.
describe('start a run (ADW-524)', () => {
  const START = { enabled: true, workflows: ['review', 'ticket-to-pr'], defaultWorkflow: 'ticket-to-pr' };
  const ROSTER = 'ticket-to-pr@1 on FAKE-1: Add a flag (Todo)\ndry run: nothing was written';
  const bootStartable = () => {
    page = boot(host);
    const message = indexMessage();
    host.push(host.open('index')[0], {
      ...message,
      repos: message.repos.map((repo) => ({ ...repo, offers: { ...repo.offers, start: START } })),
    });
    host.advance(100);
  };
  const preText = () => host.dialog?.match(/<pre class="dlg-pre">([^<]*)<\/pre>/)?.[1];
  /** Walks the menu to the step after the last, answering the check with `answer`. */
  async function ask(source: string, until: string, answer: { status: number; body: unknown }) {
    cmdK();
    host.advance(100);
    typeIn('start a run');
    enter();
    expect(stepLabel()).toBe('Repository');
    enter();
    expect([stepLabel(), menuSel()]).toEqual(['Workflow', 'ticket-to-pr']);
    enter();
    expect(stepLabel()).toBe('Ticket key or pull request');
    typeIn(source);
    enter();
    expect(stepLabel()).toBe('Stop after');
    typeIn(until);
    host.postAnswer = { status: answer.status, body: JSON.stringify(answer.body) };
    enter();
    await settle();
    host.advance(100);
  }

  test('by keyboard alone: the repository, workflow, ticket and stage, then the roster in the dialog, and confirming starts the run and opens it', async () => {
    bootStartable();
    await ask('FAKE-1', 'spec', {
      status: 200,
      body: {
        roster: ROSTER,
        key: 'FAKE-1',
        forced: [],
        start: { source: 'FAKE-1', workflow: 'ticket-to-pr', until: 'spec' },
      },
    });
    expect(host.posts).toEqual([
      { path: '/api/repos/alpha/starts/check', body: { workflow: 'ticket-to-pr', source: 'FAKE-1', until: 'spec' } },
    ]);
    expect([cmdk(), toasts()]).toEqual(['', []]);
    expect([dialogTitle(), dialogLines(), dialogVerb()]).toEqual([
      'start a run of ticket-to-pr on FAKE-1',
      ['stops after spec'],
      'start',
    ]);
    expect(preText()).toBe(ROSTER);
    host.postAnswer = { status: 202, body: JSON.stringify({ runId: NEW_ID }) };
    host.press('Enter');
    await settle();
    host.advance(100);
    expect(host.posts.at(-1)).toEqual({
      path: '/api/repos/alpha/starts',
      body: { workflow: 'ticket-to-pr', source: 'FAKE-1', until: 'spec', key: 'FAKE-1' },
    });
    expect([page?.ui.runId, toasts()]).toEqual([NEW_ID, [`ok start a run…: started ${NEW_ID}`]]);
  });

  test('the chip keeps the run the menu opened on until the repository is chosen, then names that repository, and Escape brings the run back', async () => {
    bootStartable();
    host.point('hover', FAKE_3_ROW);
    cmdK();
    host.advance(100);
    const run = menuHead();
    expect(run).toContain('FAKE-3');
    typeIn('start a run');
    enter();
    expect([stepLabel(), menuHead()]).toEqual(['repository', run]);
    enter();
    expect([stepLabel(), menuHead()]).toEqual(['workflow', 'alpha']);
    enter();
    expect([stepLabel(), menuHead()]).toEqual(['ticket key or pull request', 'alpha']);
    host.press('Escape', true);
    host.press('Escape', true);
    host.advance(100);
    expect([stepLabel(), menuHead()]).toEqual(['repository', run]);
  });

  test('a refused start is a red toast with a start anyway button, the menu then lists it, and its dialog names the check it overrides', async () => {
    bootStartable();
    const line = 'sail FAKE-3: the ticket is not designated. --force runs it anyway';
    await ask('FAKE-3', '', {
      status: 409,
      body: { error: line, override: 'force', start: { source: 'FAKE-3', workflow: 'ticket-to-pr' } },
    });
    expect(toasts()).toEqual([`bad start a run… alpha: ${line}`]);
    expect(host.regions.toasts).toContain('>start anyway (--force)</button>');
    expect(host.dialog).toBeUndefined();
    cmdK();
    host.advance(100);
    typeIn('start FAKE-3');
    expect(menuLabels()).toEqual(['start FAKE-3 anyway (--force)']);
    host.postAnswer = {
      status: 200,
      body: JSON.stringify({
        roster: `${ROSTER}\n  forced    designation`,
        key: 'FAKE-3',
        forced: ['designation'],
        start: { source: 'FAKE-3', workflow: 'ticket-to-pr', force: true },
      }),
    };
    enter();
    await settle();
    host.advance(100);
    expect(host.posts.at(-1)).toEqual({
      path: '/api/repos/alpha/starts/check',
      body: { source: 'FAKE-3', workflow: 'ticket-to-pr', force: true },
    });
    expect([dialogTitle(), dialogLines()]).toEqual(['start FAKE-3 anyway', ['overrides: designation (--force)']]);
    host.postAnswer = { status: 202, body: JSON.stringify({ runId: NEW_ID }) };
    host.press('Enter');
    await settle();
    host.advance(100);
    expect(page?.ui.runId).toBe(NEW_ID);
    cmdK();
    host.advance(100);
    typeIn('start FAKE-3');
    expect(menuLabels()).toEqual([]);
  });

  test('the toast button posts the same check as the menu row', async () => {
    bootStartable();
    await ask('FAKE-3', '', {
      status: 409,
      body: {
        error: 'x. --force runs it anyway',
        override: 'force',
        start: { source: 'FAKE-3', workflow: 'ticket-to-pr' },
      },
    });
    const id = page?.ui.toasts.at(-1)?.id ?? 0;
    host.click({ action: 'undo-toast', toast: String(id) });
    expect(host.posts.at(-1)).toEqual({
      path: '/api/repos/alpha/starts/check',
      body: { source: 'FAKE-3', workflow: 'ticket-to-pr', force: true },
    });
  });
});

describe('a view opens with its first row selected (ADW-537)', () => {
  beforeEach(() => {
    host.narrowed = false;
  });
  /** The row the list draws selected. */
  const selectedRow = () => /class="[^"]*\bsel\b[^"]*" data-row="([^"]+)"/.exec(host.regions.list ?? '')?.[1];
  const pushes = () => host.urls.filter((write) => write.push).length;

  test('a boot with an empty URL opens the first row of Active, draws it selected and writes the URL once, as a replace', () => {
    page = boot(host);
    plainIndex();
    host.advance(100);
    expect([page.ui.repo, page.ui.runId]).toEqual(['beta', FAKE_3_ID]);
    expect(selectedRow()).toBe(`run:beta/${FAKE_3_ID}`);
    expect(host.regions.main).toContain(FAKE_3_ID);
    expect(host.regions.main).not.toContain('class="empty"');
    expect(host.urls).toEqual([{ query: `repo=beta&run=${FAKE_3_ID}`, push: false }]);
  });

  test('each of 1 to 4 and a click on a view open that view first row and push exactly one history entry', () => {
    page = boot(host);
    plainIndex();
    host.advance(100);
    for (const [key, view] of [
      ['1', 'inbox'],
      ['2', 'active'],
      ['3', 'queues'],
      ['4', 'history'],
    ] as const) {
      const before = pushes();
      host.press(key);
      host.advance(100);
      expect(page.ui.view).toBe(view);
      expect(pushes()).toBe(before + 1);
      expect(selectedRow()).toBeDefined();
      expect(host.regions.main).not.toContain('class="empty"');
    }
    expect([page.ui.repo, page.ui.runId]).not.toEqual([undefined, undefined]);
    host.click({ action: 'select-view', view: 'queues' });
    host.advance(100);
    expect(page.ui.queue).toBe('beta/ticket-to-pr');
    expect(selectedRow()).toBe('queue:beta/ticket-to-pr');
    host.click({ action: 'select-view', view: 'history' });
    host.advance(100);
    expect(page.ui.queue).toBeUndefined();
    expect(page.ui.runId).toBeDefined();
  });

  test('a URL that names a listed run opens that run, not the first row', () => {
    host.startAt = { repo: 'alpha', run: GOLDEN_RUN_ID };
    page = boot(host);
    plainIndex();
    host.advance(100);
    expect([page.ui.repo, page.ui.runId]).toEqual(['alpha', GOLDEN_RUN_ID]);
  });

  test('a URL that names a run the index does not list opens none and says so in a toast', () => {
    host.startAt = { repo: 'alpha', run: 'nope' };
    page = boot(host);
    plainIndex();
    host.advance(100);
    expect(page.ui.runId).toBeUndefined();
    expect(toasts().join('\n')).toContain('run nope of alpha is not listed');
    expect(host.regions.main).toContain('No run selected');
    expect(selectedRow()).toBeUndefined();
  });

  test('Escape from the open run shows the empty state with no row selected, and a later index selects nothing', () => {
    page = boot(host);
    plainIndex();
    host.advance(100);
    expect(page.ui.runId).toBe(FAKE_3_ID);
    host.press('Escape');
    host.advance(100);
    expect(host.regions.main).toContain('class="empty"');
    expect(host.regions.main).toContain('No run selected');
    expect(selectedRow()).toBeUndefined();
    plainIndex();
    host.advance(100);
    expect(page.ui.runId).toBeUndefined();
    expect(selectedRow()).toBeUndefined();
    expect(host.regions.main).toContain('No run selected');
  });

  test('Back to an entry that names nothing leaves no row selected, and a later index selects nothing', () => {
    page = boot(host);
    plainIndex();
    host.advance(100);
    expect(page.ui.runId).toBe(FAKE_3_ID);
    host.go('');
    host.advance(100);
    expect(page.ui.runId).toBeUndefined();
    expect(selectedRow()).toBeUndefined();
    plainIndex();
    host.advance(100);
    expect(page.ui.runId).toBeUndefined();
  });

  test('a window under 800px selects no first row, at boot or on a change of view', () => {
    host.narrowed = true;
    page = boot(host);
    plainIndex();
    host.advance(100);
    expect(page.ui.runId).toBeUndefined();
    host.press('4');
    host.advance(100);
    expect([page.ui.view, page.ui.runId, page.ui.queue]).toEqual(['history', undefined, undefined]);
    expect(selectedRow()).toBeUndefined();
  });
});

describe('a filter that drops the open row selects the first row left (ADW-537)', () => {
  const FAKE_1 = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';
  const FAKE_4 = 'FAKE-4-01M348XP801GH3GKJT2MNM2NR9';
  const pushes = () => host.urls.filter((write) => write.push).length;
  /** History, whose first row FAKE-1 is open, its rows FAKE-1, FAKE-2 (failed) and FAKE-4 (beta). */
  const onHistory = () => {
    host.narrowed = false;
    page = boot(host);
    plainIndex();
    host.press('4');
    host.advance(100);
    expect(page.ui.runId).toBe(FAKE_1);
    return page;
  };

  test('a text filter that hides the open run opens the first row shown and adds no history entry', () => {
    const open = onHistory();
    const before = pushes();
    host.type('list-filter', 'FAKE-4');
    host.advance(100);
    expect([open.ui.repo, open.ui.runId]).toEqual(['beta', FAKE_4]);
    expect(host.regions.list).toContain(`data-row="run:beta/${FAKE_4}"`);
    expect(pushes()).toBe(before);
    expect(host.urls.at(-1)).toEqual({ query: `repo=beta&run=${FAKE_4}&view=history&q=FAKE-4`, push: false });
  });

  test('a text filter that keeps the open run leaves it open and replaces the entry with the text (ADW-546)', () => {
    const open = onHistory();
    const writes = host.urls.length;
    host.type('list-filter', 'FAKE-1');
    host.advance(100);
    expect(open.ui.runId).toBe(FAKE_1);
    expect(host.urls.slice(writes)).toEqual([{ query: `repo=alpha&run=${FAKE_1}&view=history&q=FAKE-1`, push: false }]);
  });

  test('a filter that hides every row shows the empty state, and widening it opens the first row', () => {
    const open = onHistory();
    const before = pushes();
    host.type('list-filter', 'no such run');
    host.advance(100);
    expect(open.ui.runId).toBeUndefined();
    expect(host.regions.main).toContain('No run selected');
    host.type('list-filter', '');
    host.advance(100);
    expect(open.ui.runId).toBe(FAKE_1);
    expect(pushes()).toBe(before);
  });

  test("History's status control and the sidebar's repository filter do the same, a push for each choice (ADW-546)", () => {
    const open = onHistory();
    const before = pushes();
    host.type('list-status', 'failed');
    host.advance(100);
    expect(open.ui.runId).toBe(FAKE_2_ID);
    host.type('list-status', '');
    host.click({ action: 'filter-repo', repo: 'beta' });
    host.advance(100);
    expect([open.ui.repo, open.ui.runId]).toEqual(['beta', FAKE_4]);
    expect(pushes()).toBe(before + 3);
  });

  test("History's workflow control opens the first row of the workflow when the open run is of another", () => {
    const open = onHistory();
    const workflows = [...(host.regions.list ?? '').matchAll(/<option value="([^"]+)"/g)].map(([, value]) => value);
    const repos = listRepos(index(m.registryDir), host.clock);
    const ofRun = (runId: string) => repos.flatMap((repo) => repo.runs).find((run) => run.runId === runId)?.workflow;
    const other = [FAKE_2_ID, FAKE_4].find(
      (id) => ofRun(id)?.replace(/@\d+$/, '') !== ofRun(FAKE_1)?.replace(/@\d+$/, ''),
    );
    expect(other).toBeDefined();
    if (other === undefined) return;
    const workflow = (ofRun(other) ?? '').replace(/@\d+$/, '');
    expect(workflows).toContain(workflow);
    host.type('list-workflow', workflow);
    host.advance(100);
    expect(open.ui.runId).toBe(other);
  });

  test('after Escape no filter change opens a row', () => {
    const open = onHistory();
    host.press('Escape');
    host.advance(100);
    expect(open.ui.runId).toBeUndefined();
    host.type('list-filter', 'FAKE-4');
    host.advance(100);
    expect(open.ui.runId).toBeUndefined();
    host.type('list-status', 'failed');
    host.advance(100);
    expect(open.ui.runId).toBeUndefined();
    expect(host.regions.main).toContain('No run selected');
  });

  test('a run opened from elsewhere that the list never showed stays open when a filter changes', () => {
    const open = onHistory();
    host.click({ action: 'select-run', repo: 'beta', run: FAKE_3_ID });
    host.type('list-filter', 'FAKE-4');
    host.advance(100);
    expect(open.ui.runId).toBe(FAKE_3_ID);
  });
});

describe('the open row is scrolled into sight when it changes (ADW-537)', () => {
  beforeEach(() => {
    host.narrowed = false;
  });

  test('a run opened from the URL at load is revealed in the list once', () => {
    host.startAt = { repo: 'alpha', run: GOLDEN_RUN_ID };
    page = boot(host);
    plainIndex();
    host.advance(100);
    expect(host.revealedOpen).toEqual(['list']);
  });

  test('a first row the shell selects on boot, and on a change of view, is revealed once each', () => {
    page = boot(host);
    plainIndex();
    host.advance(100);
    expect(host.revealedOpen).toEqual(['list']);
    host.press('4');
    host.advance(100);
    expect(host.revealedOpen).toEqual(['list', 'list']);
  });

  test('a filter that opens another row reveals it', () => {
    page = boot(host);
    plainIndex();
    host.press('4');
    host.advance(100);
    host.revealedOpen = [];
    host.type('list-filter', 'FAKE-4');
    host.advance(100);
    expect(host.revealedOpen).toEqual(['list']);
  });

  test('a tick and an index refresh scroll nothing', () => {
    page = boot(host);
    plainIndex();
    host.advance(100);
    host.revealedOpen = [];
    host.advance(5000);
    plainIndex();
    host.advance(100);
    host.press('j');
    expect(host.revealedOpen).toEqual([]);
  });

  test('a list whose markup did not change keeps the reveal for the next write', () => {
    host.narrowed = true;
    page = boot(host);
    plainIndex();
    host.advance(100);
    page.store.revealOpen = true;
    page.store.mark('list');
    host.advance(100);
    expect(host.revealedOpen).toEqual([]);
    expect(page.store.revealOpen).toBe(true);
    page.ui.listFilter = 'FAKE';
    page.store.mark('list');
    host.advance(100);
    expect(host.revealedOpen).toEqual(['list']);
    expect(page.store.revealOpen).toBe(false);
  });
});

describe('the keyed pane: w gives the keys to the list or the open run beside it (ADW-535)', () => {
  const FAKE_1 = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';
  const FAKE_4 = 'FAKE-4-01M348XP801GH3GKJT2MNM2NR9';
  const FAKE_2_ROW = `run:alpha/${FAKE_2_ID}`;
  /** History from 800px up, its first row FAKE-1 opened unasked: entries 09-25, FAKE-1, 09-23, FAKE-2, 09-22, FAKE-4. */
  const onHistory = () => {
    host.narrowed = false;
    page = boot(host);
    plainIndex();
    host.press('4');
    host.advance(100);
    expect(page.ui.runId).toBe(FAKE_1);
    // The list's cursor is on the row the view opened with (ADW-543).
    expect(page.ui.listCursor).toBe(`run:alpha/${FAKE_1}`);
    return page;
  };
  /** Walks the list's cursor from FAKE-1 onto FAKE-2 and opens it with Enter, its cards replayed. */
  const openFake2 = () => {
    for (let i = 0; i < 2; i++) host.press('j');
    host.press('Enter');
    replay(host.open('run=').at(-1), fake2Dir(m));
    host.advance(100);
  };

  test('a view opened with its first row unasked starts with the keys in the list: j walks it and leaves the open run alone', () => {
    const p = onHistory();
    expect(p.ui.pane).toBe('list');
    expect(host.keyPanes.at(-1)).toBe('list');
    expect(p.ui.listCursor).toBe(`run:alpha/${FAKE_1}`);
    host.press('j');
    host.press('ArrowDown');
    expect(p.ui.listCursor).toBe(FAKE_2_ROW);
    expect([p.ui.runId, p.ui.cursor]).toEqual([FAKE_1, 0]);
  });

  test('Enter in the list opens the row under the cursor and gives the centre the keys; Enter on a group folds it and keeps them', () => {
    const p = onHistory();
    host.press('k');
    host.press('Enter');
    expect(p.ui.listFolded).toEqual(['history:2026-09-25']);
    expect(p.ui.pane).toBe('list');
    host.press('Enter');
    host.press('j');
    host.press('j');
    host.press('j');
    host.press('Enter');
    expect([p.ui.runId, p.ui.pane]).toEqual([FAKE_2_ID, 'centre']);
    host.advance(100);
    expect(host.keyPanes.at(-1)).toBe('centre');
  });

  test('Enter or a click on the row open already gives the centre the keys, and the host is told', () => {
    const p = onHistory();
    host.press('Enter');
    host.advance(100);
    expect([p.ui.runId, host.keyPanes.at(-1)]).toEqual([FAKE_1, 'centre']);
    host.press('w');
    host.advance(100);
    expect(host.keyPanes.at(-1)).toBe('list');
    host.click({ action: 'select-run', repo: 'alpha', run: FAKE_1 });
    host.advance(100);
    expect([p.ui.runId, host.keyPanes.at(-1)]).toEqual([FAKE_1, 'centre']);
  });

  test('j and k move only the pane that has the keys, w switches it, and each cursor keeps its place', () => {
    const p = onHistory();
    openFake2();
    host.press('j');
    host.press('j');
    expect([p.ui.cursor, p.ui.listCursor]).toEqual([2, FAKE_2_ROW]);
    host.press('w');
    expect(p.ui.pane).toBe('list');
    host.advance(100);
    expect(host.keyPanes.at(-1)).toBe('list');
    host.press('j');
    expect([p.ui.cursor, p.ui.listCursor]).toEqual([2, 'history:2026-09-22']);
    expect(p.ui.runId).toBe(FAKE_2_ID);
    host.press('w');
    host.advance(100);
    host.press('k');
    expect([p.ui.cursor, p.ui.listCursor]).toEqual([1, 'history:2026-09-22']);
    host.press('w');
    host.advance(100);
    host.press('k');
    expect([p.ui.cursor, p.ui.listCursor]).toEqual([1, FAKE_2_ROW]);
    expect(host.keyPanes).toEqual(['list', 'centre', 'list', 'centre', 'list']);
  });

  test('Enter with the keys in the centre opens the card under its cursor, as before', () => {
    const p = onHistory();
    openFake2();
    host.press('j');
    host.press('Enter');
    expect([p.ui.key, p.ui.timeline]).toEqual([cards(host.regions.main)[1], true]);
    expect(p.ui.runId).toBe(FAKE_2_ID);
  });

  test("the command menu's subject follows the keys: the row under the list's cursor, or the open run", () => {
    const p = onHistory();
    openFake2();
    host.press('w');
    host.press('j');
    host.press('j');
    expect(p.ui.listCursor).toBe(`run:beta/${FAKE_4}`);
    expect(focused(p.ui)).toEqual({ kind: 'run', repo: 'beta', runId: FAKE_4 });
    host.press('w');
    expect(focused(p.ui)).toEqual({ kind: 'run', repo: 'alpha', runId: FAKE_2_ID });
    host.press('w');
    expect(focused(p.ui)).toEqual({ kind: 'run', repo: 'beta', runId: FAKE_4 });
  });

  test('a press in a pane gives it the keys, one that opens a row gives them to the centre, and one elsewhere changes nothing', () => {
    const p = onHistory();
    host.pressIn('main');
    expect(p.ui.pane).toBe('centre');
    host.pressIn('sidebar');
    host.pressIn(undefined);
    expect(p.ui.pane).toBe('centre');
    host.pressIn('list');
    expect(p.ui.pane).toBe('list');
    host.pressIn('list');
    host.advance(100);
    expect(host.keyPanes.at(-1)).toBe('list');
    host.click({ action: 'select-run', repo: 'alpha', run: FAKE_2_ID });
    expect(p.ui.pane).toBe('centre');
    host.pressIn('list');
    host.click({ action: 'run-menu', repo: 'beta', run: FAKE_4 });
    expect([p.ui.runId, p.ui.pane]).toEqual([FAKE_4, 'list']);
    host.click({ action: 'select-queue', queue: `beta/${QUEUE_WORKFLOW}` });
    expect(p.ui.pane).toBe('centre');
  });

  test('a change of view gives the list the keys again', () => {
    const p = onHistory();
    openFake2();
    expect(p.ui.pane).toBe('centre');
    host.press('2');
    expect(p.ui.pane).toBe('list');
    host.pressIn('main');
    host.click({ action: 'select-view', view: 'history' });
    expect(p.ui.pane).toBe('list');
  });

  test('Escape steps back as before whichever pane has the keys, and with nothing open the list alone takes them', () => {
    const p = onHistory();
    openFake2();
    host.click({ action: 'select-card', key: cards(host.regions.main)[1] ?? '' });
    host.press('w');
    host.press('Escape');
    expect([p.ui.timeline, p.ui.key, p.ui.runId]).toEqual([false, 'spec#1', FAKE_2_ID]);
    host.press('Escape');
    expect([p.ui.key, p.ui.runId]).toEqual([undefined, FAKE_2_ID]);
    host.press('Escape');
    host.advance(100);
    expect([p.ui.runId, host.keyPanes.at(-1)]).toEqual([undefined, 'none']);
    host.press('w');
    host.press('j');
    expect(p.ui.listCursor).toBe('history:2026-09-22');
    host.press('j');
    host.press('Enter');
    expect([p.ui.runId, p.ui.pane]).toEqual([FAKE_4, 'centre']);
  });

  test('x marks the History run under the cursor with the keys in the list, and not with them in the centre', () => {
    const p = onHistory();
    openFake2();
    host.press('x');
    expect(p.ui.listSelected).toEqual([]);
    host.press('w');
    host.press('x');
    expect(p.ui.listSelected).toEqual([FAKE_2_ROW]);
  });

  test('a key typed in an input does nothing: w switches no pane and j moves no cursor', () => {
    const p = onHistory();
    host.press('w', true);
    host.press('j', true);
    expect([p.ui.pane, p.ui.listCursor]).toEqual(['list', `run:alpha/${FAKE_1}`]);
  });

  test('under 800px the keys drive what shows, w does nothing and shuts no sidebar, and the host marks no pane', () => {
    const p = onHistory();
    host.narrowed = true;
    host.press('Escape');
    host.press('j');
    expect(p.ui.listCursor).toBe('history:2026-09-23');
    host.press('j');
    host.press('Enter');
    replay(host.open('run=').at(-1), fake2Dir(m));
    p.ui.pane = 'list';
    host.press('j');
    expect([p.ui.cursor, p.ui.listCursor]).toEqual([1, FAKE_2_ROW]);
    host.press('w');
    expect(p.ui.pane).toBe('list');
    host.press('j');
    expect(p.ui.cursor).toBe(2);
    host.click({ action: 'toggle-sidebar' });
    host.press('w');
    expect(host.sidebars.at(-1)).toBe(true);
    host.advance(100);
    expect(host.keyPanes.at(-1)).toBe('none');
  });
});

describe('a key for every action, and the shortcut sheet (ADW-523)', () => {
  const sheet = () => host.regions.menu ?? '';
  /** Lets go of every source of the focus, as a page with nothing hovered, under the cursor or open has. */
  const unfocus = () => {
    if (page !== undefined) page.store.ui.focus = { seq: page.store.ui.focus.seq };
  };
  const press = (key: string, inInput = false, mod = false) => {
    const handled = host.press(key, inInput, undefined, mod);
    host.advance(100);
    return handled;
  };

  test('? opens the sheet in the command menu’s place, grouped, with the boxed keys; ?, Escape and a click outside close it, and meanwhile no other key does anything', () => {
    bootIndexed();
    press('?');
    expect(sheet()).toContain(
      '<div class="cmdk keys" role="dialog" aria-modal="true" aria-label="keyboard shortcuts" tabindex="-1">',
    );
    expect([...sheet().matchAll(/<div class="cmdk-grp">([^<]*)<\/div>/g)].map(([, group]) => group)).toEqual([
      'Global',
      'List',
      'Run',
      'Queue item',
      'Inbox',
    ]);
    expect(sheet()).toContain(
      '<span class="keys-t">stop now</span><span class="keys-ks"><span class="keys-k"><kbd>⇧S</kbd>',
    );
    expect(sheet()).toContain('<kbd>G</kbd><span class="keys-then">then</span><kbd>Q</kbd>');
    expect(sheet()).toContain(
      '<span class="keys-t">move to the top</span><span class="keys-ks"><span class="keys-k"><kbd>⇧T</kbd>',
    );
    expect(sheet()).toContain(
      '<span class="keys-t">move up</span><span class="keys-ks"><span class="keys-k"><kbd>⌥↑</kbd>',
    );
    expect(host.menuFocuses).toBe(1);
    const view = page?.ui.view;
    press('3');
    press('/');
    expect([page?.ui.view, host.focused]).toEqual([view, []]);
    press('?');
    expect(sheet()).toBe('');
    press('?');
    press('Escape');
    expect(sheet()).toBe('');
    press('?');
    host.click({ action: 'close-sheet' });
    host.advance(100);
    expect(sheet()).toBe('');
  });

  test('Cmd+K from the sheet closes it and opens the command menu, whose rows show their keys', async () => {
    settleQueue();
    bootIndexed();
    press('?');
    host.point('hover', FAKE_3_ROW);
    expect(press('k', false, true)).toBe(true);
    await settle();
    host.advance(100);
    expect(page?.ui.sheet).toBe(false);
    expect(cmdk()).toContain('<span class="cmdk-label">stop</span><kbd>S</kbd>');
    expect(cmdk()).toContain('<span class="cmdk-label">stop now</span><kbd>⇧S</kbd>');
    expect(cmdk()).toContain('<span class="cmdk-label">resume</span><kbd>R</kbd>');
  });

  test('on a suspended run r opens Resume’s dialog asking the raise, as its button does, and Escape cancels it with nothing posted', async () => {
    settleQueue();
    await openRun('beta', FAKE_3_ID, m.beta.runDir);
    expect(press('r')).toBe(true);
    expect(dialogTitle()).toBe(`resume FAKE-3`);
    expect(host.dialog).toContain('name="raise"');
    press('Escape');
    expect([host.dialog, host.posts]).toEqual([undefined, []]);
  });

  test('on a running run s opens Stop’s dialog and Shift+S Stop now’s; Escape cancels each with nothing posted, and Enter confirms', async () => {
    holdLive();
    await openRun('beta', FAKE_3_ID, m.beta.runDir);
    press('s');
    expect(dialogTitle()).toBe(`stop FAKE-3`);
    press('Escape');
    press('S');
    expect(dialogTitle()).toBe(`stop FAKE-3 now`);
    press('Escape');
    expect([host.dialog, host.posts]).toEqual([undefined, []]);
    press('s');
    press('Enter');
    expect(host.posts).toEqual([{ path: `${FAKE_3_PATH}/stop`, body: { now: false } }]);
  });

  test('on a failed run Shift+R opens Restart’s dialog and Backspace Clean’s; Backspace in a field does nothing', async () => {
    await openRun('alpha', FAKE_2_ID, fake2Dir(m));
    press('R');
    expect(dialogTitle()).toBe(`restart FAKE-2`);
    press('Escape');
    expect(press('Backspace', true)).toBe(false);
    expect(host.dialog).toBeUndefined();
    expect(press('Backspace')).toBe(true);
    expect(dialogTitle()).toBe(`clean FAKE-2`);
    press('Escape');
    expect(host.posts).toEqual([]);
  });

  test('a key whose action is unavailable says why in a red toast and posts nothing: not offered, or nothing it applies to', async () => {
    await openRun('alpha', FAKE_2_ID, fake2Dir(m));
    press('s');
    expect(toasts()).toEqual([`hint stop ${FAKE_2_ID}: isn't offered while the run is failed`]);
    press('Escape');
    press('Escape');
    expect(page?.store.run).toBeUndefined();
    host.point('hover', undefined);
    unfocus();
    press('r');
    expect(toasts().at(-1)).toBe(
      "hint resume or requeue (R): resume needs a run: open one, or put the list's cursor on one; requeue needs a queue item: point at one, or open its ⋯",
    );
    press('p');
    expect(toasts().at(-1)).toBe("hint poll (P): needs a queue: open one, or put the list's cursor on one");
    expect(host.posts).toEqual([]);
  });

  test('a disabled action’s key toasts its reason', async () => {
    await openRun('beta', FAKE_3_ID, m.beta.runDir);
    press('r');
    expect(host.dialog).toBeUndefined();
    expect(toasts().at(-1)).toMatch(new RegExp(`^hint resume ${FAKE_3_ID}: .+`));
  });

  test('the key of a run that is not open reads its offers first, then opens its dialog', async () => {
    settleQueue();
    bootIndexed();
    host.point('hover', FAKE_3_ROW);
    press('s');
    expect(host.dialog).toBeUndefined();
    await settle();
    host.advance(100);
    expect(dialogTitle()).toBe(`stop FAKE-3`);
    press('Escape');
    expect(host.posts).toEqual([]);
  });

  test('a run whose offers cannot be read says so', async () => {
    settleQueue();
    bootIndexed();
    host.point('hover', { subject: 'run', repo: 'nowhere', run: 'gone-1' });
    press('s');
    await settle();
    host.advance(100);
    expect(toasts().at(-1)).toBe("hint stop gone-1: its actions can't be read");
  });

  test('Shift+T moves a waiting item before the first one, and says so on the first', async () => {
    twoWaiting();
    openBetaQueue();
    host.point('hover', { ...ITEM_ROW, item: 'ticket:FAKE-7' });
    press('T');
    expect(host.posts).toEqual([
      { path: `${QUEUE_PATH}/move`, body: { dedupKey: 'ticket:FAKE-7', before: 'ticket:FAKE-5' } },
    ]);
    host.point('hover', ITEM_ROW);
    press('T');
    expect(host.posts.length).toBe(1);
    expect(toasts().at(-1)).toBe('hint move to the top ticket:FAKE-5: ticket:FAKE-5 has no move to the top');
  });

  test('on a queue item: r requeues, Backspace opens the drop dialog, Alt+Down and Alt+Up move it; on the queue p polls and c asks the ticket in the command menu', async () => {
    twoWaiting();
    openBetaQueue();
    host.point('hover', ITEM_6);
    press('r');
    expect(host.posts).toEqual([{ path: `${QUEUE_PATH}/requeue`, body: { dedupKey: 'ticket:FAKE-6' } }]);
    press('Backspace');
    expect(dialogTitle()).toBe('drop ticket:FAKE-6');
    press('Escape');
    host.point('hover', ITEM_ROW);
    press('Alt+ArrowDown');
    host.point('hover', { ...ITEM_ROW, item: 'ticket:FAKE-7' });
    press('Alt+ArrowUp');
    expect(host.posts.slice(1)).toEqual([
      { path: `${QUEUE_PATH}/move`, body: { dedupKey: 'ticket:FAKE-5', after: 'ticket:FAKE-7' } },
      { path: `${QUEUE_PATH}/move`, body: { dedupKey: 'ticket:FAKE-7', before: 'ticket:FAKE-5' } },
    ]);
    press('Alt+ArrowDown');
    expect(toasts().at(-1)).toBe('hint move down ticket:FAKE-7: ticket:FAKE-7 has no move down');
    host.point('hover', WORKFLOW_ROW);
    press('p');
    expect(host.posts.at(-1)).toEqual({ path: `${QUEUE_PATH}/poll`, body: {} });
    press('c');
    expect(stepLabel()).toBe('Ticket key');
    expect(cmdk()).toContain(`beta › ${QUEUE_WORKFLOW}`);
  });

  test('an open item menu makes its item the subject', () => {
    openBetaQueue();
    host.click({ action: 'item-menu', item: 'ticket:FAKE-6' });
    press('r');
    expect(host.posts).toEqual([{ path: `${QUEUE_PATH}/requeue`, body: { dedupKey: 'ticket:FAKE-6' } }]);
  });

  test('g then i, a, q or h opens Inbox, Active, Queues and History beside 1 to 4; g then another key is that key', () => {
    bootIndexed();
    const views: string[] = [];
    for (const key of ['i', 'a', 'q', 'h']) {
      press('g');
      press(key);
      views.push(page?.ui.view ?? '');
    }
    expect(views).toEqual(['inbox', 'active', 'queues', 'history']);
    expect(page?.ui.pinned).toBe(false);
    press('g');
    press('i');
    press('g');
    press('2');
    expect([page?.ui.view, page?.ui.pinned, page?.ui.chord]).toEqual(['active', false, undefined]);
  });

  test('Cmd+. copies the focused subject’s id, and nothing in a field or with nothing focused', async () => {
    await openRun('beta', FAKE_3_ID, m.beta.runDir);
    expect(press('.', false, true)).toBe(true);
    await settle();
    expect(host.copied).toEqual([FAKE_3_ID]);
    expect(press('.', true, true)).toBe(false);
    unfocus();
    press('Escape');
    press('Escape');
    unfocus();
    press('.', false, true);
    expect(host.copied).toEqual([FAKE_3_ID]);
    expect(toasts().at(-1)).toBe('hint copy (⌘.): needs a focused run, queue or queue item');
  });

  test('o opens the open run’s pull request, else says it has none; l and f open its call’s log and files', async () => {
    const events = join(m.alpha.runDir, 'events.ndjson');
    writeFileSync(
      events,
      readFileSync(events, 'utf8').replaceAll('fake://codehost/fixture/pull/5', 'https://code.test/pull/5'),
    );
    await openRun('alpha', GOLDEN_RUN_ID, m.alpha.runDir);
    press('o');
    expect(host.links).toEqual(['https://code.test/pull/5']);
    press('l');
    expect([page?.ui.tab, page?.ui.key]).toEqual(['log', page?.store.run?.model.cards[0]?.key]);
    press('f');
    expect(page?.ui.tab).toBe('files');
    page?.stop();
    host = new FakeHost(m);
    await openRun('beta', FAKE_3_ID, m.beta.runDir);
    press('o');
    expect(toasts().at(-1)).toBe(`hint open (O): ${FAKE_3_ID} has no pull request or ticket link`);
    press('Escape');
    press('Escape');
    press('o');
    expect(toasts().at(-1)).toBe('hint open (O): needs an open run');
    press('l');
    // A hint replaces the one before it.
    expect(toasts().filter((each) => each.startsWith('hint'))).toEqual(['hint log (L): needs an open run with a call']);
  });

  test('z undoes what the newest toast with an Undo did, and says so when none has one', () => {
    page = boot(host);
    firstIndex();
    host.click({ action: 'select-view', view: 'inbox' });
    host.advance(100);
    press('z');
    expect(toasts().at(-1)).toBe('hint undo (Z): finds no toast with an undo');
    const before = page.store.cleared.size;
    press('E');
    expect(page.store.cleared.size).toBeGreaterThan(before);
    press('z');
    expect(page.store.cleared.size).toBe(before);
  });
});

describe("the list's filters are in the URL (ADW-546)", () => {
  const FAKE_1 = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';
  const FAKE_4 = 'FAKE-4-01M348XP801GH3GKJT2MNM2NR9';
  const rows = () => [...(host.regions.list ?? '').matchAll(/data-row="run:([^"]+)"/g)].map(([, row]) => row ?? '');
  const boots = (startAt: Record<string, string>) => {
    host.narrowed = false;
    host.startAt = startAt;
    page = boot(host);
    plainIndex();
    host.advance(100);
    return page;
  };

  test('booted with the filters in the URL, the list is narrowed by them and the field and controls show them (ADW-546)', () => {
    const open = boots({ view: 'history', in: 'alpha', q: 'fake-2', status: 'failed' });
    expect([open.ui.view, open.ui.repoFilter, open.ui.listFilter, open.ui.historyStatus]).toEqual([
      'history',
      'alpha',
      'fake-2',
      'failed',
    ]);
    expect(host.regions.list).toContain('value="fake-2"');
    expect(rows()).toEqual([`alpha/${FAKE_2_ID}`]);
    expect(open.ui.runId).toBe(FAKE_2_ID);
    expect(host.freshes).toContain('list');
  });

  test('a run the URL names opens though the restored filters hide its row (ADW-546)', () => {
    const open = boots({ repo: 'beta', run: FAKE_4, view: 'history', in: 'alpha' });
    expect([open.ui.repo, open.ui.runId]).toEqual(['beta', FAKE_4]);
    expect(rows().some((row) => row.startsWith('beta/'))).toBe(false);
  });

  test('a repository or workflow the index does not list is dropped from the URL with a replace and no toast (ADW-546)', () => {
    const open = boots({ view: 'history', in: 'gone', workflow: 'no-such' });
    expect([open.ui.repoFilter, open.ui.historyWorkflow]).toEqual([undefined, undefined]);
    const last = host.urls.at(-1);
    expect(last?.push).toBe(false);
    expect(last?.query).not.toContain('in=');
    expect(last?.query).not.toContain('workflow=');
    expect(last?.query).toContain('view=history');
    expect(toasts()).toEqual([]);
  });

  test('Back and Forward restore the filters of their entry (ADW-546)', () => {
    const open = boots({ view: 'history' });
    host.go('view=history&status=failed');
    host.advance(100);
    expect(open.ui.historyStatus).toBe('failed');
    expect(rows()).toEqual([`alpha/${FAKE_2_ID}`]);
    host.go('view=history&in=beta&q=fake');
    expect([open.ui.historyStatus, open.ui.repoFilter, open.ui.listFilter]).toEqual([undefined, 'beta', 'fake']);
    host.go('view=history');
    expect([open.ui.repoFilter, open.ui.listFilter]).toEqual([undefined, '']);
    host.go('view=active&status=failed');
    expect(open.ui.historyStatus).toBeUndefined();
  });

  test('a Back between two entries that differ only in the call leaves the field alone (ADW-546)', () => {
    const open = boots({ repo: 'alpha', run: FAKE_1, view: 'history', q: 'fake' });
    host.freshes.length = 0;
    host.go(`repo=alpha&run=${FAKE_1}&view=history&q=fake&key=implement%231`);
    expect(open.ui.listFilter).toBe('fake');
    expect(host.freshes).not.toContain('list');
  });

  test('text typed before the first index is kept and written with it (ADW-546)', () => {
    host.narrowed = false;
    page = boot(host);
    host.type('list-filter', 'FAKE-4');
    plainIndex();
    host.advance(100);
    expect(page.ui.listFilter).toBe('FAKE-4');
    expect(host.urls[0]?.query).toContain('q=FAKE-4');
  });

  const pushesNow = () => host.urls.filter((write) => write.push).length;
  const onHistory = () => {
    const open = boots({ view: 'history' });
    expect(open.ui.runId).toBe(FAKE_1);
    return open;
  };

  test('typing in the filter replaces the history entry and pushes none (ADW-546)', () => {
    const open = onHistory();
    const before = pushesNow();
    for (const text of ['F', 'FA', 'FAKE-1']) host.type('list-filter', text);
    host.advance(100);
    expect(pushesNow()).toBe(before);
    expect(open.ui.runId).toBe(FAKE_1);
    expect(host.urls.at(-1)).toEqual({ query: `repo=alpha&run=${FAKE_1}&view=history&q=FAKE-1`, push: false });
  });

  test('a chosen repository, status or workflow pushes one entry, and Back restores the entry before (ADW-546)', () => {
    const open = onHistory();
    const before = host.urls.length;
    host.type('list-status', 'failed');
    host.advance(100);
    expect(host.urls.slice(before)).toEqual([
      { query: `repo=alpha&run=${FAKE_2_ID}&view=history&status=failed`, push: true },
    ]);
    host.go(`repo=alpha&run=${FAKE_1}&view=history`);
    host.advance(100);
    expect([open.ui.historyStatus, open.ui.runId]).toEqual([undefined, FAKE_1]);
    const mark = host.urls.length;
    host.click({ action: 'filter-repo', repo: 'beta' });
    host.advance(100);
    expect(host.urls.slice(mark).map((write) => write.push)).toEqual([true]);
    expect(host.urls.at(-1)?.query).toContain('in=beta');
    const next = host.urls.length;
    host.type('list-workflow', 'ticket-to-pr');
    host.advance(100);
    expect(host.urls.slice(next).map((write) => write.push)).toEqual([true]);
    expect(host.urls.at(-1)?.query).toContain('workflow=ticket-to-pr');
  });

  test("History's status failed keeps an open failed run (ADW-546)", () => {
    const open = boots({ repo: 'alpha', run: FAKE_2_ID, view: 'history' });
    const sockets = host.open('run=').length;
    host.type('list-status', 'failed');
    host.advance(100);
    expect(open.ui.runId).toBe(FAKE_2_ID);
    expect(host.open('run=').length).toBe(sockets);
    expect(host.urls.at(-1)).toEqual({ query: `repo=alpha&run=${FAKE_2_ID}&view=history&status=failed`, push: true });
  });

  test("a text filter that still lists the open queue's row keeps the queue open (ADW-546)", () => {
    const open = boots({ view: 'queues' });
    const queue = open.ui.queue;
    expect(queue).toBeDefined();
    host.type('list-filter', 'ticket');
    host.advance(100);
    expect(open.ui.queue).toBe(queue);
  });
});
