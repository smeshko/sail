// `browserHost()` adapting a window to the page's host (D3), driven through a fake window: regions by id, a document's
// listeners, fetch, WebSocket, storage and the clipboard, each fake recording what the host asked of it.
import { expect, test } from 'bun:test';
import { type BrowserWindow, browserHost, type ElementLike, type EventLike } from '../../../src/dashboard/page/host';

interface FakeSocket {
  url: string;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  closes: number;
  close(): void;
}

function element(fields: Partial<ElementLike> = {}): ElementLike & { styles: Record<string, string> } {
  const styles: Record<string, string> = {};
  return {
    innerHTML: '',
    dataset: {},
    parentElement: null,
    style: {
      setProperty: (name, value) => {
        styles[name] = value;
      },
    },
    styles,
    ...fields,
  };
}

function fakeWindow(options: { storage?: 'throws'; clipboard?: 'rejects' | 'missing'; fetch?: 'fails' } = {}) {
  const listeners: Record<string, ((event: EventLike) => void)[]> = {};
  const elements: Record<string, ReturnType<typeof element>> = { rail: element(), body: element() };
  const fetched: { url: string; headers: Record<string, string> }[] = [];
  const sockets: FakeSocket[] = [];
  const timers: number[] = [];
  const cleared: number[] = [];
  const root = { dataset: {} as Record<string, string | undefined> };
  const stored = new Map<string, string>();
  const copied: string[] = [];
  const win: BrowserWindow = {
    document: {
      getElementById: (id) => elements[id] ?? null,
      addEventListener: (type, listener) => {
        listeners[type] = [...(listeners[type] ?? []), listener];
      },
      removeEventListener: (type, listener) => {
        listeners[type] = (listeners[type] ?? []).filter((entry) => entry !== listener);
      },
      documentElement: root,
    },
    location: { host: '127.0.0.1:4100' },
    async fetch(url, init) {
      fetched.push({ url, headers: init.headers });
      if (options.fetch === 'fails') throw new Error('offline');
      return { status: 200, text: async () => `body of ${url}` };
    },
    WebSocket: class {
      onmessage = null;
      onclose = null;
      closes = 0;
      constructor(readonly url: string) {
        sockets.push(this as unknown as FakeSocket);
      }
      close() {
        this.closes++;
      }
    } as unknown as BrowserWindow['WebSocket'],
    get localStorage() {
      if (options.storage === 'throws') throw new Error('storage is disabled');
      return {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => void stored.set(key, value),
      };
    },
    navigator:
      options.clipboard === 'missing'
        ? {}
        : {
            clipboard: {
              async writeText(text: string) {
                if (options.clipboard === 'rejects') throw new Error('denied');
                copied.push(text);
              },
            },
          },
    setTimeout: () => timers.push(timers.length + 1),
    clearTimeout: (id) => void cleared.push(id),
    Date: class {
      getTimezoneOffset() {
        return -120;
      }
    } as unknown as BrowserWindow['Date'],
  };
  const fire = (type: string, event: EventLike) => {
    for (const listener of [...(listeners[type] ?? [])]) listener(event);
  };
  return { win, elements, fetched, sockets, timers, cleared, root, stored, copied, fire, listeners };
}

test("a click on a child of a data-action element is delegated once, with the element's data; a click outside any is not", () => {
  const fake = fakeWindow();
  const host = browserHost(fake.win);
  const got: [string, Record<string, string>][] = [];
  host.onAction((action, data) => got.push([action, data]));
  const button = element({
    dataset: { action: 'open', repo: 'alpha', run: 'FAKE-2', key: 'implement#1', tab: undefined },
  });
  const label = element({ parentElement: element({ parentElement: button }) });
  fake.fire('click', { target: label });
  fake.fire('click', { target: element() });
  fake.fire('click', { target: 'not an element' });
  expect(got).toEqual([['open', { action: 'open', repo: 'alpha', run: 'FAKE-2', key: 'implement#1' }]]);
});

