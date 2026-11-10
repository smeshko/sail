// `browserHost()` adapting a window to the page's host (D3), driven through a fake window: regions by id, a document's
// listeners, fetch, WebSocket, storage and the clipboard, each fake recording what the host asked of it.
import { describe, expect, test } from 'bun:test';
import { index } from '../../../src/dashboard/files';
import { boot } from '../../../src/dashboard/page/app';
import {
  type BrowserWindow,
  browserHost,
  type ElementLike,
  type EventLike,
  REGIONS,
} from '../../../src/dashboard/page/host';
import { foldRun, type StageCard } from '../../../src/dashboard/page/run-model';
import { renderTimeline } from '../../../src/dashboard/page/timeline-view';
import { initialUi } from '../../../src/dashboard/page/ui-state';
import { readEvents } from '../../../src/events/consumers/ndjson';
import { GOLDEN_RUN, QUEUE_WORKFLOW, queueDirOf, runningCopy, seedFixtures } from '../../helpers/dashboard';
import { markupWindow } from '../../helpers/dashboard-dom';

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

/** What a fake window's focus holds: the element a browser would report as `document.activeElement`. */
interface Focus {
  active: ElementLike | null;
  /** The options each `focus()` call was given. */
  calls: ({ preventScroll?: boolean } | undefined)[];
}

const decode = (text: string) =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

function attributesOf(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const [, name, value] of text.matchAll(/([\w:-]+)(?:="([^"]*)")?/g))
    attributes[name as string] = decode(value ?? '');
  return attributes;
}

const camel = (name: string) => name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

type LiveElement = ElementLike & {
  attributes: Record<string, string>;
  focusable: boolean;
  /** How many times `setSelectionRange` was called on it. */
  selectionCalls: number;
};

/**
 * A region whose elements are new objects each time its innerHTML is set, made from the markup's `input`, `select`,
 * `button` and `a` tags and its `[data-scroll]` boxes, as a browser's are. A write drops the focus an element of the
 * region held, as a browser's does.
 */
