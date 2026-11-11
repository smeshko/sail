// What the page needs from a browser, as one interface: regions to render into, delegated actions and keys, reads with
// the client header, the POSTs (a queue move, a resume, a restart), sockets, timers, storage and the clipboard. `boot()` takes a `PageHost`, so the whole shell runs
// in a test against a fake one, and `browserHost()` adapts a real window to it. The window is typed here, by the few
// members the page uses, since the project's TypeScript has no DOM library.

/** The page's regions, each an element id in `index.html`. */
export const REGIONS = ['rail', 'attention', 'main', 'inspector', 'status', 'drawer'] as const;
export type Region = (typeof REGIONS)[number];

export interface Connection {
  close(): void;
}

export interface ConnectHandlers {
  message(text: string): void;
  /** The socket closed, from either side. Called once. */
  close(): void;
}

export interface PageHost {
  /**
   * Draws `html` into `region`, keeping the scroll of each `data-scroll` box that is still there, the focus, by the
   * focus key of the focused element (its name, else its `data-action` and data, else its href), the value or tick of
   * each named field and the focused field's caret. `fresh` drops the values and the caret: the fields take the
   * markup's, and the focus is still kept.
   */
  render(region: Region, html: string, fresh?: boolean): void;
  /** Scrolls what holds `region` to its end. */
  scrollToEnd(region: Region): void;
  onAction(handler: (action: string, data: Record<string, string>) => void): void;
  onKey(handler: (key: string, inInput: boolean) => void): void;
  /** A GET of `path` on the dashboard, with the client header. A failed request answers status 0. */
  get(path: string): Promise<{ status: number; body: string }>;
  /** A POST of `body` as JSON to `path`, with the client header. A failed request answers status 0. */
  post(path: string, body: unknown): Promise<{ status: number; body: string }>;
  /** The current value of the field named `name`, in whichever region draws it, or undefined when none does. A checkbox is 'on' while ticked and '' while not. */
  value(name: string): string | undefined;
  /** A WebSocket on `/ws?<query>`. */
  connect(query: string, handlers: ConnectHandlers): Connection;
  now(): number;
  later(fn: () => void, ms: number): number;
  cancel(id: number): void;
  /** `localStorage`'s value, or undefined, also when storage throws. */
  load(key: string): string | undefined;
  /** Saves to `localStorage`, ignoring storage that throws. */
  save(key: string, value: string): void;
  /** Copies to the clipboard: false when it can't. */
  copy(text: string): Promise<boolean>;
  setTheme(theme: string): void;
  setInspector(open: boolean): void;
  /** The browser's offset east of UTC, in minutes. */
  offset(): number;
  /** What the page's URL asks it to open first, from `?repo=…&run=…&key=…&tab=…&timeline=1&file=…` or `?queue=…`: empty when it asks nothing. */
  start(): Record<string, string>;
  /** Writes the page's URL to `?query` (the path alone for an empty one), as a new history entry when `push`, else in place of the current one. */
  setUrl(query: string, push: boolean): void;
}

/** The members of an element the page uses. */
export interface ElementLike {
  innerHTML: string;
  value?: string;
  /** For a checkbox. */
  checked?: boolean;
  type?: string;
  scrollTop?: number;
  scrollHeight?: number;
  dataset: Record<string, string | undefined>;
  parentElement: ElementLike | null;
  tagName?: string;
  name?: string;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  selectionDirection?: string | null;
  setSelectionRange?(start: number, end: number, direction?: string): void;
  contains?(other: ElementLike): boolean;
  focus?(options?: { preventScroll?: boolean }): void;
  getAttribute?(name: string): string | null;
  querySelectorAll?(selectors: string): ArrayLike<ElementLike>;
  querySelector?(selectors: string): ElementLike | null;
  style?: { setProperty(name: string, value: string): void };
}

export interface EventLike {
  target: unknown;
  key?: string;
  clientX?: number;
  preventDefault?(): void;
}

