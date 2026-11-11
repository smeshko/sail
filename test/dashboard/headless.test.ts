// The real page, booted headless against a real dashboard (D3): the test fetches `GET /` from a server over the seeded
// fixtures, takes the inlined bundle and runs it against a fake document whose regions are `index.html`'s ids. Its
// fetch and WebSocket are Bun's own, aimed at the server, so the real bundle, server and streams are exercised, and
// only the DOM is fake.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserWindow, ElementLike, EventLike } from '../../src/dashboard/page/host';
import { type Dashboard, startDashboard } from '../../src/dashboard/server';
import {
  betaWatcher,
  FAKE_2_ID,
  fakeClonePorts,
  GOLDEN_RUN_ID,
  type Machine,
  seedFixtures,
} from '../helpers/dashboard';

let m: Machine | undefined;
let server: Dashboard | undefined;
let stopPage: (() => void) | undefined;
afterEach(async () => {
  stopPage?.();
  await server?.stop();
  m?.remove();
  [m, server, stopPage] = [undefined, undefined, undefined];
});

/** Waits until `condition` holds, polling every 20 ms, for at most `ms`. Returns whether it held. */
async function until(condition: () => boolean, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await Bun.sleep(20);
  }
  return true;
}

/** Boots the bundle `GET /` serves against a fake window on `dashboard`. Its regions, and a click. */
async function bootHeadless(dashboard: Dashboard, search = '') {
  const html = await (await fetch(dashboard.url)).text();
  const script = /<script type="module" id="sail-page">([\s\S]*)<\/script>/.exec(html)?.[1] ?? '';
  const ids = [...html.replace(/<script[\s\S]*<\/script>/, '').matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id ?? '');
  const regions = Object.fromEntries(
    ids.map((id): [string, ElementLike] => [
      id,
      { innerHTML: '', dataset: {}, parentElement: null, style: { setProperty() {} } },
    ]),
  );
  const listeners: Record<string, ((event: EventLike) => void)[]> = {};
  const origin = `http://127.0.0.1:${dashboard.port}`;
  const sockets: WebSocket[] = [];
  const history: { kind: string; data: unknown; unused: string; url: string }[] = [];
  const posted: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const win: BrowserWindow = {
    document: {
      getElementById: (id) => regions[id] ?? null,
      addEventListener: (type, listener) => {
        listeners[type] = [...(listeners[type] ?? []), listener];
      },
      removeEventListener() {},
      documentElement: { dataset: {} },
    },
    location: { host: `127.0.0.1:${dashboard.port}`, search, pathname: '/', href: `http://127.0.0.1/${search}` },
    addEventListener() {},
    history: {
      pushState: (data, unused, url) => history.push({ kind: 'push', data, unused, url }),
      replaceState: (data, unused, url) => history.push({ kind: 'replace', data, unused, url }),
    },
    fetch: (path, init) => {
      if (init.method === 'POST') posted.push(path);
      return fetch(`${origin}${path}`, init);
    },
    // Bun's own WebSocket, with the Origin a browser would send.
    WebSocket: class extends WebSocket {
      constructor(url: string) {
        super(url, { headers: { Origin: origin } } as unknown as string[]);
        sockets.push(this);
      }
    } as unknown as BrowserWindow['WebSocket'],
    localStorage: { getItem: () => null, setItem() {} },
    navigator: {},
    setTimeout: (fn, ms) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        fn();
      }, ms);
      timers.add(timer);
      return timer as unknown as number;
    },
    clearTimeout: (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
    Date,
  };
  new Function('window', script)(win);
  stopPage = () => {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.close();
  };
  const text = (id: string) => regions[id]?.innerHTML ?? '';
  const click = (dataset: Record<string, string>) => {
    for (const listener of listeners.click ?? []) {
      listener({ target: { innerHTML: '', dataset, parentElement: null } satisfies ElementLike });
    }
  };
  /** A key with Cmd or Ctrl held when `mod`, on the page's body. */
  const press = (key: string, mod = false) => {
    for (const listener of listeners.keydown ?? []) {
      listener({
        key,
        metaKey: mod,
        target: { innerHTML: '', dataset: {}, parentElement: null, tagName: 'BODY' } satisfies ElementLike,
      });
    }
  };
  /** Types `value` into the field `name`. */
  const type = (name: string, value: string) => {
    for (const listener of listeners.input ?? []) {
      listener({ target: { innerHTML: '', dataset: {}, parentElement: null, name, value } satisfies ElementLike });
    }
  };
  return { ids, text, click, press, type, history, posted };
}

