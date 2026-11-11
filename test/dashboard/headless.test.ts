// The real page, booted headless against a real dashboard (D3): the test fetches `GET /` from a server over the seeded
// fixtures, takes the inlined bundle and runs it against a fake document whose regions are `index.html`'s ids. Its
// fetch and WebSocket are Bun's own, aimed at the server, so the real bundle, server and streams are exercised, and
// only the DOM is fake.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserWindow, ElementLike, EventLike } from '../../src/dashboard/page/host';
import { type Dashboard, startDashboard } from '../../src/dashboard/server';
import { FAKE_2_ID, type Machine, seedFixtures } from '../helpers/dashboard';

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
async function bootHeadless(dashboard: Dashboard) {
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
    location: { host: `127.0.0.1:${dashboard.port}`, search: '', pathname: '/' },
    history: {
      pushState: (data, unused, url) => history.push({ kind: 'push', data, unused, url }),
      replaceState: (data, unused, url) => history.push({ kind: 'replace', data, unused, url }),
    },
    fetch: (path, init) => fetch(`${origin}${path}`, init),
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
  return { ids, text, click };
}

test("the real bundle boots headless: both repositories, the golden run's eight cards and its $1.35, then FAKE-2's denial on the permissions tab", async () => {
  m = seedFixtures();
  const started = startDashboard({ registryDir: m.registryDir, port: 0, followPollMs: 20, indexPollMs: 50 });
  if ('refused' in started) throw new Error(started.refused);
  server = started;
  const page = await bootHeadless(server);
  expect(page.ids).toEqual(expect.arrayContaining(['rail', 'attention', 'main', 'inspector', 'status']));
  expect(page.ids).not.toContain('queues');
  expect(await until(() => page.text('rail').includes('<span class="nm">beta</span>'))).toBe(true);
  expect(page.text('rail')).toContain('<span class="nm">alpha</span>');
  expect(await until(() => (page.text('main').match(/data-action="select-card"/g) ?? []).length === 8)).toBe(true);
  expect(page.text('main')).toContain('<div class="stat"><b>$1.35</b><span>of $25.00 (5.4%)</span></div>');
  expect(page.text('attention')).toContain('<span class="badge">4</span>');
  page.click({ action: 'select-queue', queue: 'beta/ticket-to-pr' });
  expect(await until(() => page.text('main').includes('<span class="pill p-skip">watcher not running</span>'))).toBe(
    true,
  );
  expect(page.text('main')).toContain('<button class="btn" disabled');
  expect(page.text('rail')).toContain('watcher not running');
  page.click({ action: 'open', repo: 'alpha', run: FAKE_2_ID, key: 'implement#1', tab: 'permissions' });
  expect(await until(() => page.text('inspector').includes('<code>git push --force origin HEAD</code>'))).toBe(true);
  expect(page.text('inspector')).toContain('<dt>rule</dt><dd>commands</dd>');
  expect(page.text('main')).toContain(`<span class="d-agent">${FAKE_2_ID} · ticket-to-pr@1</span>`);
}, 30_000);

test("once beta's queue/ is gone, the next index drops its queue row and gives the centre back to the run", async () => {
  m = seedFixtures();
  const started = startDashboard({ registryDir: m.registryDir, port: 0, followPollMs: 20, indexPollMs: 50 });
  if ('refused' in started) throw new Error(started.refused);
  server = started;
  const page = await bootHeadless(server);
  expect(await until(() => page.text('rail').includes('data-action="select-queue"'))).toBe(true);
  page.click({ action: 'select-queue', queue: 'beta/ticket-to-pr' });
  expect(await until(() => page.text('main').includes('beta / ticket-to-pr'))).toBe(true);
  rmSync(join(m.beta.clone, '.sail-runs', 'queue'), { recursive: true });
  expect(await until(() => !page.text('rail').includes('select-queue'))).toBe(true);
  expect(await until(() => (page.text('main').match(/data-action="select-card"/g) ?? []).length === 8)).toBe(true);
  expect(page.text('rail')).toContain('<span class="nm">beta</span>');
}, 30_000);

test("a beta queue that can't be read is listed in the rail with its problem, and its row opens a queue view that shows it", async () => {
  m = seedFixtures();
  const broken = join(m.beta.clone, '.sail-runs', 'queue', 'broken');
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, 'queue.json'), '{');
  const started = startDashboard({ registryDir: m.registryDir, port: 0, followPollMs: 20, indexPollMs: 50 });
  if ('refused' in started) throw new Error(started.refused);
  server = started;
  const page = await bootHeadless(server);
  expect(await until(() => page.text('rail').includes('beta › broken'))).toBe(true);
  expect(page.text('rail')).toContain('<span class="n">unreadable</span>');
  page.click({ action: 'select-queue', queue: 'beta/broken' });
  expect(await until(() => page.text('main').includes('broken queue'))).toBe(true);
  expect(page.text('main')).toContain('queue.json can&#39;t be read');
}, 30_000);