function liveRegion(focus: Focus): ReturnType<typeof element> & { els: LiveElement[] } {
  let markup = '';
  let els: LiveElement[] = [];
  const region = element({
    contains: (other: ElementLike) => els.includes(other as LiveElement),
    querySelectorAll: (selectors: string) => {
      if (selectors === '[data-scroll]') return els.filter((el) => el.dataset.scroll !== undefined);
      if (selectors === '[name]') return els.filter((el) => el.attributes.name !== undefined);
      if (selectors === '[name], [data-action], a[href]')
        return els.filter(
          (el) =>
            el.attributes.name !== undefined || el.dataset.action !== undefined || el.attributes.href !== undefined,
        );
      return [];
    },
  });
  Object.defineProperty(region, 'innerHTML', {
    get: () => markup,
    set: (next: string) => {
      if (focus.active !== null && els.includes(focus.active as LiveElement)) focus.active = null;
      markup = next;
      els = [];
      for (const match of next.matchAll(/<(\w+)(?=[\s>/])([^>]*)>/g)) {
        const [, tag, text] = match;
        const attributes = attributesOf(text as string);
        const focusable =
          ['input', 'select', 'button'].includes(tag as string) || (tag === 'a' && attributes.href !== undefined);
        if (!focusable && attributes['data-scroll'] === undefined && attributes['data-action'] === undefined) continue;
        const dataset: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(attributes))
          if (name.startsWith('data-')) dataset[camel(name.slice(5))] = value;
        // A select keeps only a value among its markup's options, and a number field has no selection, as in a browser.
        const options =
          tag === 'select'
            ? [
                ...next
                  .slice((match.index ?? 0) + match[0].length)
                  .split('</select>', 1)
                  .join('')
                  .matchAll(/<option([^>]*)>/g),
              ].map(([, optionText]) => attributesOf(optionText as string))
            : [];
        let value =
          tag === 'select'
            ? ((options.find((option) => 'selected' in option) ?? options[0])?.value ?? '')
            : (attributes.value ?? '');
        let start: number | null = attributes.type === 'number' ? null : value.length;
        let end: number | null = start;
        let direction: string | null = 'none';
        const el: LiveElement = {
          ...element({ dataset, parentElement: region }),
          attributes,
          focusable,
          selectionCalls: 0,
          tagName: String(tag).toUpperCase(),
          scrollTop: 0,
          get value() {
            return value;
          },
          set value(next: string) {
            value = tag === 'select' && !options.some((option) => option.value === next) ? '' : next;
            start = end = attributes.type === 'number' ? null : value.length;
          },
          checked: 'checked' in attributes,
          get selectionStart() {
            return start;
          },
          get selectionEnd() {
            return end;
          },
          get selectionDirection() {
            return direction;
          },
          setSelectionRange: (from: number, to: number, how?: string) => {
            el.selectionCalls++;
            if (attributes.type === 'number') throw new Error('InvalidStateError');
            start = from;
            end = to;
            direction = how ?? 'none';
          },
          contains: (other: ElementLike) => other === el,
          focus: (options) => {
            focus.active = el;
            focus.calls.push(options);
          },
          getAttribute: (name: string) => attributes[name] ?? null,
        };
        if (attributes.name !== undefined) el.name = attributes.name;
        if (attributes.type !== undefined) el.type = attributes.type;
        if (tag === 'select') el.type = 'select-one';
        els.push(el);
      }
    },
  });
  Object.defineProperty(region, 'els', { get: () => els });
  return region as ReturnType<typeof liveRegion>;
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
  const elements: Record<string, ReturnType<typeof element>> = { list: element(), body: element() };
  const fetched: { url: string; headers: Record<string, string>; method?: string; body?: string }[] = [];
  const sockets: FakeSocket[] = [];
  const timers: number[] = [];
  const pending = new Map<number, { at: number; fn: () => void }>();
  let clock: number | undefined;
  const nowMs = () => clock ?? Date.now();
  const cleared: number[] = [];
  const focus: Focus = { active: null, calls: [] };
  const live: string[] = [];
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
      get activeElement() {
        return focus.active;
      },
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
    setTimeout: (fn, ms) => {
      const id = timers.push(timers.length + 1);
      pending.set(id, { at: nowMs() + ms, fn });
      return id;
    },
    clearTimeout: (id) => {
      cleared.push(id);
      pending.delete(id);
    },
    Date: class {
      getTimezoneOffset() {
        return -120;
      }
      static now() {
        return nowMs();
      }
    } as unknown as BrowserWindow['Date'],
  };
  const fire = (type: string, event: EventLike) => {
    for (const listener of [...(listeners[type] ?? [])]) listener(event);
  };
  /** A live region for `id`, after the ones made before it in document order. */
  const addLive = (id: string) => {
    const region = liveRegion(focus);
    elements[id] = region;
    live.push(id);
    return region;
  };
  const focusables = () =>
    live.flatMap((id) => (elements[id] as ReturnType<typeof liveRegion>).els.filter((el) => el.focusable));
  return {
    win,
    elements,
    fetched,
    sockets,
    timers,
    cleared,
    root,
    stored,
    copied,
    fire,
    listeners,
    focus,
    live: addLive,
    focusables,
    /** Sets the clock `Date.now()` and the timers read, until `advance` moves it. */
    setClock: (ms: number) => {
      clock = ms;
    },
    /** Moves the clock on, running every timer that falls due, in order. */
    advance: (ms: number) => {
      const until = nowMs() + ms;
      for (;;) {
        const due = [...pending].filter(([, timer]) => timer.at <= until).sort(([, a], [, b]) => a.at - b.at)[0];
        if (due === undefined) break;
        pending.delete(due[0]);
        clock = due[1].at;
        due[1].fn();
      }
      clock = until;
    },
    /** What a browser's Tab does: the next focusable element in document order, the first when none holds focus. */
    tab: () => {
      const all = focusables();
      const at = focus.active === null ? -1 : all.indexOf(focus.active as LiveElement);
      focus.active = all[at + 1] ?? all[0] ?? null;
    },
  };
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
  host.scrollToEnd('list');
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
  host.render('list', '<b>alpha</b>');
  host.render('status', 'nowhere');
  expect(fake.elements.list?.innerHTML).toBe('<b>alpha</b>');
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
  expect(body?.styles['--side-w']).toBe('220px');
  fake.fire('mousemove', { target: null, clientX: 2000 });
  expect(body?.styles['--side-w']).toBe('480px');
  fake.fire('mouseup', { target: null });
  fake.fire('mousemove', { target: null, clientX: 0 });
  expect(body?.styles['--side-w']).toBe('480px');
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

  host.render('list', '<b>alpha</b>');
  expect(fake.elements.list?.innerHTML).toBe('<b>alpha</b>');
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

