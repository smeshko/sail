// `browserHost()` adapting a window to the page's host (D3), driven through a fake window: regions by id, a document's
// listeners, fetch, WebSocket, storage and the clipboard, each fake recording what the host asked of it.
import { expect, test } from 'bun:test';
import { type BrowserWindow, browserHost, type ElementLike, type EventLike } from '../../../src/dashboard/page/host';
import { foldRun, type StageCard } from '../../../src/dashboard/page/run-model';
import { renderTimeline } from '../../../src/dashboard/page/timeline-view';
import { initialUi } from '../../../src/dashboard/page/ui-state';
import { readEvents } from '../../../src/events/consumers/ndjson';
import { GOLDEN_RUN } from '../../helpers/dashboard';

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

/** A region whose `[data-scroll]` boxes are new elements, at scrollTop 0, each time its innerHTML is set, as a browser's are. */
function scrollRegion(): ReturnType<typeof element> & { boxes: Map<string, ElementLike> } {
  let markup = '';
  let boxes = new Map<string, ElementLike>();
  const region = element({
    querySelectorAll: (selectors: string) => (selectors === '[data-scroll]' ? [...boxes.values()] : []),
  });
  Object.defineProperty(region, 'innerHTML', {
    get: () => markup,
    set: (next: string) => {
      markup = next;
      boxes = new Map(
        [...next.matchAll(/data-scroll="([^"]*)"/g)].map(([, key]) => [
          key as string,
          element({ dataset: { scroll: key }, scrollTop: 0 }),
        ]),
      );
    },
  });
  Object.defineProperty(region, 'boxes', { get: () => boxes });
  return region as ReturnType<typeof scrollRegion>;
}

const NOW = Date.parse('2026-09-25T09:00:31.000Z');
const at = { ts: '2026-09-25T09:00:30.000Z', runId: 'x', key: 'spec#1' };

/** spec#1 of the golden run with a tool call `c1` whose input is long, running until `ended` ends it. */
function toolCard(extra: Record<string, unknown>[] = []): StageCard {
  const events = [
    ...readEvents(GOLDEN_RUN).slice(0, 14),
    { ...at, seq: 901, type: 'tool:start', callId: 'c1', tool: 'Write', input: { content: 'line\n'.repeat(80) } },
    { ...at, seq: 902, type: 'tool:end', callId: 'c1', status: 'completed', durationMs: 3, result: 'out\n'.repeat(80) },
    ...extra,
  ];
  const card = foldRun(events).cards[1];
  if (card === undefined) throw new Error('no spec#1');
  return card;
}

const timeline = (opened: string[], card = toolCard()) =>
  renderTimeline(card, { ...initialUi(0), timeline: true, opened }, NOW).value;