test("the real bundle boots headless: both repositories, the golden run's eight cards and its $1.35 once its row is clicked, then FAKE-2's denial on the permissions tab", async () => {
  m = seedFixtures();
  const started = startDashboard({ registryDir: m.registryDir, port: 0, followPollMs: 20, indexPollMs: 50 });
  if ('refused' in started) throw new Error(started.refused);
  server = started;
  const page = await bootHeadless(server);
  expect(page.ids).toEqual(expect.arrayContaining(['sidebar', 'list', 'link', 'main', 'inspector', 'status']));
  expect(page.ids).not.toContain('queues');
  expect(await until(() => page.text('sidebar').includes('<span class="nm">beta</span>'))).toBe(true);
  expect(page.text('sidebar')).toContain('<span class="nm">alpha</span>');
  // The page opens on Active with its first row, FAKE-3 (suspended), selected in the list and open in the centre.
  expect(await until(() => page.text('main').includes('FAKE-3-01M39H4ZW0S46MV303CFX3T4PY'))).toBe(true);
  expect(page.text('main')).not.toContain('No run selected');
  expect(page.text('list')).toMatch(/class="run lrow sel cur"/);
  page.click({ action: 'select-view', view: 'history' });
  expect(await until(() => page.text('list').includes(`data-run="${GOLDEN_RUN_ID}"`))).toBe(true);
  page.click({ action: 'select-run', repo: 'alpha', run: GOLDEN_RUN_ID });
  expect(await until(() => (page.text('main').match(/data-action="select-card"/g) ?? []).length === 8)).toBe(true);
  expect(page.text('main')).toContain('<div class="stat"><b>$1.35</b><span>of $25.00 (5.4%)</span></div>');
  expect(page.text('sidebar')).toMatch(
    /data-view="inbox"[^>]*><span class="nm">Inbox<\/span><span class="c">3<\/span>/,
  );
  expect(page.text('link')).toContain('data-action="copy-link"');
  page.click({ action: 'select-view', view: 'queues' });
  page.click({ action: 'select-queue', queue: 'beta/ticket-to-pr' });
  expect(page.history.filter((entry) => entry.kind === 'push').map((entry) => entry.url)).toContain(
    '?queue=beta%2Fticket-to-pr&view=queues',
  );
  expect(await until(() => page.text('main').includes('<span class="pill p-skip">watcher not running</span>'))).toBe(
    true,
  );
  expect(page.text('main')).toContain('<button class="btn" disabled');
  expect(page.text('list')).toContain('watcher not running');
  expect(page.text('status')).toBe('');
  page.click({ action: 'open', repo: 'alpha', run: FAKE_2_ID, key: 'implement#1', tab: 'permissions' });
  expect(await until(() => page.text('status').includes('calls <b>'))).toBe(true);
  expect(await until(() => page.text('inspector').includes('<code>git push --force origin HEAD</code>'))).toBe(true);
  expect(page.text('inspector')).toContain('<dt>rule</dt><dd>commands</dd>');
  expect(page.text('main')).toContain(`<span class="d-agent">${FAKE_2_ID} · ticket-to-pr@1</span>`);
}, 30_000);

test("once beta's queue/ is gone, the next index drops its queue row and gives the centre back to the list", async () => {
  m = seedFixtures();
  const started = startDashboard({ registryDir: m.registryDir, port: 0, followPollMs: 20, indexPollMs: 50 });
  if ('refused' in started) throw new Error(started.refused);
  server = started;
  const page = await bootHeadless(server);
  page.click({ action: 'select-view', view: 'queues' });
  expect(await until(() => page.text('list').includes('data-action="select-queue"'))).toBe(true);
  page.click({ action: 'select-queue', queue: 'beta/ticket-to-pr' });
  expect(await until(() => page.text('main').includes('beta / ticket-to-pr'))).toBe(true);
  rmSync(join(m.beta.clone, '.sail-runs', 'queue'), { recursive: true });
  expect(await until(() => !page.text('list').includes('select-queue'))).toBe(true);
  expect(await until(() => page.text('main').includes('No queue selected'))).toBe(true);
  expect(page.text('sidebar')).toContain('<span class="nm">beta</span>');
}, 30_000);