test('value() reads a named field from whichever region holds it, the list before the main region, and answers undefined for a name no region holds', () => {
  const { win, field } = markupWindow();
  const host = browserHost(win);
  expect(host.value('raise')).toBeUndefined();
  host.render('list', '<input class="num" type="number" name="raise" value="2.5">');
  host.render('main', '<input class="txt" type="text" name="add-ticket" value="FAKE-9">');
  expect([host.value('raise'), host.value('add-ticket'), host.value('stage')]).toEqual(['2.5', 'FAKE-9', undefined]);
  host.render('main', '<input class="num" type="number" name="raise" value="9">');
  expect(host.value('raise')).toBe('2.5');
  host.render(
    'list',
    '<select name="stage"><option value="spec">spec</option><option value="implement" title="a selected b" selected>implement</option></select>',
  );
  expect(host.value('stage')).toBe('implement');
  expect(field('list', 'stage').value).toBe('implement');
  expect(() => field('list', 'nothing')).toThrow('no field "nothing" in #list');
  const fake = fakeWindow();
  fake.elements.main = element();
  expect(browserHost(fake.win).value('raise')).toBeUndefined();
});

test("value() of a checkbox is 'on' while it is ticked and empty while it is not, whatever its value attribute says", () => {
  const { win, field } = markupWindow();
  const host = browserHost(win);
  host.render('list', '<input type="checkbox" name="now" data-action="stop-now">');
  expect(host.value('now')).toBe('');
  field('list', 'now').checked = true;
  expect(host.value('now')).toBe('on');
  host.render('main', '<input type="checkbox" name="add-force" value="on">');
  expect(host.value('add-force')).toBe('');
});

describe('Enter and Space on a focused control', () => {
  const setup = () => {
    const fake = fakeWindow();
    const host = browserHost(fake.win);
    const actions: [string, Record<string, string>][] = [];
    const keys: [string, boolean][] = [];
    host.onAction((action, data) => actions.push([action, data]));
    host.onKey((key, inInput) => keys.push([key, inInput]));
    const press = (key: string, target: unknown) => {
      let prevented = 0;
      fake.fire('keydown', { key, target, preventDefault: () => prevented++ });
      return prevented;
    };
    return { actions, keys, press };
  };
  const card = () => element({ tagName: 'DIV', dataset: { action: 'select-card', key: 'spec#1' } });

  for (const key of ['Enter', ' ']) {
    test(`${JSON.stringify(key)} on a focused card delivers its action, stops the default and is no key`, () => {
      const { actions, keys, press } = setup();
      expect(press(key, card())).toBe(1);
      expect(actions).toEqual([['select-card', { action: 'select-card', key: 'spec#1' }]]);
      expect(keys).toEqual([]);
    });

    for (const tagName of ['BUTTON', 'A']) {
      test(`${JSON.stringify(key)} on a focused ${tagName} reaches neither handler and keeps its default`, () => {
        const { actions, keys, press } = setup();
        const target = element({ tagName, dataset: { action: 'select-run', run: 'x' } });
        expect(press(key, target)).toBe(0);
        expect([actions, keys]).toEqual([[], []]);
      });
    }
  }

  test('Enter on the body, j on a focused card or button, and Enter in an input still reach the key handler', () => {
    const { actions, keys, press } = setup();
    expect(press('Enter', element({ tagName: 'BODY' }))).toBe(0);
    press('j', card());
    press('j', element({ tagName: 'BUTTON', dataset: { action: 'x' } }));
    press('Enter', element({ tagName: 'INPUT', dataset: { action: 'x' } }));
    expect(keys).toEqual([
      ['Enter', false],
      ['j', false],
      ['j', false],
      ['Enter', true],
    ]);
    expect(actions).toEqual([]);
  });
});

