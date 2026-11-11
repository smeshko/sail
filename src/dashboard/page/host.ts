// What the page needs from a browser, as one interface: regions to render into, delegated actions and keys, reads with
// the client header, the POSTs (a queue move, a resume, a restart), sockets, timers, storage and the clipboard. `boot()` takes a `PageHost`, so the whole shell runs
// in a test against a fake one, and `browserHost()` adapts a real window to it. The window is typed here, by the few
// members the page uses, since the project's TypeScript has no DOM library.

/** The page's regions, each an element id in `index.html`. */
export const REGIONS = ['sidebar', 'list', 'link', 'main', 'inspector', 'status', 'drawer', 'menu', 'toasts'] as const;
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
   * markup's, and the focus is still kept. A focus the write takes away moves on: in a list's row (`data-row`), to the
   * row that took its place, the next, else the one before; in a toast, to the newest one left; and out of the
   * command menu or the shortcut sheet when it closes, or of the last toast, back to what had it before.
   */
  render(region: Region, html: string, fresh?: boolean): void;
  /** Scrolls what holds `region` to its end. */
  scrollToEnd(region: Region): void;
  onAction(handler: (action: string, data: Record<string, string>) => void): void;
  /**
   * `handler` is told each key, whether it was typed in an input, `on`, the `data-action` of the element the key
   * landed on, and `mod`, whether Cmd or Ctrl is held; answering true suppresses the key's default, as typing it would.
   * A key held with Alt is the browser's, but for Alt with the up or down arrow, told as `Alt+ArrowUp` and `Alt+ArrowDown`.
   * Enter in a text field under a `data-enter` element arrives as the action of the button that element names, as a
   * click on it would, and is no key.
   */
  onKey(handler: (key: string, inInput: boolean, on?: string, mod?: boolean) => boolean): void;
  /**
   * `handler` is told where the pointer is: `hover` when it moves onto an element, `context` when a right-click lands,
   * and `focus` when the focus reaches an element, by Tab or a click, though not when a redraw, a closing dialog, menu,
   * sheet or toast, or a row written away gives it back or moves it on. `data` is the dataset of the nearest ancestor with a `data-subject`, or undefined when the element is on no
   * row. A `context` answered true has its default prevented.
   */
  onPoint(
    handler: (
      kind: 'hover' | 'context' | 'focus',
      data: Record<string, string> | undefined,
      point: { x: number; y: number },
    ) => boolean | undefined,
  ): void;
  /** `handler` is told the region a mouse button goes down in, before that press's click, or undefined for none. */
  onPress(handler: (region: Region | undefined) => void): void;
  /** `handler` is told the value of a named field each time it is typed into. */
  onInput(handler: (name: string, value: string) => void): void;
  /** Focuses the field named `name`, in whichever region draws it. */
  focus(name: string): void;
  /** Focuses the command menu's field, else its focusable listbox, else the menu itself, remembering what had the focus for when it closes. */
  focusMenu(): void;
  /** Takes the focus off the focused element. */
  blur(): void;
  /** Scrolls the `.cur` element of `region`, or with `sel` its selected row (`[data-row].sel`), into view, as little as it takes. */
  reveal(region: Region, what?: 'cur' | 'sel'): void;
  /**
   * Opens the confirmation dialog with `html`, modal, and remembers what had the focus. A close the browser makes
   * itself reaches the action handler as `dialog-cancel`, and a `change` of a field inside it as `dialog-change`.
   */
  openDialog(html: string): void;
  /** Closes the dialog and gives the focus back to what had it at the open. */
  closeDialog(): void;
  /**
   * Draws `html` into the open dialog's `#dialog-body` (the whole dialog when it has none) as `render()` draws a region,
   * keeping its focus, field values and caret. The buttons outside it stay, so a click a field's blur redrew under lands.
   */
  redrawDialog(html: string): void;
  /** The current value of the field named `name` inside the dialog alone, or undefined when it holds none. A checkbox reads as `value()` reads it. */
  dialogValue(name: string): string | undefined;
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
  /** Opens `url` in a new tab, with no opener and no referrer. */
  openLink(url: string): void;
  setTheme(theme: string): void;
  /** Whether the inspector takes its room, and whether it is pinned open. */
  setInspector(open: boolean, pinned: boolean): void;
  /** Whether the folded sidebar is open. */
  setSidebar(open: boolean): void;
  /** Whether a run or queue is open beside the list: the centre is laid out by it. */
  setDetail(open: boolean): void;
  /** The keyed pane, the list or the centre, or undefined while only one pane shows: the page marks the one keyed. */
  setKeys(pane: 'list' | 'centre' | undefined): void;
  /** Whether the window is under 800px: the list and the centre are two screens, and no first row is selected. */
  narrow(): boolean;
  /** The browser's offset east of UTC, in minutes. */
  offset(): number;
  /** What the page's URL asks it to open first, from `?repo=…&run=…&key=…&tab=…&timeline=1&file=…` or `?queue=…`, each with `&view=…`: empty when it asks nothing. */
  start(): Record<string, string>;
  /** Writes the page's URL to `?query` (the path alone for an empty one), as a new history entry when `push`, else in place of the current one. */
  setUrl(query: string, push: boolean): void;
  /** The page's whole URL, as the address bar shows it. */
  href(): string;
  /** Calls `handler` with the URL's query, parsed as `start()` parses it, when the browser moves to another history entry. */
  onNavigate(handler: (asked: Record<string, string>) => void): void;
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
  /** A `<dialog>`'s. */
  showModal?(): void;
  close?(): void;
  open?: boolean;
  onclose?: (() => void) | null;
  contains?(other: ElementLike): boolean;
  focus?(options?: { preventScroll?: boolean }): void;
  blur?(): void;
  scrollIntoView?(options?: { block?: string }): void;
  getAttribute?(name: string): string | null;
  setAttribute?(name: string, value: string): void;
  querySelectorAll?(selectors: string): ArrayLike<ElementLike>;
  querySelector?(selectors: string): ElementLike | null;
  style?: { setProperty(name: string, value: string): void };
}