test('the real bundle opens the view the URL names, and writes the view it is changed to, with the first row of that view (ADW-522)', async () => {
  m = seedFixtures();
  const started = startDashboard({ registryDir: m.registryDir, port: 0, followPollMs: 20, indexPollMs: 50 });
  if ('refused' in started) throw new Error(started.refused);
  server = started;
  const page = await bootHeadless(server, '?view=history');
  expect(await until(() => page.text('list').includes('<span class="lh-t">History</span>'))).toBe(true);
  page.click({ action: 'select-view', view: 'queues' });
  expect(await until(() => page.text('list').includes('<span class="lh-t">Queues</span>'))).toBe(true);
  expect(page.history.at(-1)).toEqual({
    kind: 'push',
    data: null,
    unused: '',
    url: '?queue=beta%2Fticket-to-pr&view=queues',
  });
}, 30_000);

test("a beta queue that can't be read is listed in the Queues view with its problem, and its row opens a queue view that shows it", async () => {
  m = seedFixtures();
  const broken = join(m.beta.clone, '.sail-runs', 'queue', 'broken');
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, 'queue.json'), '{');
  const started = startDashboard({ registryDir: m.registryDir, port: 0, followPollMs: 20, indexPollMs: 50 });
  if ('refused' in started) throw new Error(started.refused);
  server = started;
  const page = await bootHeadless(server);
  expect(await until(() => page.text('sidebar').includes('<span class="nm">beta</span>'))).toBe(true);
  page.click({ action: 'select-view', view: 'queues' });
  expect(await until(() => page.text('list').includes('beta › broken'))).toBe(true);
  expect(page.text('list')).toContain('<span class="n">unreadable</span>');
  page.click({ action: 'select-queue', queue: 'beta/broken' });
  expect(await until(() => page.text('main').includes('broken queue'))).toBe(true);
  expect(page.text('main')).toContain('queue.json can&#39;t be read');
}, 30_000);

test('instant tier: on the real bundle and server, a move the watcher refuses draws a red toast quoting the refusal, with no dialog', async () => {
  m = seedFixtures();
  betaWatcher(m, { pid: process.pid, sailDir: m.beta.sailDir });
  const started = startDashboard({ registryDir: m.registryDir, port: 0, followPollMs: 20, indexPollMs: 50 });
  if ('refused' in started) throw new Error(started.refused);
  server = started;
  const page = await bootHeadless(server);
  expect(page.ids).toEqual(expect.arrayContaining(['toasts']));
  page.click({ action: 'select-view', view: 'queues' });
  expect(await until(() => page.text('list').includes('data-action="select-queue"'))).toBe(true);
  page.click({ action: 'select-queue', queue: 'beta/ticket-to-pr' });
  expect(await until(() => page.text('main').includes('data-action="poll-queue"'))).toBe(true);
  page.click({
    action: 'move-item',
    dir: 'down',
    repo: 'beta',
    workflow: 'ticket-to-pr',
    key: 'ticket:FAKE-5',
    target: 'ticket:FAKE-6',
  });
  expect(await until(() => page.text('toasts').includes('toast bad'))).toBe(true);
  expect(page.text('toasts')).toContain('role="alert"');
  expect(page.text('toasts')).toContain('ticket:FAKE-6 is parked: only a queued item is moved');
  expect(page.text('dialog')).not.toContain('data-action="dialog-confirm"');
}, 30_000);