const row = (run: string) => `<button data-action="select-run" data-repo="alpha" data-run="${run}">${run}</button>`;

test('render puts the focus back on the element with the same data-action and data, a new element, so Tab goes on from it', () => {
  const fake = fakeWindow();
  const rail = fake.live('list');
  const host = browserHost(fake.win);
  host.render('list', `${row('r1')}${row('r2')}${row('r3')}`);
  fake.tab();
  fake.tab();
  const before = fake.focus.active;
  host.render('list', `${row('r1')}${row('r2')}${row('r3')}<span>more</span>`);
  expect(fake.focus.active).not.toBe(before);
  expect(fake.focus.active).toBe(rail.els[1] as ElementLike);
  expect(fake.focus.active?.dataset).toEqual({ action: 'select-run', repo: 'alpha', run: 'r2' });
  expect(fake.focus.calls).toEqual([{ preventScroll: true }]);
  fake.tab();
  expect(fake.focus.active).toBe(rail.els[2] as ElementLike);
});

test("of two elements with one key, the one at the focused one's place is focused, and the last when one is gone", () => {
  const fake = fakeWindow();
  const rail = fake.live('list');
  const host = browserHost(fake.win);
  const twin = (label: string) => `<button data-action="select-queue" data-queue="b/w">${label}</button>`;
  host.render('list', `${row('r1')}${twin('row')}${twin('badge')}`);
  fake.tab();
  fake.tab();
  fake.tab();
  expect(fake.focus.active).toBe(rail.els[2] as ElementLike);
  host.render('list', `${row('r1')}${twin('row')}${twin('badge')}<i>x</i>`);
  expect(fake.focus.active).toBe(rail.els[2] as ElementLike);
  host.render('list', `${row('r1')}${twin('row')}`);
  expect(fake.focus.active).toBe(rail.els[1] as ElementLike);
});

test('a focused link is found again by its href', () => {
  const fake = fakeWindow();
  const main = fake.live('main');
  const host = browserHost(fake.win);
  host.render('main', '<a href="/x?run=1">log</a><a href="/y">other</a>');
  fake.tab();
  fake.tab();
  host.render('main', '<a href="/x?run=1">log</a><a href="/y">other</a><i>x</i>');
  expect(fake.focus.active).toBe(main.els[1] as ElementLike);
  expect(fake.focus.active?.getAttribute?.('href')).toBe('/y');
});

test('focus outside the region, on an element with no key, or on one the new markup lacks, is left alone, and a region without contains or querySelectorAll still renders', () => {
  const fake = fakeWindow();
  fake.live('list');
  const main = fake.live('main');
  const host = browserHost(fake.win);
  host.render('list', row('r1'));
  host.render('main', row('m1'));
  fake.tab();
  fake.tab();
  expect(fake.focus.active).toBe(main.els[0] as ElementLike);
  host.render('list', `${row('r1')}<i>x</i>`);
  expect(fake.focus.active).toBe(main.els[0] as ElementLike);
  expect(fake.focus.calls).toEqual([]);

  host.render('main', '<button>no key</button>');
  fake.tab();
  fake.tab();
  expect(fake.focus.active).toBe(main.els[0] as ElementLike);
  host.render('main', '<button>no key</button><i>x</i>');
  expect(fake.focus.active).toBeNull();
  expect(fake.focus.calls).toEqual([]);

  host.render('main', row('m1'));
  fake.tab();
  fake.tab();
  expect(fake.focus.active?.dataset.run).toBe('m1');
  host.render('main', row('m2'));
  expect(fake.focus.active).toBeNull();
  expect(fake.focus.calls).toEqual([]);

  fake.elements.status = element();
  host.render('status', '<b>x</b>');
  expect(fake.elements.status.innerHTML).toBe('<b>x</b>');
});