export interface SocketLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  close(): void;
}

/** The members of a window the page uses. */
export interface BrowserWindow {
  document: {
    getElementById(id: string): ElementLike | null;
    addEventListener(type: string, listener: (event: EventLike) => void): void;
    removeEventListener(type: string, listener: (event: EventLike) => void): void;
    documentElement: { dataset: Record<string, string | undefined> };
    activeElement?: ElementLike | null;
  };
  location: { host: string; search: string; pathname: string };
  history: {
    pushState(data: unknown, unused: string, url: string): void;
    replaceState(data: unknown, unused: string, url: string): void;
  };
  fetch(
    url: string,
    init: { headers: Record<string, string>; method?: string; body?: string },
  ): Promise<{ status: number; text(): Promise<string> }>;
  WebSocket: new (url: string) => SocketLike;
  localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  navigator: { clipboard?: { writeText(text: string): Promise<void> } };
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  Date: { new (): { getTimezoneOffset(): number }; now(): number };
}

const isElement = (value: unknown): value is ElementLike =>
  typeof value === 'object' && value !== null && 'dataset' in value;

/** The element `target` is, or the nearest one holding it, with a `data-action`. */
function actionOf(target: unknown): ElementLike | undefined {
  for (let at = isElement(target) ? target : null; at !== null; at = at.parentElement) {
    if (at.dataset.action !== undefined) return at;
  }
  return undefined;
}

/** The elements a person can focus, and the ones a focus key is derived from. */
const FOCUSABLE = '[name], [data-action], a[href]';

/**
 * What identifies a focusable element across a redraw, from what its markup carries: its `name`, else its `data-action`
 * with its other `data-*` values, else its `href`. An element with none has no key, and its focus is not restored.
 */
function focusKey(element: ElementLike): string | undefined {
  if (element.name !== undefined && element.name !== '') return `name=${element.name}`;
  if (element.dataset.action !== undefined) {
    const entries = Object.entries(element.dataset)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `action=${JSON.stringify(entries)}`;
  }
  const href = element.getAttribute?.('href');
  return href === null || href === undefined ? undefined : `href=${href}`;
}

const isTick = (field: ElementLike) => field.type === 'checkbox' || field.type === 'radio';

/** What a named field held: its tick or its value, and the place among the fields of its name. */
interface Held {
  name: string;
  place: number;
  checked?: boolean;
  value?: string | undefined;
}

/** The named fields of `root`, each with its name's counter as its place. */
function namedFields(root: ElementLike): { field: ElementLike; name: string; place: number }[] {
  const seen = new Map<string, number>();
  const out: { field: ElementLike; name: string; place: number }[] = [];
  for (const field of Array.from(root.querySelectorAll?.('[name]') ?? [])) {
    const name = field.name;
    if (name === undefined || name === '') continue;
    const place = seen.get(name) ?? 0;
    seen.set(name, place + 1);
    out.push({ field, name, place });
  }
  return out;
}

/** The focusable elements of `root` with `key`, in document order. */
const keyed = (root: ElementLike, key: string) =>
  Array.from(root.querySelectorAll?.(FOCUSABLE) ?? []).filter((element) => focusKey(element) === key);

const INPUTS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** How wide each resizable column may be, and its CSS variable. */
const COLUMNS: Record<string, { variable: string; min: number; max: number; start: number; sign: number }> = {
  left: { variable: '--rail-w', min: 160, max: 480, start: 260, sign: 1 },
  right: { variable: '--ins-w', min: 240, max: 640, start: 360, sign: -1 },
};

