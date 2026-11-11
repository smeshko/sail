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
  const windowListeners: Record<string, (() => void)[]> = {};
  const history: { kind: string; data: unknown; unused: string; url: string }[] = [];
  const location = {
    host: '127.0.0.1:4100',
    search: options.search ?? '',
    pathname: '/',
    href: 'http://127.0.0.1:4100/?repo=a',
  };
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
    location,
    addEventListener: (type, listener) => {
      windowListeners[type] = [...(windowListeners[type] ?? []), listener];
    },
    history: {
      pushState: (data, unused, url) => history.push({ kind: 'push', data, unused, url }),
      replaceState: (data, unused, url) => history.push({ kind: 'replace', data, unused, url }),
    },
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
    history,
    location,
    windowListeners,
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

test('a mouse button going down is told the region it lands in, or none, and setKeys marks the keyed pane on the root (ADW-535)', () => {
  const fake = fakeWindow();
  const row = element();
  const card = element();
  fake.elements.list = element({ contains: (other) => other === row });
  fake.elements.main = element({ contains: (other) => other === card });
  const host = browserHost(fake.win);
  const got: (string | undefined)[] = [];
  host.onPress((region) => got.push(region));
  fake.fire('mousedown', { target: row });
  fake.fire('mousedown', { target: card });
  fake.fire('mousedown', { target: element() });
  fake.fire('mousedown', { target: 'not an element' });
  expect(got).toEqual(['list', 'main', undefined, undefined]);
  host.setKeys('centre');
  expect(fake.root.dataset.keys).toBe('centre');
  host.setKeys(undefined);
  expect(fake.root.dataset.keys).toBe('none');
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
  const chords: string[] = [];
  host.onKey((key, inInput, _on, mod) => {
    if (mod === true) chords.push(key);
    else keys.push([key, inInput]);
    return false;
  });
  fake.fire('keydown', { key: 'j', target: element({ tagName: 'DIV' }) });
  fake.fire('keydown', { key: 'j', target: element({ tagName: 'INPUT' }) });
  expect(keys).toEqual([
    ['j', false],
    ['j', true],
  ]);
  // A key held with Alt is the browser's, one held with Cmd or Ctrl reaches the handler as a chord, for Cmd+K alone; a
  // letter's case is Shift's, never Caps Lock's (review R5).
  keys.length = 0;
  const div = element({ tagName: 'DIV' });
  fake.fire('keydown', { key: 'e', metaKey: true, target: div });
  fake.fire('keydown', { key: 'e', ctrlKey: true, target: div });
  fake.fire('keydown', { key: 'e', altKey: true, target: div });
  fake.fire('keydown', { key: 'E', shiftKey: false, target: div });
  fake.fire('keydown', { key: 'e', shiftKey: true, target: div });
  fake.fire('keydown', { key: 'E', shiftKey: true, target: div });
  fake.fire('keydown', { key: 'ArrowDown', shiftKey: true, target: div });
  // Alt with the up or down arrow is the page's, which moves a queue item (ADW-523); with any other key, the browser's.
  fake.fire('keydown', { key: 'ArrowUp', altKey: true, target: div });
  fake.fire('keydown', { key: 'ArrowDown', altKey: true, target: div });
  fake.fire('keydown', { key: 'ArrowLeft', altKey: true, target: div });
  expect(keys).toEqual([
    ['e', false],
    ['E', false],
    ['E', false],
    ['ArrowDown', false],
    ['Alt+ArrowUp', false],
    ['Alt+ArrowDown', false],
  ]);
  expect(chords).toEqual(['e', 'e']);
  host.setTheme('light');
  host.setInspector(false, false);
  expect(fake.root.dataset).toEqual({ theme: 'light', inspector: 'closed', pinned: 'false' });
  host.setInspector(true, true);
  expect(fake.root.dataset).toEqual({ theme: 'light', inspector: 'open', pinned: 'true' });
  host.setSidebar(true);
  expect(fake.root.dataset.sidebar).toBe('open');
  host.setSidebar(false);
  expect(fake.root.dataset.sidebar).toBe('closed');
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

/** A host over a window `width` wide, its inspector open or not, and a drag of `side`'s handle by `by` pixels. */
function columns(width: number, inspector: boolean) {
  const fake = fakeWindow();
  fake.win.innerWidth = width;
  const host = browserHost(fake.win);
  host.setInspector(inspector, false);
  const drag = (side: 'left' | 'right', by: number) => {
    fake.fire('mousedown', { target: element({ dataset: { resize: side } }), clientX: 600 });
    fake.fire('mousemove', { target: null, clientX: 600 + by });
    fake.fire('mouseup', { target: null });
  };
  const resize = (next: number) => {
    fake.win.innerWidth = next;
    for (const listener of fake.windowListeners.resize ?? []) listener();
  };
  return { fake, host, drag, resize, styles: fake.elements.body?.styles ?? {} };
}

test('from 1100px a drag stops where the centre keeps its 320px floor beside the other column and both handles (ADW-536)', () => {
  // 1120 - (180 sidebar + 5) - 5 - 320: a 640px inspector drag stops at 610px.
  const inspector = columns(1120, true);
  inspector.drag('right', -280);
  expect(inspector.styles['--ins-w']).toBe('610px');
  // 1120 - (360 inspector + 5) - 5 - 320: a 480px sidebar drag stops at 430px.
  const sidebar = columns(1120, true);
  sidebar.drag('left', 300);
  expect(sidebar.styles['--side-w']).toBe('430px');
  // At 1280px the default sidebar leaves the inspector its whole 640px.
  const wide = columns(1280, true);
  wide.drag('right', -400);
  expect(wide.styles['--ins-w']).toBe('640px');
});

test('a closed inspector, or one under 1100px that lies over the centre, takes no room from the sidebar, and its own drag keeps its fixed maximum (ADW-536)', () => {
  // 1120 - 5 - 320 leaves the sidebar its whole 480px.
  const closed = columns(1120, false);
  closed.drag('left', 300);
  expect(closed.styles['--side-w']).toBe('480px');
  // At 820px the open inspector is no column: the sidebar gets 820 - 5 - 320 = 495, so its 480px, and the inspector 640.
  const under = columns(820, true);
  under.drag('left', 300);
  under.drag('right', -400);
  expect([under.styles['--side-w'], under.styles['--ins-w']]).toEqual(['480px', '640px']);
  // 805 - 325 is still 480; at 804 the sidebar's clamp alone takes it to 479.
  under.resize(805);
  expect(under.styles['--side-w']).toBe('480px');
  under.resize(804);
  expect(under.styles['--side-w']).toBe('479px');
  // Under 800px the sidebar is no column either, and a resize leaves both widths.
  under.resize(600);
  expect([under.styles['--side-w'], under.styles['--ins-w']]).toEqual(['479px', '640px']);
});

test('narrowing the window after a drag clamps the dragged widths again, the inspector first, and an inspector that opens fits beside a wide sidebar (ADW-536)', () => {
  const { drag, resize, styles } = columns(1600, true);
  drag('left', 300);
  drag('right', -400);
  expect([styles['--side-w'], styles['--ins-w']]).toEqual(['480px', '640px']);
  // The inspector first: 1300 - 485 - 5 - 320 = 490, and the sidebar keeps 480 beside it. The sidebar first would have
  // given 1300 - 645 - 5 - 320 = 330 and left the inspector 635.
  resize(1300);
  expect([styles['--side-w'], styles['--ins-w']]).toEqual(['480px', '490px']);
  // At 1100 the inspector gives way to 1100 - 485 - 5 - 320 = 290, and the sidebar keeps 480.
  resize(1100);
  expect([styles['--side-w'], styles['--ins-w']]).toEqual(['480px', '290px']);
  // Widening again restores nothing: the widths are what the clamp left.
  resize(1600);
  expect([styles['--side-w'], styles['--ins-w']]).toEqual(['480px', '290px']);
  // A sidebar dragged wide beside a closed inspector: the inspector opening at 1120 takes 1120 - 485 - 5 - 320 = 310.
  const opening = columns(1120, false);
  opening.drag('left', 300);
  opening.host.setInspector(true, false);
  opening.drag('right', -400);
  expect([opening.styles['--side-w'], opening.styles['--ins-w']]).toEqual(['480px', '310px']);
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

test('openLink opens the URL in a new tab with no opener or referrer, and a window that cannot open does nothing', () => {
  const fake = fakeWindow();
  const opened: string[][] = [];
  browserHost({ ...fake.win, open: (...args: string[]) => opened.push(args) }).openLink('https://code.test/pull/5');
  expect(opened).toEqual([['https://code.test/pull/5', '_blank', 'noopener,noreferrer']]);
  expect(() => browserHost(fake.win).openLink('https://code.test/pull/5')).not.toThrow();
});

describe('Enter and Space on a focused control', () => {
  const setup = () => {
    const fake = fakeWindow();
    const host = browserHost(fake.win);
    const actions: [string, Record<string, string>][] = [];
    const keys: [string, boolean][] = [];
    host.onAction((action, data) => actions.push([action, data]));
    host.onKey((key, inInput) => {
      keys.push([key, inInput]);
      return false;
    });
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

  const addForm = (found: boolean, tick = false) => {
    const button = element({
      tagName: 'BUTTON',
      dataset: { action: 'add-ticket', repo: 'beta', workflow: 'ticket-to-pr' },
    });
    const parent = element({
      tagName: 'DIV',
      dataset: { enter: 'add-ticket' },
      querySelector: (selectors: string) => (found && selectors === '[data-action="add-ticket"]' ? button : null),
    });
    return element({ tagName: 'INPUT', type: tick ? 'checkbox' : 'text', parentElement: parent });
  };

  test("Enter in the add field delivers the add button's action with its repo and workflow, stops the default and reaches no key handler", () => {
    const { actions, keys, press } = setup();
    expect(press('Enter', addForm(true))).toBe(1);
    expect(actions).toEqual([['add-ticket', { action: 'add-ticket', repo: 'beta', workflow: 'ticket-to-pr' }]]);
    expect(keys).toEqual([]);
  });

  test('a tickbox under the add form, a letter in its field and an add form with no button deliver no action', () => {
    const { actions, keys, press } = setup();
    press('Enter', addForm(true, true));
    press('a', addForm(true));
    press('Enter', addForm(false));
    expect(actions).toEqual([]);
    expect(keys).toEqual([
      ['Enter', true],
      ['a', true],
      ['Enter', true],
    ]);
  });
});

const row = (run: string) => `<button data-action="select-run" data-repo="alpha" data-run="${run}">${run}</button>`;

describe('audit 2: rows say what they are (ADW-543)', () => {
  const subjectRow = (run: string) =>
    `<button data-action="select-run" data-subject="run" data-repo="alpha" data-run="${run}">${run}</button>`;

  test("the focus reaching a row by Tab is told as focus with the row's data, and the focus a redraw gives back is not", () => {
    const fake = fakeWindow();
    fake.live('list');
    const host = browserHost(fake.win);
    const seen: [string, Record<string, string> | undefined][] = [];
    host.onPoint((kind, data) => {
      seen.push([kind, data]);
    });
    // A browser fires focusin each time an element takes the focus, the page's own focus() included.
    let active = fake.focus.active;
    Object.defineProperty(fake.focus, 'active', {
      get: () => active,
      set: (next: ElementLike | null) => {
        active = next;
        if (next !== null) fake.fire('focusin', { target: next });
      },
    });
    host.render('list', `${subjectRow('r1')}${subjectRow('r2')}`);
    fake.tab();
    fake.tab();
    const told = (run: string): [string, Record<string, string>] => [
      'focus',
      { action: 'select-run', subject: 'run', repo: 'alpha', run },
    ];
    expect(seen).toEqual([told('r1'), told('r2')]);
    host.render('list', `${subjectRow('r1')}${subjectRow('r2')}<span>more</span>`);
    expect(fake.focus.active?.dataset.run).toBe('r2');
    expect(seen).toEqual([told('r1'), told('r2')]);
    fake.fire('focusin', { target: element() });
    expect(seen.at(-1)).toEqual(['focus', undefined]);
  });
});

test('render puts the focus back on the element with the same data-action and data, a new element, so Tab goes on from it', () => {
  const fake = fakeWindow();
  const listed = fake.live('list');
  const host = browserHost(fake.win);
  host.render('list', `${row('r1')}${row('r2')}${row('r3')}`);
  fake.tab();
  fake.tab();
  const before = fake.focus.active;
  host.render('list', `${row('r1')}${row('r2')}${row('r3')}<span>more</span>`);
  expect(fake.focus.active).not.toBe(before);
  expect(fake.focus.active).toBe(listed.els[1] as ElementLike);
  expect(fake.focus.active?.dataset).toEqual({ action: 'select-run', repo: 'alpha', run: 'r2' });
  expect(fake.focus.calls).toEqual([{ preventScroll: true }]);
  fake.tab();
  expect(fake.focus.active).toBe(listed.els[2] as ElementLike);
});

test('a key reaches the handler with the data-action of the element it landed on', () => {
  const fake = fakeWindow();
  const host = browserHost(fake.win);
  const got: (string | undefined)[] = [];
  host.onKey((_, __, on) => {
    got.push(on);
    return false;
  });
  fake.fire('keydown', { key: 'j', target: element({ tagName: 'BUTTON', dataset: { action: 'dialog-cancel' } }) });
  fake.fire('keydown', { key: 'j', target: element({ tagName: 'BODY' }) });
  expect(got).toEqual(['dialog-cancel', undefined]);
});

describe('the confirmation dialog', () => {
  const dialogWindow = () => {
    const fake = fakeWindow();
    const calls: string[] = [];
    fake.elements.dialog = element({
      showModal: () => calls.push('showModal'),
      close: () => calls.push('close'),
    });
    const list = fake.live('list');
    return { fake, calls, list, host: browserHost(fake.win) };
  };

  /** A live `#dialog`, which shows modally and closes as a browser's does. */
  const liveDialog = () => {
    const fake = fakeWindow();
    /** A `[name="x"]` lookup over a live region's fields, as a browser answers it. */
    const named = (region: ReturnType<typeof liveRegion>) => {
      region.querySelector = (selectors: string) => {
        const match = /^\[name="([^"]*)"\]$/.exec(selectors);
        return match === null ? null : (region.els.find((el) => el.attributes.name === match[1]) ?? null);
      };
      return region;
    };
    const dialog = named(fake.live('dialog'));
    dialog.showModal = () => {};
    dialog.close = () => {};
    const list = named(fake.live('list'));
    return { fake, dialog, list, host: browserHost(fake.win) };
  };

  test('dialogValue reads a field of #dialog alone', () => {
    const { dialog, list, host } = liveDialog();
    host.render('list', '<input name="raise" value="from the list">');
    expect(host.dialogValue('raise')).toBeUndefined();
    host.openDialog('<input class="num" type="number" name="raise" value="5">');
    expect(host.dialogValue('raise')).toBe('5');
    expect(host.dialogValue('stage')).toBeUndefined();
    (dialog.els[0] as ElementLike).value = '7';
    expect(host.dialogValue('raise')).toBe('7');
    expect(list.els[0]?.value).toBe('from the list');
  });

  test('redrawDialog keeps the typed value and the focus', () => {
    const { fake, dialog, host } = liveDialog();
    host.openDialog('<ul><li>one</li></ul><input type="text" name="raise" value=""><button>x</button>');
    const typed = dialog.els[0] as ElementLike;
    typed.value = '12.5';
    typed.focus?.();
    host.redrawDialog('<ul><li>two</li></ul><input type="text" name="raise" value=""><button>x</button>');
    expect(dialog.innerHTML).toContain('<li>two</li>');
    expect(host.dialogValue('raise')).toBe('12.5');
    expect(fake.focus.active).toBe(dialog.els[0] as ElementLike);
  });

  test('redrawDialog draws #dialog-body alone, so the confirm button a mousedown pressed is still there at its click', () => {
    const { fake, dialog, host } = liveDialog();
    const body = fake.live('dialog-body');
    host.openDialog(
      '<div id="dialog-body"><ul><li>one</li></ul><input class="num" type="number" name="raise" value=""></div><div class="dlg-acts"><button class="btn primary" data-action="dialog-confirm">resume</button></div>',
    );
    body.innerHTML = '<ul><li>one</li></ul><input class="num" type="number" name="raise" value="">';
    const confirm = dialog.els.find((el) => el.dataset.action === 'dialog-confirm');
    host.redrawDialog(
      '<ul><li>raises the budget by $5.00</li></ul><input class="num" type="number" name="raise" value="">',
    );
    expect(body.innerHTML).toContain('<li>raises the budget by $5.00</li>');
    expect(confirm).toBeDefined();
    expect(dialog.els).toContain(confirm as LiveElement);
  });

  test('a change inside #dialog is the action dialog-change', () => {
    const { fake, dialog, list, host } = liveDialog();
    const got: [string, Record<string, string>][] = [];
    host.onAction((action, data) => got.push([action, data]));
    host.openDialog('<select name="stage"><option value="a">a</option></select>');
    host.render('list', '<select name="other"><option value="a">a</option></select>');
    fake.fire('change', { target: list.els[0] as ElementLike });
    expect(got).toEqual([]);
    fake.fire('change', { target: dialog.els[0] as ElementLike });
    expect(got).toEqual([['dialog-change', {}]]);
  });

  test('openDialog writes its markup into #dialog and calls showModal', () => {
    const { fake, calls, host } = dialogWindow();
    host.openDialog('<h2 id="dialog-title">clean R1</h2>');
    expect([fake.elements.dialog?.innerHTML, calls]).toEqual(['<h2 id="dialog-title">clean R1</h2>', ['showModal']]);
  });

  test('closeDialog calls close and focuses the element that had the focus at the open, after its region was redrawn', () => {
    const { fake, calls, list, host } = dialogWindow();
    host.render('list', `${row('r1')}${row('r2')}`);
    fake.tab();
    fake.tab();
    expect((fake.focus.active as ElementLike | null)?.dataset.run).toBe('r2');
    host.openDialog('<button data-action="dialog-confirm">drop</button>');
    // The dialog takes the focus, and the region behind it is redrawn: its opener is a new element.
    fake.focus.active = null;
    host.render('list', `${row('r1')}${row('r2')}<span>more</span>`);
    fake.focus.calls.length = 0;
    host.closeDialog();
    expect(calls).toEqual(['showModal', 'close']);
    expect(fake.focus.active as ElementLike | null).toBe(list.els[1] as ElementLike);
    expect((fake.focus.active as ElementLike | null)?.dataset).toEqual({
      action: 'select-run',
      repo: 'alpha',
      run: 'r2',
    });
    expect(fake.focus.calls).toEqual([{ preventScroll: true }]);
  });

  test('a close the browser makes itself cancels the dialog, and the close closeDialog makes, or one after a reopen, does not', () => {
    const { fake, host } = dialogWindow();
    const got: string[] = [];
    host.onAction((action) => got.push(action));
    const dialog = fake.elements.dialog as ElementLike;
    host.openDialog('x');
    // The platform closes the modal (a close request no keydown reports): the dialog is no longer open.
    dialog.open = false;
    dialog.onclose?.();
    expect(got).toEqual(['dialog-cancel']);
    host.openDialog('y');
    host.closeDialog();
    dialog.onclose?.();
    host.openDialog('z');
    // A close event that arrives once the dialog is open again is the earlier close's.
    dialog.open = true;
    dialog.onclose?.();
    expect(got).toEqual(['dialog-cancel']);
  });

  test('closeDialog with nothing focused at the open closes and focuses nothing, and with no #dialog does nothing', () => {
    const { fake, calls, host } = dialogWindow();
    host.openDialog('x');
    host.closeDialog();
    expect([calls, fake.focus.calls]).toEqual([['showModal', 'close'], []]);
    const bare = fakeWindow();
    const bareHost = browserHost(bare.win);
    expect(bareHost.openDialog('x')).toBeUndefined();
    expect(bareHost.closeDialog()).toBeUndefined();
  });
});

test("of two elements with one key, the one at the focused one's place is focused, and the last when one is gone", () => {
  const fake = fakeWindow();
  const listed = fake.live('list');
  const host = browserHost(fake.win);
  const twin = (label: string) => `<button data-action="select-queue" data-queue="b/w">${label}</button>`;
  host.render('list', `${row('r1')}${twin('row')}${twin('badge')}`);
  fake.tab();
  fake.tab();
  fake.tab();
  expect(fake.focus.active).toBe(listed.els[2] as ElementLike);
  host.render('list', `${row('r1')}${twin('row')}${twin('badge')}<i>x</i>`);
  expect(fake.focus.active).toBe(listed.els[2] as ElementLike);
  host.render('list', `${row('r1')}${twin('row')}`);
  expect(fake.focus.active).toBe(listed.els[1] as ElementLike);
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
    const listed = fake.elements.list as ReturnType<typeof liveRegion>;
    const rows = listed.els.filter((el) => el.focusable);
    const at = Math.min(5, rows.length - 2);
    expect(at).toBeGreaterThan(0);
    // The sidebar comes first in the page, so its focusable elements are tabbed past.
    const beforeList = (fake.elements.sidebar as ReturnType<typeof liveRegion>).els.filter((el) => el.focusable).length;
    for (let step = 0; step < beforeList + at + 1; step++) fake.tab();
    const focused = fake.focus.active as ElementLike;
    expect(focused).toBe(rows[at] as ElementLike);
    fake.advance(1000);
    const after = listed.els.filter((el) => el.focusable);
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
  const listed = fake.live('list');
  const host = browserHost(fake.win);
  const select = (options: string) => `<select name="stage">${options}</select>`;
  host.render('list', select('<option value="a">a</option><option value="b" selected>b</option>'));
  field(listed, 'stage').value = 'a';
  host.render(
    'list',
    select('<option value="a">a</option><option value="b" selected>b</option><option value="c">c</option>'),
  );
  expect(field(listed, 'stage').value).toBe('a');
  host.render('list', select('<option value="b">b</option><option value="c" selected>c</option>'));
  expect(field(listed, 'stage').value).toBe('c');
});

test('a focused number field keeps its value and takes no selection call that throws', () => {
  const fake = fakeWindow();
  const listed = fake.live('list');
  const host = browserHost(fake.win);
  const form = '<input name="raise" type="number" value="">';
  host.render('list', form);
  fake.tab();
  field(listed, 'raise').value = '2.5';
  expect(field(listed, 'raise').selectionStart).toBeNull();
  expect(() => host.render('list', `${form}<i>x</i>`)).not.toThrow();
  const after = field(listed, 'raise');
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
    const repos = index(m.registryDir).map((repo) => ({
      ...repo,
      queues: repo.queues.map((view) => ({ ...view, watch: { state: 'watched' as const } })),
    }));
    socketOf('index=')?.onmessage?.({ data: JSON.stringify({ kind: 'index', repos }) });
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
    expect(main.innerHTML).toContain('<span class="pill p-pass">watched</span>');
  } finally {
    page?.stop();
    m.remove();
  }
});

describe('the list host members (ADW-522)', () => {
  test('onInput tells the handler the name and value of the named field typed into, and nothing for an element with no name', () => {
    const fake = fakeWindow();
    const host = browserHost(fake.win);
    const typed: [string, string][] = [];
    host.onInput((name, value) => typed.push([name, value]));
    fake.fire('input', { target: element({ name: 'list-filter', value: 'pars', tagName: 'INPUT' }) });
    fake.fire('input', { target: element({ tagName: 'DIV' }) });
    fake.fire('input', { target: null });
    fake.fire('input', { target: element({ name: 'raise', tagName: 'INPUT' }) });
    expect(typed).toEqual([
      ['list-filter', 'pars'],
      ['raise', ''],
    ]);
  });

  test('focus focuses the field of that name in whichever region holds it, and does nothing for a name no region holds', () => {
    const fake = fakeWindow();
    const field = element({ name: 'list-filter', focus: () => void focused.push('list-filter') });
    const focused: string[] = [];
    fake.elements.list = element({
      querySelector: (selectors: string) => (selectors === '[name="list-filter"]' ? field : null),
    });
    const host = browserHost(fake.win);
    host.focus('list-filter');
    host.focus('nothing');
    expect(focused).toEqual(['list-filter']);
  });

  test('blur takes the focus off the focused element, and does nothing when none has it', () => {
    const fake = fakeWindow();
    const host = browserHost(fake.win);
    expect(() => host.blur()).not.toThrow();
    const blurred: string[] = [];
    fake.focus.active = element({ blur: () => void blurred.push('blurred') });
    host.blur();
    expect(blurred).toEqual(['blurred']);
  });

  test("reveal scrolls the region's cursor element into view, as little as it takes, and does nothing without one", () => {
    const fake = fakeWindow();
    const scrolled: unknown[] = [];
    const cur = element({ scrollIntoView: (options) => void scrolled.push(options) });
    fake.elements.list = element({ querySelector: (selectors: string) => (selectors === '.cur' ? cur : null) });
    fake.elements.status = element({ querySelector: () => null });
    const host = browserHost(fake.win);
    host.reveal('list');
    host.reveal('status');
    host.reveal('main');
    expect(scrolled).toEqual([{ block: 'nearest' }]);
  });

  test("reveal('list', 'sel') scrolls the selected row, not the cursor's", () => {
    const fake = fakeWindow();
    const scrolled: string[] = [];
    const cur = element({ scrollIntoView: () => void scrolled.push('cur') });
    const sel = element({ scrollIntoView: (options) => void scrolled.push(`sel ${JSON.stringify(options)}`) });
    fake.elements.list = element({
      querySelector: (selectors: string) => (selectors === '.cur' ? cur : selectors === '[data-row].sel' ? sel : null),
    });
    const host = browserHost(fake.win);
    host.reveal('list', 'sel');
    expect(scrolled).toEqual(['sel {"block":"nearest"}']);
  });

  test('a key whose handler answers true has its default suppressed, and one answered false does not', () => {
    const fake = fakeWindow();
    const host = browserHost(fake.win);
    host.onKey((key) => key === '/');
    const prevented: string[] = [];
    for (const key of ['/', 'j'])
      fake.fire('keydown', {
        key,
        target: element({ tagName: 'BODY' }),
        preventDefault: () => void prevented.push(key),
      });
    expect(prevented).toEqual(['/']);
  });
});

test('setUrl pushes or replaces the history entry with the query, and writes the path for an empty one', () => {
  const fake = fakeWindow();
  const host = browserHost(fake.win);
  host.setUrl('repo=a&run=b', true);
  host.setUrl('repo=a', false);
  host.setUrl('', false);
  expect(fake.history).toEqual([
    { kind: 'push', data: null, unused: '', url: '?repo=a&run=b' },
    { kind: 'replace', data: null, unused: '', url: '?repo=a' },
    { kind: 'replace', data: null, unused: '', url: '/' },
  ]);
});

test("href is the window's whole URL", () => {
  expect(browserHost(fakeWindow().win).href()).toBe('http://127.0.0.1:4100/?repo=a');
});

test('onNavigate calls the handler with the query of a popstate, parsed as start() parses it', () => {
  const fake = fakeWindow({ search: '?repo=beta' });
  const asked: Record<string, string>[] = [];
  browserHost(fake.win).onNavigate((query) => asked.push(query));
  fake.location.search = '?repo=alpha&run=r';
  for (const listener of fake.windowListeners.popstate ?? []) listener();
  expect(asked).toEqual([{ repo: 'alpha', run: 'r' }]);
});

test('a mouseover is delegated to the nearest data-subject, and one outside any gives none', () => {
  const fake = fakeWindow();
  const host = browserHost(fake.win);
  const seen: [string, Record<string, string> | undefined, { x: number; y: number }][] = [];
  host.onPoint((kind, data, point) => {
    seen.push([kind, data, point]);
  });
  const row = element({ dataset: { subject: 'item', repo: 'beta', item: 'ticket:FAKE-5' } });
  const child = element({ dataset: { action: 'x' }, parentElement: row });
  fake.fire('mouseover', { target: child, clientX: 12, clientY: 34 });
  fake.fire('mouseover', { target: element() });
  expect(seen).toEqual([
    ['hover', { subject: 'item', repo: 'beta', item: 'ticket:FAKE-5' }, { x: 12, y: 34 }],
    ['hover', undefined, { x: 0, y: 0 }],
  ]);
});

test('a key reaches the handler with whether Cmd or Ctrl is held, and a handled key default is prevented', () => {
  const fake = fakeWindow();
  const host = browserHost(fake.win);
  const seen: [string, boolean | undefined][] = [];
  host.onKey((key, _inInput, _on, mod) => {
    seen.push([key, mod]);
    return key === 'k' && mod === true;
  });
  let prevented = 0;
  const target = element({ tagName: 'DIV' });
  fake.fire('keydown', { key: 'k', metaKey: true, target, preventDefault: () => prevented++ });
  fake.fire('keydown', { key: 'k', ctrlKey: true, target, preventDefault: () => prevented++ });
  fake.fire('keydown', { key: 'k', target, preventDefault: () => prevented++ });
  expect(seen).toEqual([
    ['k', true],
    ['k', true],
    ['k', false],
  ]);
  expect(prevented).toBe(2);
});

test('an input event reaches the handler with the field name and value, and focusMenu focuses the menu field, else the menu', () => {
  const fake = fakeWindow();
  const host = browserHost(fake.win);
  const typed: [string, string][] = [];
  host.onInput((name, value) => typed.push([name, value]));
  fake.fire('input', { target: element({ name: 'menu-query', value: 'res' }) });
  fake.fire('input', { target: element({ value: 'unnamed' }) });
  expect(typed).toEqual([['menu-query', 'res']]);
  const menu = element();
  const field = element({ focus: () => void focused.push('field') });
  const box = element({ focus: () => void focused.push('box') });
  const focused: string[] = [];
  let withField = true;
  menu.querySelector = (selector) => (selector.includes('menu-query') ? (withField ? field : null) : box);
  fake.elements.menu = menu;
  host.focusMenu();
  withField = false;
  host.focusMenu();
  expect(focused).toEqual(['field', 'box']);
});

test('a contextmenu on a row reaches the handler with its data and point, and is prevented only when handled', () => {
  const fake = fakeWindow();
  const host = browserHost(fake.win);
  const seen: [string, Record<string, string> | undefined, { x: number; y: number }][] = [];
  let take = true;
  host.onPoint((kind, data, point) => {
    seen.push([kind, data, point]);
    return kind === 'context' && take;
  });
  let prevented = 0;
  const row = element({ dataset: { subject: 'item', repo: 'beta', item: 'ticket:FAKE-5' } });
  const child = element({ parentElement: row });
  fake.fire('contextmenu', { target: child, clientX: 40, clientY: 50, preventDefault: () => prevented++ });
  take = false;
  fake.fire('contextmenu', { target: child, clientX: 1, clientY: 2, preventDefault: () => prevented++ });
  fake.fire('contextmenu', { target: element(), preventDefault: () => prevented++ });
  expect(seen).toEqual([
    ['context', { subject: 'item', repo: 'beta', item: 'ticket:FAKE-5' }, { x: 40, y: 50 }],
    ['context', { subject: 'item', repo: 'beta', item: 'ticket:FAKE-5' }, { x: 1, y: 2 }],
    ['context', undefined, { x: 0, y: 0 }],
  ]);
  expect(prevented).toBe(1);
});

test('narrow() asks the window whether it is under 800px, and a window without matchMedia reads as wide', () => {
  const asked: string[] = [];
  const media = (matches: boolean) => ({
    ...fakeWindow().win,
    matchMedia: (query: string) => {
      asked.push(query);
      return { matches };
    },
  });
  expect(browserHost(media(true)).narrow()).toBe(true);
  expect(browserHost(media(false)).narrow()).toBe(false);
  expect(asked).toEqual(['(max-width: 799px)', '(max-width: 799px)']);
  expect(browserHost(fakeWindow().win).narrow()).toBe(false);
});