export interface EventLike {
  target: unknown;
  key?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  clientX?: number;
  clientY?: number;
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
  location: { host: string; search: string; pathname: string; href: string };
  history: {
    pushState(data: unknown, unused: string, url: string): void;
    replaceState(data: unknown, unused: string, url: string): void;
  };
  addEventListener(type: string, listener: () => void): void;
  fetch(
    url: string,
    init: { headers: Record<string, string>; method?: string; body?: string },
  ): Promise<{ status: number; text(): Promise<string> }>;
  WebSocket: new (url: string) => SocketLike;
  localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  navigator: { clipboard?: { writeText(text: string): Promise<void> } };
  /** Optional, so a window without it opens nothing. */
  open?(url: string, target: string, features: string): unknown;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  Date: { new (): { getTimezoneOffset(): number }; now(): number };
  /** Optional, so a window without it reads as wide. */
  matchMedia?(query: string): { matches: boolean };
  /** Optional, so a window without it reads as wide. */
  innerWidth?: number;
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

/** The dataset of the nearest ancestor of `target` that names a subject, as a plain record. */
function subjectData(target: unknown): Record<string, string> | undefined {
  for (let at = isElement(target) ? target : null; at !== null; at = at.parentElement) {
    if (at.dataset.subject === undefined) continue;
    const data: Record<string, string> = {};
    for (const [name, value] of Object.entries(at.dataset)) if (value !== undefined) data[name] = value;
    return data;
  }
  return undefined;
}

/** The elements a person can focus, and the ones a focus key is derived from. */
const FOCUSABLE = '[name], [data-action], a[href]';

/**
 * What identifies a focusable element across a redraw, from what its markup carries: its `name`, else its `data-action`
 * with its other `data-*` values, else its `href`, else its `id`, as a resize handle's. An element with none has no
 * key, and its focus is not restored.
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
  if (href !== null && href !== undefined) return `href=${href}`;
  const id = element.getAttribute?.('id');
  return id === null || id === undefined || id === '' ? undefined : `id=${id}`;
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

/** The row (`data-row`) of `element` that holds `active`, with the ids of the element's rows in order. */
function rowAround(element: ElementLike, active: ElementLike): { id: string; ids: string[] } | undefined {
  let at: ElementLike | null = active;
  while (at !== null && at !== element && at.dataset.row === undefined) at = at.parentElement;
  const id = at?.dataset.row;
  if (id === undefined) return undefined;
  const ids = Array.from(element.querySelectorAll?.('[data-row]') ?? []).flatMap((each) =>
    each.dataset.row === undefined ? [] : [each.dataset.row],
  );
  return { id, ids };
}

/** The first of `ids` that `element` holds a row for, after the write, and what in it takes the focus. */
function rowTarget(element: ElementLike, ids: readonly string[]): ElementLike | undefined {
  const rows = new Map(Array.from(element.querySelectorAll?.('[data-row]') ?? []).map((row) => [row.dataset.row, row]));
  for (const id of ids) {
    const row = rows.get(id);
    const target = row?.dataset.action !== undefined ? row : (row?.querySelector?.(FOCUSABLE) ?? undefined);
    if (target !== undefined) return target;
  }
  return undefined;
}

type Side = 'left' | 'right';

/**
 * How wide each resizable column may be, the window width from which it is a column of the grid, and its CSS variable:
 * the sidebar is one from 900px, the open inspector from 1210px (`index.html`'s breakpoints).
 */
const COLUMNS: Record<Side, { variable: string; min: number; max: number; start: number; sign: number; from: number }> =
  {
    left: { variable: '--side-w', min: 140, max: 480, start: 180, sign: 1, from: 900 },
    right: { variable: '--ins-w', min: 240, max: 640, start: 360, sign: -1, from: 1210 },
  };
/** The grid's resize handle width, the list's fixed width and the centre's floor, as `index.html` lays them out. */
const HANDLE = 5;
const LIST = 340;
const CENTRE_MIN = 320;

/** How far an arrow key moves a focused resize handle, in px. */
const STEP = 16;

/** The side of the handle a key of its own (an arrow, Home or End, with no Alt, Ctrl or Meta) is aimed at, if any. */
function resizeKey(event: EventLike): Side | undefined {
  if (event.altKey === true || event.ctrlKey === true || event.metaKey === true) return undefined;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End')
    return undefined;
  const side = isElement(event.target) ? event.target.dataset.resize : undefined;
  return side === 'left' || side === 'right' ? side : undefined;
}

/**
 * Drags the column of a `data-resize` handle, which sets its CSS variable on `#body`, never so wide that the list gives
 * up its width, the centre falls under its floor and the grid runs past the window (ADW-536). A focused handle takes
 * ArrowLeft and ArrowRight, 16px the way they point, Home for the minimum and End for the widest, within the same
 * clamp, and each handle keeps its `aria-valuenow`, `aria-valuemin` and `aria-valuemax` current. Answers the re-clamp
 * a window resize runs, the inspector first, for a change of layout the window doesn't announce, such as the inspector
 * opening.
 */
function installResize(win: BrowserWindow): () => void {
  const doc = win.document;
  const widths: Record<Side, number> = { left: COLUMNS.left.start, right: COLUMNS.right.start };
  /** Whether `side` takes a column of the grid at the window's width; a window that gives none reads as wide. */
  const inGrid = (side: Side) =>
    (win.innerWidth ?? Number.POSITIVE_INFINITY) >= COLUMNS[side].from &&
    (side === 'left' || doc.documentElement.dataset.inspector === 'open');
  /** The widest `side` may be: its fixed maximum, or what the window leaves beside the other column, the handles in the grid, the list and the centre's floor, never under its minimum. */
  const widest = (side: Side) => {
    const column = COLUMNS[side];
    const width = win.innerWidth;
    if (width === undefined || !inGrid(side)) return column.max;
    const other: Side = side === 'left' ? 'right' : 'left';
    const beside = inGrid(other) ? widths[other] + HANDLE : 0;
    return Math.max(column.min, Math.min(column.max, width - beside - HANDLE - LIST - CENTRE_MIN));
  };
  /** Tells each handle its column's width, minimum and widest: one column's widest depends on the other's width. */
  const tell = () => {
    for (const side of ['left', 'right'] as const) {
      const handle = doc.getElementById(`resize-${side}`);
      handle?.setAttribute?.('aria-valuenow', String(widths[side]));
      handle?.setAttribute?.('aria-valuemin', String(COLUMNS[side].min));
      handle?.setAttribute?.('aria-valuemax', String(widest(side)));
    }
  };
  const set = (side: Side, width: number) => {
    widths[side] = width;
    doc.getElementById('body')?.style?.setProperty(COLUMNS[side].variable, `${width}px`);
    tell();
  };
  const fit = () => {
    for (const side of ['right', 'left'] as const) if (widths[side] > widest(side)) set(side, widest(side));
    tell();
  };
  tell();
  win.addEventListener('resize', fit);
  doc.addEventListener('keydown', (event) => {
    const side = resizeKey(event);
    if (side === undefined) return;
    const column = COLUMNS[side];
    event.preventDefault?.();
    const to =
      event.key === 'Home'
        ? column.min
        : event.key === 'End'
          ? widest(side)
          : widths[side] + column.sign * (event.key === 'ArrowRight' ? STEP : -STEP);
    set(side, Math.max(column.min, Math.min(widest(side), to)));
  });
  doc.addEventListener('mousedown', (down) => {
    const side = isElement(down.target) ? down.target.dataset.resize : undefined;
    if (side !== 'left' && side !== 'right') return;
    const column = COLUMNS[side];
    down.preventDefault?.();
    const from = down.clientX ?? 0;
    const start = widths[side];
    const move = (event: EventLike) => {
      set(side, Math.max(column.min, Math.min(widest(side), start + column.sign * ((event.clientX ?? from) - from))));
    };
    const up = () => {
      doc.removeEventListener('mousemove', move);
      doc.removeEventListener('mouseup', up);
    };
    doc.addEventListener('mousemove', move);
    doc.addEventListener('mouseup', up);
  });
  return fit;
}

/** A real window as a `PageHost`. */
export function browserHost(win: BrowserWindow): PageHost {
  const doc = win.document;
  const fitColumns = installResize(win);
  /** The focus key of what had the focus when the dialog opened. */
  let opener: string | undefined;
  /** Set while the page gives the focus back itself, so that focus is not told as a person's. */
  let refocusing = false;
  const refocus = (target: ElementLike) => {
    refocusing = true;
    try {
      target.focus?.({ preventScroll: true });
    } finally {
      refocusing = false;
    }
  };
  /** The regions drawn over the page, which give the focus back when they close. */
  const over = (element: ElementLike) =>
    (['menu', 'toasts', 'dialog'] as const).some((id) => doc.getElementById(id)?.contains?.(element) === true);
  /** The focus key of what last had the focus outside them: where it goes back to once the one it moved to closes. */
  let back: string | undefined;
  doc.addEventListener('focusin', (event) => {
    if (isElement(event.target) && !over(event.target)) back = focusKey(event.target);
  });
  /** Gives the focus back to the element of the regions with `key`, the first, and answers whether there was one. */
  const refocusKey = (key: string | undefined) => {
    if (key === undefined) return false;
    if (key.startsWith('id=')) {
      // An element of the page's own markup, such as a resize handle, found by its id wherever it is.
      const target = doc.getElementById(key.slice(3));
      if (target === null || target === undefined) return false;
      refocus(target);
      return true;
    }
    for (const region of REGIONS) {
      const root = doc.getElementById(region);
      const target = root === null ? undefined : keyed(root, key)[0];
      if (target !== undefined) {
        refocus(target);
        return true;
      }
    }
    return false;
  };
  /** Whether `element` holds the focus. */
  const holds = (element: ElementLike) => {
    const active = doc.activeElement;
    return active !== null && active !== undefined && element.contains?.(active) === true;
  };
  const menuTarget = () => {
    const menu = doc.getElementById('menu');
    return (
      menu?.querySelector?.('[name="menu-query"]') ??
      menu?.querySelector?.('.cmdk-rows[tabindex]') ??
      menu?.querySelector?.('.cmdk')
    );
  };
  /** Moves on a focus the write of `region` took away, from the row it was in, if any. */
  const moveOn = (region: Region, element: ElementLike, markup: string, row: ReturnType<typeof rowAround>) => {
    if (region === 'menu') {
      if (markup === '') refocusKey(back);
      else {
        const target = menuTarget();
        if (target !== null && target !== undefined) refocus(target);
      }
      return;
    }
    if (region === 'toasts') {
      const left = Array.from(element.querySelectorAll?.('[data-action="dismiss-toast"]') ?? []).at(-1);
      if (left === undefined) refocusKey(back);
      else refocus(left);
      return;
    }
    if (row === undefined) return;
    const at = row.ids.indexOf(row.id);
    const target = rowTarget(element, [row.id, ...row.ids.slice(at + 1), ...row.ids.slice(0, at).reverse()]);
    if (target !== undefined) refocus(target);
  };
  let onAction: (action: string, data: Record<string, string>) => void = () => {};
  /** Delivers `element`'s action with its data, as a click on it would. */
  const fire = (element: ElementLike) => {
    const data: Record<string, string> = {};
    for (const [name, value] of Object.entries(element.dataset)) if (value !== undefined) data[name] = value;
    onAction(data.action ?? '', data);
  };
  /** Draws `markup` into `element`, keeping its focus, field values, caret and scrolled boxes unless `fresh`. */
  const draw = (element: ElementLike, markup: string, fresh: boolean) => {
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
      if (target !== undefined) refocus(target);
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
  };
  return {
    render(region, markup, fresh = false) {
      const element = doc.getElementById(region);
      if (element === null) return;
      const had = holds(element);
      const active = doc.activeElement;
      const row = had && active !== null && active !== undefined ? rowAround(element, active) : undefined;
      draw(element, markup, fresh);
      if (had && !holds(element)) moveOn(region, element, markup, row);
    },
    openDialog(markup) {
      const dialog = doc.getElementById('dialog');
      if (dialog === null) return;
      // Opened from an overlay, the command menu, the focus goes back to what had it before that.
      const active = doc.activeElement;
      opener = active === null || active === undefined ? undefined : over(active) ? back : focusKey(active);
      dialog.innerHTML = markup;
      // A close the browser makes itself, with no Escape the page saw, cancels the dialog as its cancel button does.
      // A close event that finds it open again is an earlier close's, made before a reopen.
      dialog.onclose = () => {
        if (dialog.open !== true) onAction('dialog-cancel', {});
      };
      dialog.showModal?.();
    },
    closeDialog() {
      const dialog = doc.getElementById('dialog');
      if (dialog !== null) dialog.onclose = null;
      dialog?.close?.();
      const key = opener;
      opener = undefined;
      refocusKey(key);
    },
    redrawDialog(markup) {
      const dialog = doc.getElementById('dialog-body') ?? doc.getElementById('dialog');
      if (dialog !== null) draw(dialog, markup, false);
    },
    dialogValue(name) {
      const field = doc.getElementById('dialog')?.querySelector?.(`[name="${name}"]`);
      if (field === null || field === undefined) return undefined;
      if (field.type === 'checkbox') return field.checked === true ? 'on' : '';
      return field.value ?? undefined;
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
      // A field of the confirmation dialog changed: the page draws its lines again.
      doc.addEventListener('change', (event) => {
        const dialog = doc.getElementById('dialog');
        if (dialog !== null && isElement(event.target) && dialog.contains?.(event.target) === true)
          onAction('dialog-change', {});
      });
    },
    onPoint(handler) {
      doc.addEventListener('mouseover', (event) => {
        handler('hover', subjectData(event.target), { x: event.clientX ?? 0, y: event.clientY ?? 0 });
      });
      // The focus reaching a row, by Tab or a click, is told as `focus`; the page's own giving it back is not.
      doc.addEventListener('focusin', (event) => {
        if (!refocusing) handler('focus', subjectData(event.target), { x: 0, y: 0 });
      });
      // A right-click on a row is the page's, and its default is prevented only when the handler took it: one on no row
      // keeps the browser's own menu.
      doc.addEventListener('contextmenu', (event) => {
        const point = { x: event.clientX ?? 0, y: event.clientY ?? 0 };
        if (handler('context', subjectData(event.target), point) === true) event.preventDefault?.();
      });
    },
    onPress(handler) {
      doc.addEventListener('mousedown', (event) => {
        const target = isElement(event.target) ? event.target : undefined;
        handler(
          target === undefined
            ? undefined
            : REGIONS.find((region) => doc.getElementById(region)?.contains?.(target) === true),
        );
      });
    },
    onInput(handler) {
      doc.addEventListener('input', (event) => {
        const target = isElement(event.target) ? event.target : undefined;
        if (target?.name !== undefined && target.name !== '') handler(target.name, target.value ?? '');
      });
    },
    focus(name) {
      for (const region of REGIONS) {
        const field = doc.getElementById(region)?.querySelector?.(`[name="${name}"]`);
        if (field !== null && field !== undefined) {
          field.focus?.();
          return;
        }
      }
    },
    focusMenu() {
      const active = doc.activeElement;
      if (active !== null && active !== undefined && !over(active)) back = focusKey(active);
      menuTarget()?.focus?.();
    },
    blur() {
      doc.activeElement?.blur?.();
    },
    reveal(region, what = 'cur') {
      doc
        .getElementById(region)
        ?.querySelector?.(what === 'sel' ? '[data-row].sel' : '.cur')
        ?.scrollIntoView?.({ block: 'nearest' });
    },
    onKey(handler) {
      doc.addEventListener('keydown', (event) => {
        // A focused resize handle's own keys move its column, not the list's cursor.
        if (resizeKey(event) !== undefined) return;
        const target = isElement(event.target) ? event.target : undefined;
        const tag = target?.tagName;
        if (event.key === 'Enter' && target !== undefined && tag === 'INPUT' && !isTick(target)) {
          // Enter in a text field under an element that declares `data-enter` is a click on the button it names.
          let at: ElementLike | null = target;
          while (at !== null && at.dataset?.enter === undefined) at = at.parentElement;
          const found = at?.querySelector?.(`[data-action="${at.dataset.enter}"]`);
          if (found !== null && found !== undefined) {
            event.preventDefault?.();
            fire(found);
            return;
          }
        }
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
        // A key held with Alt is the browser's, but for the up and down arrows, which move a queue item. A letter's
        // case is Shift's, never Caps Lock's: `e` and `E` change saved state (review R5).
        let key = event.key ?? '';
        if (event.altKey === true) {
          if (key !== 'ArrowUp' && key !== 'ArrowDown') return;
          key = `Alt+${key}`;
        }
        const mod = event.metaKey === true || event.ctrlKey === true;
        if (/^[a-z]$/i.test(key) && event.shiftKey !== undefined)
          key = event.shiftKey ? key.toUpperCase() : key.toLowerCase();
        if (handler(key, tag !== undefined && INPUTS.has(tag), actionOf(event.target)?.dataset.action, mod) === true)
          event.preventDefault?.();
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
    openLink(url) {
      win.open?.(url, '_blank', 'noopener,noreferrer');
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
    href: () => win.location.href,
    onNavigate(handler) {
      win.addEventListener('popstate', () => handler(Object.fromEntries(new URLSearchParams(win.location.search))));
    },
    setUrl(query, push) {
      const url = query === '' ? win.location.pathname : `?${query}`;
      if (push) win.history.pushState(null, '', url);
      else win.history.replaceState(null, '', url);
    },
    setInspector(open, pinned) {
      doc.documentElement.dataset.inspector = open ? 'open' : 'closed';
      doc.documentElement.dataset.pinned = pinned ? 'true' : 'false';
      doc.getElementById('pin-inspector')?.setAttribute?.('aria-pressed', pinned ? 'true' : 'false');
      // An inspector that opens beside a sidebar dragged wide takes its column within what the window leaves.
      fitColumns();
    },
    setSidebar(open) {
      doc.documentElement.dataset.sidebar = open ? 'open' : 'closed';
    },
    setDetail(open) {
      doc.documentElement.dataset.detail = open ? 'open' : 'closed';
    },
    setKeys(pane) {
      doc.documentElement.dataset.keys = pane ?? 'none';
    },
    narrow: () => win.matchMedia?.('(max-width: 799px)').matches ?? false,
    offset: () => -new win.Date().getTimezoneOffset(),
  };
}
