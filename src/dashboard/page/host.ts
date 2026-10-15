// What the page needs from a browser, as one interface: regions to render into, delegated actions and keys, reads with
// the client header, sockets, timers, storage and the clipboard. `boot()` takes a `PageHost`, so the whole shell runs
// in a test against a fake one, and `browserHost()` adapts a real window to it. The window is typed here, by the few
// members the page uses, since the project's TypeScript has no DOM library.

/** The page's regions, each an element id in `index.html`. */
export const REGIONS = ['rail', 'attention', 'queues', 'main', 'inspector', 'status'] as const;
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
}

/** The members of an element the page uses. */
export interface ElementLike {
  innerHTML: string;
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
  location: { host: string };
  fetch(url: string, init: { headers: Record<string, string> }): Promise<{ status: number; text(): Promise<string> }>;
  WebSocket: new (url: string) => SocketLike;
  localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  navigator: { clipboard?: { writeText(text: string): Promise<void> } };
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  Date: { new (): { getTimezoneOffset(): number } };
}

/**
 * A real window as a `PageHost`.
 *
 * Stub (TASK-008): a host that renders nothing, hears nothing, and reads nothing.
 */
export function browserHost(_win: BrowserWindow): PageHost {
  return {
    render() {},
    onAction() {},
    onKey() {},
    get: async () => ({ status: 0, body: '' }),
    connect: () => ({ close() {} }),
    now: () => 0,
    later: () => 0,
    cancel() {},
    load: () => undefined,
    save() {},
    copy: async () => true,
    setTheme() {},
    setInspector() {},
    offset: () => 0,
  };
}