test('get sends X-Sail-Dashboard: 1 and gives the status and body, or status 0 when the request fails', async () => {
  const fake = fakeWindow();
  expect(await browserHost(fake.win).get('/api/repos')).toEqual({ status: 200, body: 'body of /api/repos' });
  expect(fake.fetched).toEqual([{ url: '/api/repos', headers: { 'X-Sail-Dashboard': '1' } }]);
  expect(await browserHost(fakeWindow({ fetch: 'fails' }).win).get('/api/repos')).toEqual({ status: 0, body: '' });
});

test("connect opens ws://<the page's host>/ws?<query>, passes each message's text, reports a close once, and closes on request", () => {
  const fake = fakeWindow();
  const messages: string[] = [];
  let closes = 0;
  const connection = browserHost(fake.win).connect('run=alpha%2FFAKE-1', {
    message: (text) => messages.push(text),
    close: () => closes++,
  });
  const [socket] = fake.sockets;
  expect(socket?.url).toBe('ws://127.0.0.1:4100/ws?run=alpha%2FFAKE-1');
  socket?.onmessage?.({ data: '{"kind":"end"}' });
  socket?.onclose?.({});
  socket?.onclose?.({});
  connection.close();
  expect([messages, closes, socket?.closes]).toEqual([['{"kind":"end"}'], 1, 1]);
});

test('load and save survive a throwing localStorage, and copy reports false when the clipboard rejects or is missing', async () => {
  const working = fakeWindow();
  const host = browserHost(working.win);
  host.save('sail-dashboard-theme', 'light');
  expect([host.load('sail-dashboard-theme'), host.load('other')]).toEqual(['light', undefined]);
  const broken = browserHost(fakeWindow({ storage: 'throws' }).win);
  expect(() => broken.save('sail-dashboard-theme', 'light')).not.toThrow();
  expect(broken.load('sail-dashboard-theme')).toBeUndefined();
  expect(await host.copy('sail show x')).toBe(true);
  expect(working.copied).toEqual(['sail show x']);
  expect(await browserHost(fakeWindow({ clipboard: 'rejects' }).win).copy('x')).toBe(false);
  expect(await browserHost(fakeWindow({ clipboard: 'missing' }).win).copy('x')).toBe(false);
});

test("render writes a region by id, keys say whether they were typed in an input, the theme and inspector set the root's data, timers and the offset pass through, and a resize handle drags its column within bounds", () => {
  const fake = fakeWindow();
  const host = browserHost(fake.win);
  host.render('rail', '<b>alpha</b>');
  host.render('status', 'nowhere');
  expect(fake.elements.rail?.innerHTML).toBe('<b>alpha</b>');
  const keys: [string, boolean][] = [];
  host.onKey((key, inInput) => keys.push([key, inInput]));
  fake.fire('keydown', { key: 'j', target: element({ tagName: 'DIV' }) });
  fake.fire('keydown', { key: 'j', target: element({ tagName: 'INPUT' }) });
  expect(keys).toEqual([
    ['j', false],
    ['j', true],
  ]);
  host.setTheme('light');
  host.setInspector(false);
  expect(fake.root.dataset).toEqual({ theme: 'light', inspector: 'closed' });
  expect([host.later(() => {}, 100), host.later(() => {}, 100), host.offset()]).toEqual([1, 2, 120]);
  host.cancel(2);
  expect(fake.cleared).toEqual([2]);
  expect(Math.abs(host.now() - Date.now())).toBeLessThan(1000);

  const body = fake.elements.body;
  fake.fire('mousedown', { target: element({ dataset: { resize: 'left' } }), clientX: 300 });
  fake.fire('mousemove', { target: null, clientX: 340 });
  expect(body?.styles['--rail-w']).toBe('300px');
  fake.fire('mousemove', { target: null, clientX: 2000 });
  expect(body?.styles['--rail-w']).toBe('480px');
  fake.fire('mouseup', { target: null });
  fake.fire('mousemove', { target: null, clientX: 0 });
  expect(body?.styles['--rail-w']).toBe('480px');
  fake.fire('mousedown', { target: element({ dataset: { resize: 'right' } }), clientX: 1000 });
  fake.fire('mousemove', { target: null, clientX: 2000 });
  expect(body?.styles['--ins-w']).toBe('240px');
  fake.fire('mousedown', { target: element(), clientX: 0 });
  expect(fake.listeners.mousemove).toHaveLength(1);
});