test('confirmed tier: on the real bundle and server, a click on FAKE-2 clean-run fills the dialog with a clean button, and no POST was made', async () => {
  m = seedFixtures();
  const leasesDir = join(m.root, 'leases');
  const started = startDashboard({
    registryDir: m.registryDir,
    port: 0,
    followPollMs: 20,
    indexPollMs: 50,
    leasesDir,
    ports: fakeClonePorts(leasesDir),
  });
  if ('refused' in started) throw new Error(started.refused);
  server = started;
  const page = await bootHeadless(server);
  expect(await until(() => page.text('sidebar').includes('<span class="nm">alpha</span>'))).toBe(true);
  page.click({ action: 'select-view', view: 'history' });
  expect(await until(() => page.text('list').includes(`data-run="${FAKE_2_ID}"`))).toBe(true);
  page.click({ action: 'run-menu', repo: 'alpha', run: FAKE_2_ID });
  expect(await until(() => page.text('list').includes('data-action="clean-run"'))).toBe(true);
  page.click({ action: 'clean-run', repo: 'alpha', run: FAKE_2_ID });
  expect(await until(() => page.text('dialog').includes('data-action="dialog-confirm"'))).toBe(true);
  expect(page.text('dialog')).toContain(`<h2 id="dialog-title">clean ${FAKE_2_ID}</h2>`);
  expect(page.text('dialog')).toContain('autofocus>clean</button>');
  expect(page.text('list')).not.toContain('armed');
  expect(page.posted).toEqual([]);
}, 30_000);

test('undoable tier: on the real bundle, clear-attention empties the Inbox and draws an undo-toast button, and clicking it brings back the count of 3', async () => {
  m = seedFixtures();
  const started = startDashboard({ registryDir: m.registryDir, port: 0, followPollMs: 20, indexPollMs: 50 });
  if ('refused' in started) throw new Error(started.refused);
  server = started;
  const page = await bootHeadless(server);
  const count = () =>
    /data-view="inbox"[^>]*><span class="nm">Inbox<\/span><span class="c">(\d+)<\/span>/.exec(
      page.text('sidebar'),
    )?.[1];
  expect(await until(() => count() === '3')).toBe(true);
  page.click({ action: 'select-view', view: 'inbox' });
  expect(await until(() => page.text('list').includes('data-action="clear-attention"'))).toBe(true);
  page.click({ action: 'clear-attention' });
  expect(await until(() => page.text('toasts').includes('data-action="undo-toast"'))).toBe(true);
  expect(count()).toBe('0');
  expect(page.text('list')).toContain('nothing needs attention');
  expect(page.text('toasts')).toContain('<span class="toast-head">all clear</span>');
  const id = /data-action="undo-toast" data-toast="(\d+)"/.exec(page.text('toasts'))?.[1] ?? '';
  page.click({ action: 'undo-toast', toast: id });
  expect(await until(() => count() === '3')).toBe(true);
  expect(page.text('toasts')).not.toContain('toast ok');
  expect(page.posted).toEqual([]);
}, 30_000);

test('on the real bundle, Cmd+K draws the command menu with the open run as its subject, and Escape lets go of it, then empties it', async () => {
  m = seedFixtures();
  const leasesDir = join(m.root, 'leases');
  const started = startDashboard({
    registryDir: m.registryDir,
    port: 0,
    followPollMs: 20,
    indexPollMs: 50,
    leasesDir,
    ports: fakeClonePorts(leasesDir),
  });
  if ('refused' in started) throw new Error(started.refused);
  server = started;
  const page = await bootHeadless(server);
  expect(page.ids).toContain('menu');
  expect(await until(() => page.text('sidebar').includes('<span class="nm">alpha</span>'))).toBe(true);
  page.click({ action: 'open', repo: 'alpha', run: FAKE_2_ID });
  expect(await until(() => page.text('main').includes(`${FAKE_2_ID} · ticket-to-pr@1`))).toBe(true);
  page.press('k', true);
  expect(await until(() => page.text('menu').includes('class="cmdk"'))).toBe(true);
  expect(page.text('menu')).toContain('<div class="cmdk-subj">FAKE-2 · Print the version with --version</div>');
  expect(await until(() => page.text('menu').includes('<span class="cmdk-label">clean</span>'))).toBe(true);
  // The first Escape lets go of the run, the second closes the menu.
  page.press('Escape');
  expect(await until(() => !page.text('menu').includes('cmdk-subj'))).toBe(true);
  expect(page.text('menu')).toContain('class="cmdk"');
  page.press('Escape');
  expect(await until(() => page.text('menu') === '')).toBe(true);
  expect(page.posted).toEqual([]);
}, 30_000);