test('across a tick the list is rewritten, the focused row stays focused and Tab goes to the next row', () => {
  const m = seedFixtures();
  const fake = fakeWindow();
  const page = (() => {
    try {
      const { dir, rest } = runningCopy(m, 1);
      const lines = rest.map((line) => JSON.parse(line));
      const start = lines.find((event) => event.type === 'stage:start' && event.key === 'implement#1');
      for (const id of REGIONS) fake.live(id);
      fake.setClock(Date.parse(start.ts) + 1000);
      const booted = boot(browserHost(fake.win));
      const socketOf = (part: string) => fake.sockets.find((socket) => socket.url.includes(part));
      socketOf('index=')?.onmessage?.({ data: JSON.stringify({ kind: 'index', repos: index(m.registryDir) }) });
      const run = socketOf('run=');
      for (const event of [...readEvents(dir), ...lines.slice(0, lines.indexOf(start) + 1)])
        run?.onmessage?.({ data: JSON.stringify({ kind: 'event', event }) });
      return booted;
    } catch (error) {
      m.remove();
      throw error;
    }
  })();
  try {
    fake.advance(100);
    const rail = fake.elements.list as ReturnType<typeof liveRegion>;
    const rows = rail.els.filter((el) => el.focusable);
    const at = Math.min(5, rows.length - 2);
    expect(at).toBeGreaterThan(0);
    // The sidebar comes first in the page, so its focusable elements are tabbed past.
    const beforeList = (fake.elements.sidebar as ReturnType<typeof liveRegion>).els.filter((el) => el.focusable).length;
    for (let step = 0; step < beforeList + at + 1; step++) fake.tab();
    const focused = fake.focus.active as ElementLike;
    expect(focused).toBe(rows[at] as ElementLike);
    fake.advance(1000);
    const after = rail.els.filter((el) => el.focusable);
    expect(after[at]).not.toBe(focused);
    expect(fake.focus.active).toBe(after[at] as ElementLike);
    expect(fake.focus.active?.dataset).toEqual(focused.dataset);
    fake.tab();
    expect(fake.focus.active).toBe(after[at + 1] as ElementLike);
  } finally {
    page.stop();
    m.remove();
  }
});

const field = (region: ReturnType<typeof liveRegion>, name: string) =>
  region.els.find((el) => el.attributes.name === name) as LiveElement;

const FORM = `<input name="add-ticket" type="text" value=""><input name="add-force" type="checkbox"><input name="raise" type="text" value="1"><button data-action="add-ticket" data-repo="beta">add</button>`;

test("render keeps a typed value, a ticked box and the focused field's caret across a changed draw", () => {
  const fake = fakeWindow();
  const main = fake.live('main');
  const host = browserHost(fake.win);
  host.render('main', FORM);
  field(main, 'add-ticket').value = 'FAKE-9';
  field(main, 'add-force').checked = true;
  fake.tab();
  field(main, 'add-ticket').setSelectionRange?.(2, 4, 'forward');
  const before = field(main, 'add-ticket');
  host.render('main', `${FORM}<i>more</i>`);
  const after = field(main, 'add-ticket');
  expect(after).not.toBe(before);
  expect([after.value, field(main, 'add-force').checked, field(main, 'raise').value]).toEqual(['FAKE-9', true, '1']);
  expect(fake.focus.active).toBe(after as ElementLike);
  expect([after.selectionStart, after.selectionEnd, after.selectionDirection]).toEqual([2, 4, 'forward']);
});

test("a fresh render gives the fields the markup's values and still keeps the focus", () => {
  const fake = fakeWindow();
  const main = fake.live('main');
  const host = browserHost(fake.win);
  host.render('main', FORM);
  field(main, 'add-ticket').value = 'FAKE-9';
  field(main, 'add-force').checked = true;
  fake.tab();
  host.render('main', FORM, true);
  const after = field(main, 'add-ticket');
  expect([after.value, field(main, 'add-force').checked]).toEqual(['', false]);
  expect(fake.focus.active).toBe(after as ElementLike);
  expect([after.selectionStart, after.selectionCalls]).toEqual([0, 0]);
});

