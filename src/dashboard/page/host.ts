// What the page needs from a browser, as one interface: regions to render into, delegated actions and keys, reads with
// the client header, sockets, timers, storage and the clipboard. `boot()` takes a `PageHost`, so the whole shell runs
// in a test against a fake one, and `browserHost()` adapts a real window to it. The window is typed here, by the few
// members the page uses, since the project's TypeScript has no DOM library.

/** The page's regions, each an element id in `index.html`. */
export const REGIONS = ['rail', 'attention', 'queues', 'main', 'inspector', 'status', 'drawer'] as const;
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
  render(region: Region, html: string): void;
  /** Scrolls what holds `region` to its end. */
  scrollToEnd(region: Region): void;
  onAction(handler: (action: string, data: Record<string, string>) => void): void;
  onKey(handler: (key: string, inInput: boolean) => void): void;
  /** A GET of `path` on the dashboard, with the client header. A failed request answers status 0. */
  get(path: string): Promise<{ status: number; body: string }>;
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
  /** What the page's URL asks it to open first, from `?repo=…&run=…&key=…&tab=…`: empty when it asks nothing. */
  start(): Record<string, string>;
}

/** The members of an element the page uses. */
export interface ElementLike {
  innerHTML: string;
  scrollTop?: number;
  scrollHeight?: number;
  dataset: Record<string, string | undefined>;
  parentElement: ElementLike | null;
  tagName?: string;
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
  };
  location: { host: string; search: string };
  fetch(url: string, init: { headers: Record<string, string> }): Promise<{ status: number; text(): Promise<string> }>;
  WebSocket: new (url: string) => SocketLike;
  localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  navigator: { clipboard?: { writeText(text: string): Promise<void> } };
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  Date: { new (): { getTimezoneOffset(): number } };
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
  return {
    render(region, markup) {
      const element = doc.getElementById(region);
      if (element !== null) element.innerHTML = markup;
    },
    scrollToEnd(region) {
      const box = doc.getElementById(region)?.parentElement;
      if (box !== null && box !== undefined) box.scrollTop = box.scrollHeight ?? 0;
    },
    onAction(handler) {
      doc.addEventListener('click', (event) => {
        const element = actionOf(event.target);
        if (element === undefined) return;
        const data: Record<string, string> = {};
        for (const [name, value] of Object.entries(element.dataset)) if (value !== undefined) data[name] = value;
        handler(data.action ?? '', data);
      });
    },
    onKey(handler) {
      doc.addEventListener('keydown', (event) => {
        const tag = isElement(event.target) ? event.target.tagName : undefined;
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
    now: () => Date.now(),
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
    setInspector(open) {
      doc.documentElement.dataset.inspector = open ? 'open' : 'closed';
    },
    offset: () => -new win.Date().getTimezoneOffset(),
  };
}