test('on the real bundle and server, restart from the menu lists the stages and ends in the dialog, with no POST before the confirm', async () => {
  m = seedFixtures();
  const leasesDir = join(m.root, 'leases');
  const started = startDashboard({
    registryDir: m.registryDir,
    port: 0,
    followPollMs: 20,
    indexPollMs: 50,
    leasesDir,
    ports: fakeClonePorts(leasesDir),
  });
  if ('refused' in started) throw new Error(started.refused);
  server = started;
  const page = await bootHeadless(server);
  expect(await until(() => page.text('sidebar').includes('<span class="nm">alpha</span>'))).toBe(true);
  page.click({ action: 'open', repo: 'alpha', run: FAKE_2_ID });
  expect(await until(() => page.text('main').includes(`${FAKE_2_ID} · ticket-to-pr@1`))).toBe(true);
  page.press('k', true);
  expect(await until(() => page.text('menu').includes('<span class="cmdk-label">restart</span>'))).toBe(true);
  page.type('menu-query', 'restart');
  page.press('Enter');
  expect(await until(() => page.text('menu').includes('<div class="cmdk-step">from</div>'))).toBe(true);
  expect((page.text('menu').match(/class="cmdk-row/g) ?? []).length).toBeGreaterThan(1);
  page.press('Enter');
  expect(await until(() => page.text('dialog').includes(`<h2 id="dialog-title">restart ${FAKE_2_ID}</h2>`))).toBe(true);
  expect(page.text('dialog')).toContain('name="only" autofocus>');
  expect(page.text('dialog')).toContain('data-action="dialog-confirm">restart</button>');
  expect(await until(() => page.text('menu') === '')).toBe(true);
  expect(page.posted).toEqual([]);
}, 30_000);

test('undoable tier: on the real bundle, dismiss-attention hides one row and Undo brings it back', async () => {
  m = seedFixtures();
  const started = startDashboard({ registryDir: m.registryDir, port: 0, followPollMs: 20, indexPollMs: 50 });
  if ('refused' in started) throw new Error(started.refused);
  server = started;
  const page = await bootHeadless(server);
  const count = () =>
    /data-view="inbox"[^>]*><span class="nm">Inbox<\/span><span class="c">(\d+)<\/span>/.exec(
      page.text('sidebar'),
    )?.[1];
  expect(await until(() => count() === '3')).toBe(true);
  page.click({ action: 'select-view', view: 'inbox' });
  expect(await until(() => page.text('list').includes('data-action="dismiss-attention"'))).toBe(true);
  const first = /data-action="dismiss-attention" data-item="([^"]*)"/.exec(page.text('list'))?.[1] ?? '';
  page.click({
    action: 'dismiss-attention',
    item: first.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'),
  });
  expect(await until(() => page.text('toasts').includes('data-action="undo-toast"'))).toBe(true);
  expect(count()).toBe('2');
  expect(page.text('toasts')).toContain('<span class="toast-head">dismiss</span>');
  const id = /data-action="undo-toast" data-toast="(\d+)"/.exec(page.text('toasts'))?.[1] ?? '';
  page.click({ action: 'undo-toast', toast: id });
  expect(await until(() => count() === '3')).toBe(true);
  expect(page.posted).toEqual([]);
}, 30_000);

test('a page loaded at a run the index does not list says so in a toast, opens no run and replaces the URL (ADW-513)', async () => {
  m = seedFixtures();
  const started = startDashboard({ registryDir: m.registryDir, port: 0, followPollMs: 20, indexPollMs: 50 });
  if ('refused' in started) throw new Error(started.refused);
  server = started;
  const page = await bootHeadless(server, '?repo=alpha&run=NOPE-1');
  expect(await until(() => page.text('toasts').includes('run NOPE-1 of alpha is not listed'))).toBe(true);
  expect(page.text('main')).toContain('No run selected');
  const written = page.history.map((entry) => [entry.kind, entry.url]);
  expect(written[0]).toEqual(['replace', '/']);
  expect(written.flat().join(' ')).not.toContain('NOPE-1');
}, 30_000);

test('on the real bundle and server, clean all failed in History lists the two failed runs, and confirming cleans both and empties the list', async () => {
  m = seedFixtures();
  writeFileSync(join(m.alpha.runDir, 'STATUS'), 'failed workflow_failed\n');
  const leasesDir = join(m.root, 'leases');
  const started = startDashboard({
    registryDir: m.registryDir,
    port: 0,
    followPollMs: 20,
    indexPollMs: 50,
    leasesDir,
    ports: fakeClonePorts(leasesDir),
    env: { ...process.env, SAIL_HOME: m.sailHome },
  });
  if ('refused' in started) throw new Error(started.refused);
  server = started;
  const page = await bootHeadless(server);
  expect(await until(() => page.text('sidebar').includes('<span class="nm">alpha</span>'))).toBe(true);
  page.click({ action: 'select-view', view: 'history' });
  expect(await until(() => page.text('list').includes('data-action="clean-failed"'))).toBe(true);
  expect(page.text('list')).toContain('>clean all failed</button>');
  page.click({ action: 'clean-failed' });
  expect(await until(() => page.text('dialog').includes('data-action="dialog-confirm"'))).toBe(true);
  expect(page.text('dialog')).toContain('<h2 id="dialog-title">clean every failed run</h2>');
  expect(page.text('dialog')).toContain('<li>cleans 2 failed runs</li>');
  expect(page.text('dialog')).toContain(`<li>alpha: ${FAKE_2_ID}</li>`);
  expect(page.text('dialog')).toContain(`<li>alpha: ${GOLDEN_RUN_ID}</li>`);
  expect(page.posted).toEqual([]);
  page.click({ action: 'dialog-confirm' });
  expect(await until(() => page.text('toasts').includes('cleaned 2 of 2 failed runs'))).toBe(true);
  expect(page.text('toasts')).toContain('toast ok');
  expect(await until(() => !page.text('list').includes('data-action="clean-failed"'))).toBe(true);
  expect(page.text('list')).not.toContain(`data-run="${FAKE_2_ID}"`);
  expect(page.posted).toHaveLength(1);
}, 30_000);

test('the real bundle loaded at ?view=history&status=failed lists only the failed run and keeps status in the URL (ADW-546)', async () => {
  m = seedFixtures();
  const started = startDashboard({ registryDir: m.registryDir, port: 0, followPollMs: 20, indexPollMs: 50 });
  if ('refused' in started) throw new Error(started.refused);
  server = started;
  const page = await bootHeadless(server, '?view=history&status=failed');
  expect(await until(() => page.text('list').includes('data-row="run:alpha/FAKE-2-'))).toBe(true);
  expect(page.text('list')).not.toContain('data-row="run:alpha/FAKE-1-');
  expect(page.text('list')).not.toContain('data-row="run:beta/');
  expect(page.history.at(-1)?.url).toContain('view=history');
  expect(page.history.at(-1)?.url).toContain('status=failed');
}, 30_000);

test('on the real bundle, typing in the filter replaces the entry and choosing a status pushes one (ADW-546)', async () => {
  m = seedFixtures();
  const started = startDashboard({ registryDir: m.registryDir, port: 0, followPollMs: 20, indexPollMs: 50 });
  if ('refused' in started) throw new Error(started.refused);
  server = started;
  const page = await bootHeadless(server, '?view=history');
  expect(await until(() => page.text('list').includes('data-row="run:alpha/FAKE-2-'))).toBe(true);
  const before = page.history.filter((entry) => entry.kind === 'push').length;
  page.type('list-filter', 'FAKE-2');
  expect(await until(() => page.history.at(-1)?.url.includes('q=FAKE-2') === true)).toBe(true);
  expect(page.history.at(-1)?.kind).toBe('replace');
  expect(page.history.filter((entry) => entry.kind === 'push').length).toBe(before);
  page.type('list-status', 'failed');
  expect(await until(() => page.history.at(-1)?.url.includes('status=failed') === true)).toBe(true);
  expect(page.history.at(-1)?.kind).toBe('push');
}, 30_000);