test("a select whose option is gone keeps the markup's choice, and one whose option is still there keeps the person's", () => {
  const fake = fakeWindow();
  const rail = fake.live('list');
  const host = browserHost(fake.win);
  const select = (options: string) => `<select name="stage">${options}</select>`;
  host.render('list', select('<option value="a">a</option><option value="b" selected>b</option>'));
  field(rail, 'stage').value = 'a';
  host.render(
    'list',
    select('<option value="a">a</option><option value="b" selected>b</option><option value="c">c</option>'),
  );
  expect(field(rail, 'stage').value).toBe('a');
  host.render('list', select('<option value="b">b</option><option value="c" selected>c</option>'));
  expect(field(rail, 'stage').value).toBe('c');
});

test('a focused number field keeps its value and takes no selection call that throws', () => {
  const fake = fakeWindow();
  const rail = fake.live('list');
  const host = browserHost(fake.win);
  const form = '<input name="raise" type="number" value="">';
  host.render('list', form);
  fake.tab();
  field(rail, 'raise').value = '2.5';
  expect(field(rail, 'raise').selectionStart).toBeNull();
  expect(() => host.render('list', `${form}<i>x</i>`)).not.toThrow();
  const after = field(rail, 'raise');
  expect([after.value, after.selectionCalls]).toEqual(['2.5', 0]);
  expect(fake.focus.active).toBe(after as ElementLike);
});

test('across a tick and a changed queue, the add field keeps its focus, its typed ticket key and its caret', () => {
  const m = seedFixtures();
  const fake = fakeWindow();
  const queueId = `beta/${QUEUE_WORKFLOW}`;
  let page: ReturnType<typeof boot> | undefined;
  try {
    const { dir, rest } = runningCopy(m, 1);
    const lines = rest.map((line) => JSON.parse(line));
    const start = lines.find((event) => event.type === 'stage:start' && event.key === 'implement#1');
    for (const id of REGIONS) fake.live(id);
    fake.setClock(Date.parse(start.ts) + 1000);
    page = boot(browserHost(fake.win));
    const socketOf = (part: string) => fake.sockets.find((socket) => socket.url.includes(part));
    socketOf('index=')?.onmessage?.({ data: JSON.stringify({ kind: 'index', repos: index(m.registryDir) }) });
    for (const event of [...readEvents(dir), ...lines.slice(0, lines.indexOf(start) + 1)])
      socketOf('run=')?.onmessage?.({ data: JSON.stringify({ kind: 'event', event }) });
    const queue = socketOf('queue=');
    for (const event of readEvents(queueDirOf(m)))
      queue?.onmessage?.({ data: JSON.stringify({ kind: 'queue-event', event }) });
    fake.fire('click', { target: element({ dataset: { action: 'select-queue', queue: queueId } }) });
    fake.advance(100);
    const main = fake.elements.main as ReturnType<typeof liveRegion>;
    const typed = field(main, 'add-ticket');
    for (let step = 0; step < 50 && fake.focus.active !== typed; step++) fake.tab();
    expect(fake.focus.active).toBe(typed as ElementLike);
    typed.value = 'FAKE-9';
    typed.setSelectionRange?.(3, 3);
    fake.advance(1000);
    expect(field(main, 'add-ticket')).toBe(typed);
    expect([fake.focus.active, typed.value]).toEqual([typed as ElementLike, 'FAKE-9']);

    queue?.onmessage?.({
      data: JSON.stringify({
        kind: 'queue-event',
        event: { seq: 99, ts: '2026-09-24T11:09:00.000Z', type: 'watch:removed', workflow: QUEUE_WORKFLOW },
      }),
    });
    fake.advance(100);
    const again = field(main, 'add-ticket');
    expect(again).not.toBe(typed);
    expect(fake.focus.active).toBe(again as ElementLike);
    expect([again.value, again.selectionStart, again.selectionEnd]).toEqual(['FAKE-9', 3, 3]);
    expect(main.innerHTML).toContain('not watched');
  } finally {
    page?.stop();
    m.remove();
  }
});