function fakeWindow(
  options: { storage?: 'throws'; clipboard?: 'rejects' | 'missing'; fetch?: 'fails'; search?: string } = {},
) {
  const listeners: Record<string, ((event: EventLike) => void)[]> = {};
  const elements: Record<string, ReturnType<typeof element>> = { rail: element(), body: element() };
  const fetched: { url: string; headers: Record<string, string>; method?: string; body?: string }[] = [];
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
    location: { host: '127.0.0.1:4100', search: options.search ?? '' },
    async fetch(url, init) {
      fetched.push({
        url,
        headers: init.headers,
        ...(init.method === undefined ? {} : { method: init.method }),
        ...(init.body === undefined ? {} : { body: init.body }),
      });
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

test("start gives the URL's query as names and values, decoded, and nothing for a URL with none", () => {
  const asked = fakeWindow({ search: '?repo=alpha&run=FAKE-2-01M5&key=implement%231&tab=permissions' });
  expect(browserHost(asked.win).start()).toEqual({
    repo: 'alpha',
    run: 'FAKE-2-01M5',
    key: 'implement#1',
    tab: 'permissions',
  });
  expect(browserHost(fakeWindow().win).start()).toEqual({});
});

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

test('scrollToEnd scrolls the element holding a region to its height, and does nothing for a region with no element or no parent', () => {
  const fake = fakeWindow();
  const box = element({ scrollTop: 0, scrollHeight: 900 });
  fake.elements.main = element({ parentElement: box });
  const host = browserHost(fake.win);
  host.scrollToEnd('main');
  host.scrollToEnd('rail');
  host.scrollToEnd('status');
  expect(box.scrollTop).toBe(900);
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

test("render keeps an opened tool call's input box scrolled across a redraw", () => {
  const fake = fakeWindow();
  const main = scrollRegion();
  fake.elements.main = main as never;
  const host = browserHost(fake.win);
  host.render('main', timeline(['c1']));
  const first = main.boxes.get('input:c1');
  if (first === undefined) throw new Error('no input box');
  first.scrollTop = 240;
  host.render('main', timeline(['c1']));
  const again = main.boxes.get('input:c1');
  expect(again).not.toBe(first);
  expect(again?.scrollTop).toBe(240);
  host.render('main', timeline(['c1'], toolCard([{ ...at, seq: 903, type: 'agent:message', text: 'next' }])));
  expect(main.boxes.get('input:c1')?.scrollTop).toBe(240);
  expect(main.boxes.get('result:c1')?.scrollTop).toBe(0);
});

test("render keeps an opened tool call's result box, and an opened script's stdout box, scrolled across a redraw", () => {
  const fake = fakeWindow();
  const main = scrollRegion();
  fake.elements.main = main as never;
  const host = browserHost(fake.win);
  host.render('main', timeline(['c1']));
  const result = main.boxes.get('result:c1');
  if (result === undefined) throw new Error('no result box');
  result.scrollTop = 130;
  host.render('main', timeline(['c1']));
  expect(main.boxes.get('result:c1')?.scrollTop).toBe(130);
  expect(main.boxes.get('input:c1')?.scrollTop).toBe(0);

  const golden = foldRun(readEvents(GOLDEN_RUN)).cards.find((card) => card.key === 'publish#1') as StageCard;
  const drawn = () =>
    renderTimeline(golden, { ...initialUi(0), timeline: true, opened: ['script:0'] }, NOW, {
      'publish#1/open': {
        stdout: { state: 'loaded', value: 'out\n'.repeat(80) },
        stderr: { state: 'loaded', value: 'err\n'.repeat(80) },
      },
    }).value;
  host.render('main', drawn());
  const stdout = main.boxes.get('stdout:script:0');
  if (stdout === undefined) throw new Error('no stdout box');
  stdout.scrollTop = 75;
  host.render('main', drawn());
  expect(main.boxes.get('stdout:script:0')?.scrollTop).toBe(75);
  expect(main.boxes.get('stderr:script:0')?.scrollTop).toBe(0);
});

test('render passes on no offset to a box that is gone, and renders a region without querySelectorAll', () => {
  const fake = fakeWindow();
  const main = scrollRegion();
  fake.elements.main = main as never;
  const host = browserHost(fake.win);
  host.render('main', timeline(['c1']));
  const box = main.boxes.get('input:c1');
  if (box === undefined) throw new Error('no input box');
  box.scrollTop = 240;
  host.render('main', timeline([]));
  expect(main.boxes.size).toBe(0);
  host.render('main', timeline(['c1']));
  expect(main.boxes.get('input:c1')?.scrollTop).toBe(0);

  host.render('rail', '<b>alpha</b>');
  expect(fake.elements.rail?.innerHTML).toBe('<b>alpha</b>');
});

test('post sends the method, the client header, a JSON content type and the JSON body, and gives the status and body, or status 0 when the request fails', async () => {
  const fake = fakeWindow();
  const answer = await browserHost(fake.win).post('/api/repos/alpha/queues/a/move', { dedupKey: 'ticket:FAKE-1' });
  expect(answer).toEqual({ status: 200, body: 'body of /api/repos/alpha/queues/a/move' });
  expect(fake.fetched).toEqual([
    {
      url: '/api/repos/alpha/queues/a/move',
      headers: { 'X-Sail-Dashboard': '1', 'Content-Type': 'application/json' },
      method: 'POST',
      body: '{"dedupKey":"ticket:FAKE-1"}',
    },
  ]);
  expect(await browserHost(fakeWindow({ fetch: 'fails' }).win).post('/x', {})).toEqual({ status: 0, body: '' });
});

test('value() reads the named field of the main region, and answers undefined for a field it lacks and for no main region', () => {
  const fake = fakeWindow();
  const host = browserHost(fake.win);
  expect(host.value('raise')).toBeUndefined();
  const asked: string[] = [];
  fake.elements.main = element({
    querySelector: (selectors: string) => {
      asked.push(selectors);
      return selectors === '[name="raise"]' ? element({ value: '2.5' }) : null;
    },
  });
  expect([host.value('raise'), host.value('stage')]).toEqual(['2.5', undefined]);
  expect(asked).toEqual(['[name="raise"]', '[name="stage"]']);
  fake.elements.main = element();
  expect(host.value('raise')).toBeUndefined();
});