/** Drags the column of a `data-resize` handle, which sets its CSS variable on `#body`. */
function installResize(win: BrowserWindow): void {
  const doc = win.document;
  const widths: Record<string, number> = { left: COLUMNS.left?.start ?? 0, right: COLUMNS.right?.start ?? 0 };
  doc.addEventListener('mousedown', (down) => {
    const side = isElement(down.target) ? down.target.dataset.resize : undefined;
    const column = side === undefined ? undefined : COLUMNS[side];
    if (side === undefined || column === undefined) return;
    down.preventDefault?.();
    const from = down.clientX ?? 0;
    const start = widths[side] ?? column.start;
    const move = (event: EventLike) => {
      const width = Math.max(column.min, Math.min(column.max, start + column.sign * ((event.clientX ?? from) - from)));
      widths[side] = width;
      doc.getElementById('body')?.style?.setProperty(column.variable, `${width}px`);
    };
    const up = () => {
      doc.removeEventListener('mousemove', move);
      doc.removeEventListener('mouseup', up);
    };
    doc.addEventListener('mousemove', move);
    doc.addEventListener('mouseup', up);
  });
}

/** A real window as a `PageHost`. */
export function browserHost(win: BrowserWindow): PageHost {
  const doc = win.document;
  installResize(win);
  let onAction: (action: string, data: Record<string, string>) => void = () => {};
  /** Delivers `element`'s action with its data, as a click on it would. */
  const fire = (element: ElementLike) => {
    const data: Record<string, string> = {};
    for (const [name, value] of Object.entries(element.dataset)) if (value !== undefined) data[name] = value;
    onAction(data.action ?? '', data);
  };
  return {
    render(region, markup, fresh = false) {
      const element = doc.getElementById(region);
      if (element === null) return;
      // The focus: the key of the focused element of this region, and its place among the ones with that key.
      let focused: { key: string; place: number } | undefined;
      const active = doc.activeElement;
      if (active !== null && active !== undefined && element.contains?.(active) === true) {
        const key = focusKey(active);
        const place = key === undefined ? -1 : keyed(element, key).indexOf(active);
        if (key !== undefined && place >= 0) focused = { key, place };
      }
      // The fields: what each held, and the focused one's selection.
      const held: Held[] = [];
      let selection: { start: number | null; end: number | null; direction: string | null } | undefined;
      if (!fresh) {
        for (const { field, name, place } of namedFields(element)) {
          held.push(
            isTick(field) ? { name, place, checked: field.checked === true } : { name, place, value: field.value },
          );
        }
        if (focused !== undefined && active !== null && active !== undefined && active.name !== undefined)
          selection = {
            start: active.selectionStart ?? null,
            end: active.selectionEnd ?? null,
            direction: active.selectionDirection ?? null,
          };
      }
      const scrolled = new Map<string, number>();
      for (const box of Array.from(element.querySelectorAll?.('[data-scroll]') ?? [])) {
        const key = box.dataset.scroll;
        if (key !== undefined && (box.scrollTop ?? 0) > 0) scrolled.set(key, box.scrollTop ?? 0);
      }
      element.innerHTML = markup;
      if (scrolled.size > 0) {
        for (const box of Array.from(element.querySelectorAll?.('[data-scroll]') ?? [])) {
          const offset = scrolled.get(box.dataset.scroll ?? '');
          if (offset !== undefined) box.scrollTop = offset;
        }
      }
      if (held.length > 0) {
        const fields = namedFields(element);
        for (const keep of held) {
          const target = fields.find((entry) => entry.name === keep.name && entry.place === keep.place)?.field;
          if (target === undefined) continue;
          if (keep.checked !== undefined) target.checked = keep.checked;
          else if (keep.value !== undefined) {
            // A value that didn't take, a select without that option, leaves the markup's choice.
            const given = target.value;
            target.value = keep.value;
            if (target.value !== keep.value && given !== undefined) target.value = given;
          }
        }
      }
      if (focused !== undefined) {
        const found = keyed(element, focused.key);
        const target = found[Math.min(focused.place, found.length - 1)];
        target?.focus?.({ preventScroll: true });
        if (target !== undefined && selection !== undefined) {
          if (typeof selection.start === 'number' && typeof selection.end === 'number') {
            try {
              target.setSelectionRange?.(selection.start, selection.end, selection.direction ?? undefined);
            } catch {
              // A field with no selection leaves its caret where the assignment put it.
            }
          } else if (selection.start === null && target.tagName === 'INPUT' && !isTick(target)) {
            // A number field reports no selection: assigning its value again leaves the caret at its end.
            const value = target.value;
            if (value !== undefined) {
              target.value = '';
              target.value = value;
            }
          }
        }
      }
    },
    scrollToEnd(region) {
      const box = doc.getElementById(region)?.parentElement;
      if (box !== null && box !== undefined) box.scrollTop = box.scrollHeight ?? 0;
    },
    onAction(handler) {
      onAction = handler;
      doc.addEventListener('click', (event) => {
        const element = actionOf(event.target);
        if (element !== undefined) fire(element);
      });
    },
    onKey(handler) {
      doc.addEventListener('keydown', (event) => {
        const target = isElement(event.target) ? event.target : undefined;
        const tag = target?.tagName;
        if (event.key === 'Enter' || event.key === ' ') {
          // A native button or link is clicked by the browser; any other focused element with its own action (a
          // stage card) is opened here, as a click would.
          if (tag === 'BUTTON' || tag === 'A') return;
          if (target !== undefined && target.dataset.action !== undefined && !(tag !== undefined && INPUTS.has(tag))) {
            event.preventDefault?.();
            fire(target);
            return;
          }
        }
        handler(event.key ?? '', tag !== undefined && INPUTS.has(tag));
      });
    },
    async get(path) {
      try {
        const response = await win.fetch(path, { headers: { 'X-Sail-Dashboard': '1' } });
        return { status: response.status, body: await response.text() };
      } catch {
        return { status: 0, body: '' };
      }
    },
    async post(path, body) {
      try {
        const response = await win.fetch(path, {
          method: 'POST',
          headers: { 'X-Sail-Dashboard': '1', 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.text() };
      } catch {
        return { status: 0, body: '' };
      }
    },
    value(name) {
      for (const region of REGIONS) {
        const field = doc.getElementById(region)?.querySelector?.(`[name="${name}"]`);
        if (field === null || field === undefined) continue;
        if (field.type === 'checkbox') return field.checked === true ? 'on' : '';
        return field.value ?? undefined;
      }
      return undefined;
    },
    connect(query, handlers) {
      const socket = new win.WebSocket(`ws://${win.location.host}/ws?${query}`);
      let closed = false;
      socket.onmessage = (event) => handlers.message(String(event.data));
      socket.onclose = () => {
        if (closed) return;
        closed = true;
        handlers.close();
      };
      return { close: () => socket.close() };
    },
    now: () => win.Date.now(),
    later: (fn, ms) => win.setTimeout(fn, ms),
    cancel: (id) => win.clearTimeout(id),
    load(key) {
      try {
        return win.localStorage.getItem(key) ?? undefined;
      } catch {
        return undefined;
      }
    },
    save(key, value) {
      try {
        win.localStorage.setItem(key, value);
      } catch {
        // Storage that is full, disabled or private only loses the preference.
      }
    },
    async copy(text) {
      try {
        if (win.navigator.clipboard === undefined) return false;
        await win.navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    },
    setTheme(theme) {
      doc.documentElement.dataset.theme = theme;
    },
    start: () => Object.fromEntries(new URLSearchParams(win.location.search)),
    setUrl(query, push) {
      const url = query === '' ? win.location.pathname : `?${query}`;
      if (push) win.history.pushState(null, '', url);
      else win.history.replaceState(null, '', url);
    },
    setInspector(open) {
      doc.documentElement.dataset.inspector = open ? 'open' : 'closed';
    },
    offset: () => -new win.Date().getTimezoneOffset(),
  };
}
