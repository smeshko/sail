// Where the focus goes when an overlay closes or the element that held it is written away (ADW-542, audit 2 N7), and
// the pin toggle's pressed state: `browserHost()` driven through a window whose regions are small element trees parsed
// from the markup drawn into them, with a focus that fires `focusin` as a browser's does.
import { describe, expect, test } from 'bun:test';
import { type BrowserWindow, browserHost, type ElementLike, type EventLike } from '../../../src/dashboard/page/host';

interface Node extends ElementLike {
  tagName: string;
  attributes: Record<string, string>;
  children: Node[];
}

const VOID = new Set(['input', 'br', 'img']);
const decode = (text: string) =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/** Whether `node` matches one simple selector of the few the host asks: a tag, classes and attributes, each optional. */
function matches(node: Node, selector: string): boolean {
  const parsed = /^([a-z]*)((?:\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/.exec(selector.trim());
  if (parsed === null) throw new Error(`no such selector here: ${selector}`);
  const [, tag = '', rest = ''] = parsed;
  if (tag !== '' && node.tagName !== tag.toUpperCase()) return false;
  for (const [, cls, attr, value] of rest.matchAll(/\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g)) {
    if (cls !== undefined && !(node.attributes.class ?? '').split(' ').includes(cls)) return false;
    if (
      attr !== undefined &&
      (node.attributes[attr] === undefined || (value !== undefined && node.attributes[attr] !== value))
    )
      return false;
  }
  return true;
}

function fakeDom() {
  const listeners: Record<string, ((event: EventLike) => void)[]> = {};
  const state = { active: null as Node | null };
  const descendants = (node: Node): Node[] => node.children.flatMap((child) => [child, ...descendants(child)]);
  const make = (tag: string, attributes: Record<string, string>, parent: Node | null): Node => {
    const node: Node = {
      tagName: tag.toUpperCase(),
      attributes,
      children: [],
      innerHTML: '',
      dataset: {},
      parentElement: parent,
      contains: (other) => {
        for (let at: ElementLike | null = other; at !== null; at = at.parentElement) if (at === node) return true;
        return false;
      },
      querySelectorAll: (selectors) =>
        descendants(node).filter((each) => selectors.split(',').some((one) => matches(each, one))),
      querySelector: (selectors) => node.querySelectorAll?.(selectors)[0] ?? null,
      getAttribute: (name) => attributes[name] ?? null,
      setAttribute: (name, value) => {
        attributes[name] = value;
      },
      focus: () => {
        state.active = node;
        for (const listener of listeners.focusin ?? []) listener({ target: node });
      },
    };
    for (const [name, value] of Object.entries(attributes))
      if (name.startsWith('data-'))
        node.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
    if (attributes.name !== undefined) node.name = attributes.name;
    return node;
  };
  /** A region whose children are made again from each markup written into it, dropping a focus one of them held. */
  const region = (id: string) => {
    const root = make('div', { id }, null);
    Object.defineProperty(root, 'innerHTML', {
      set: (markup: string) => {
        if (state.active !== null && root.contains?.(state.active) === true) state.active = null;
        root.children = [];
        let at = root;
        for (const [, close, tag = '', attrs = ''] of markup.matchAll(/<(\/?)(\w+)([^>]*)>/g)) {
          if (close === '/') {
            at = (at.parentElement as Node | null) ?? root;
            continue;
          }
          const attributes: Record<string, string> = {};
          for (const [, name = '', value] of attrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g))
            attributes[name] = decode(value ?? '');
          const node = make(tag, attributes, at);
          at.children.push(node);
          if (!VOID.has(tag)) at = node;
        }
      },
    });
    return root;
  };
  const regions: Record<string, Node> = {};
  for (const id of ['sidebar', 'list', 'link', 'main', 'inspector', 'status', 'drawer', 'menu', 'toasts', 'dialog'])
    regions[id] = region(id);
  const pin = make('button', { id: 'pin-inspector', 'aria-pressed': 'false' }, null);
  // A resize handle, a tab stop of the page's own markup, outside the regions, with no name, action or href.
  const handle = make('div', { id: 'resize-left', role: 'separator', tabindex: '0' }, null);
  const fixed: Record<string, Node> = { 'pin-inspector': pin, 'resize-left': handle };
  const dialog = regions.dialog as Node;
  // A modal dialog takes the focus, onto its first button, as a browser's does.
  dialog.showModal = () => dialog.querySelector?.('[data-action]')?.focus?.();
  dialog.close = () => {};
  const win = {
    document: {
      getElementById: (id: string) => fixed[id] ?? regions[id] ?? null,
      addEventListener: (type: string, listener: (event: EventLike) => void) => {
        listeners[type] = [...(listeners[type] ?? []), listener];
      },
      removeEventListener: () => {},
      documentElement: { dataset: {} },
      get activeElement() {
        return state.active;
      },
    },
    location: { host: '127.0.0.1:0', search: '', pathname: '/', href: 'http://127.0.0.1/' },
    addEventListener() {},
    history: { pushState() {}, replaceState() {} },
    fetch: async () => ({ status: 200, text: async () => '' }),
    WebSocket: class {
      onmessage = null;
      onclose = null;
      close() {}
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    Date: class {
      getTimezoneOffset = () => 0;
      static now = () => 0;
    },
  } as unknown as BrowserWindow;
  /** The element of `id` matching `selector`. */
  const find = (id: string, selector: string) => {
    const found = regions[id]?.querySelector?.(selector);
    if (found === null || found === undefined) throw new Error(`no ${selector} in #${id}`);
    return found as Node;
  };
  return { host: browserHost(win), state, find, pin, handle };
}

const ROWS = (...ids: string[]) =>
  ids
    .map(
      (id) =>
        `<div class="lrow" data-row="inbox:${id}" data-subject="run" data-repo="r" data-run="${id}"><button class="r-open" data-action="open" data-run="${id}">${id}</button><button class="r-dismiss" data-action="dismiss-attention" data-item="${id}">✕</button></div>`,
    )
    .join('');
const MENU =
  '<div class="cmdk" tabindex="-1"><input class="cmdk-in" name="menu-query"><button data-action="menu-run" data-row="0">x</button></div>';
const LISTBOX =
  '<div class="cmdk ctx" tabindex="-1"><div class="cmdk-rows" id="cmdk-rows" role="listbox" tabindex="-1"><button data-action="menu-run" data-row="0">x</button></div></div>';
const SHEET = '<div class="cmdk keys" tabindex="-1">keys</div>';

describe('audit 2: overlays behave (ADW-542)', () => {
  test('the command menu, opened from a row, gives the focus back to that row when it closes, though the list was drawn again', () => {
    const { host, state, find } = fakeDom();
    host.render('list', ROWS('a', 'b'));
    find('list', '.r-open[data-run="b"]').focus?.();
    host.render('menu', MENU);
    host.focusMenu();
    expect(state.active?.name).toBe('menu-query');
    host.render('list', ROWS('a', 'b'));
    host.render('menu', '');
    expect(state.active).toBe(find('list', '.r-open[data-run="b"]'));
  });

  test('the shortcut sheet and a context menu, which have no field, give it back too, and a redraw of an open one keeps it in the menu', () => {
    const { host, state, find } = fakeDom();
    host.render('list', ROWS('a', 'b'));
    find('list', '.r-open[data-run="a"]').focus?.();
    host.render('menu', SHEET);
    host.focusMenu();
    expect(state.active).toBe(find('menu', '.cmdk'));
    host.render('menu', `${SHEET}<i></i>`);
    expect(state.active).toBe(find('menu', '.cmdk'));
    host.render('menu', '');
    expect(state.active).toBe(find('list', '.r-open[data-run="a"]'));
  });

  test('a menu with no field focuses its listbox, on open and after a redraw, and gives the focus back on close (ADW-547)', () => {
    const { host, state, find } = fakeDom();
    host.render('list', ROWS('a'));
    find('list', '.r-open[data-run="a"]').focus?.();
    host.render('menu', LISTBOX);
    host.focusMenu();
    expect(state.active).toBe(find('menu', '.cmdk-rows'));
    host.render('menu', `${LISTBOX}<i></i>`);
    expect(state.active).toBe(find('menu', '.cmdk-rows'));
    host.render('menu', '');
    expect(state.active).toBe(find('list', '.r-open[data-run="a"]'));
  });

  test('a resize handle, which has no name or action, gets the focus back when the menu or a dialog opened from it closes (ADW-547)', () => {
    const { host, state, handle } = fakeDom();
    handle.focus?.();
    host.render('menu', MENU);
    host.focusMenu();
    expect(state.active?.name).toBe('menu-query');
    host.render('menu', '');
    expect(state.active).toBe(handle);
    host.openDialog('<button data-action="dialog-confirm">stop</button>');
    expect(state.active?.dataset.action).toBe('dialog-confirm');
    host.closeDialog();
    expect(state.active).toBe(handle);
  });

  test('a dialog opened from the command menu gives the focus back to what had it before the menu', () => {
    const { host, state, find } = fakeDom();
    host.render('list', ROWS('a'));
    find('list', '.r-open[data-run="a"]').focus?.();
    host.render('menu', MENU);
    host.focusMenu();
    host.openDialog('<button data-action="dialog-confirm">stop</button>');
    expect(state.active?.dataset.action).toBe('dialog-confirm');
    host.render('menu', '');
    expect(state.active?.dataset.action).toBe('dialog-confirm');
    host.closeDialog();
    expect(state.active).toBe(find('list', '.r-open[data-run="a"]'));
  });

  test("a toast's dismissed ✕ gives the focus to the newest toast left, and the last one's back to what had it before", () => {
    const { host, state, find } = fakeDom();
    const toast = (id: number) =>
      `<div class="toast bad" data-toast="${id}"><button class="toast-x" data-action="dismiss-toast" data-toast="${id}">✕</button></div>`;
    host.render('list', ROWS('a'));
    find('list', '.r-open[data-run="a"]').focus?.();
    host.render('toasts', `${toast(1)}${toast(2)}${toast(3)}`);
    find('toasts', '[data-toast="3"].toast-x').focus?.();
    host.render('toasts', `${toast(1)}${toast(2)}`);
    expect(state.active).toBe(find('toasts', '[data-toast="2"].toast-x'));
    host.render('toasts', '');
    expect(state.active).toBe(find('list', '.r-open[data-run="a"]'));
  });

  test("an Inbox row's ✕ gives the focus to the row that took its place, the next, else the one before", () => {
    const { host, state, find } = fakeDom();
    host.render('list', ROWS('a', 'b', 'c'));
    find('list', '[data-item="b"]').focus?.();
    host.render('list', ROWS('a', 'c'));
    expect(state.active).toBe(find('list', '.r-open[data-run="c"]'));
    find('list', '[data-item="c"]').focus?.();
    host.render('list', ROWS('a'));
    expect(state.active).toBe(find('list', '.r-open[data-run="a"]'));
    host.render('list', '<p>none</p>');
    expect(state.active).toBeNull();
  });

  test('with nothing focused before the menu, closing it focuses nothing', () => {
    const { host, state } = fakeDom();
    host.render('menu', MENU);
    host.focusMenu();
    host.render('menu', '');
    expect(state.active).toBeNull();
  });

  test("the focus given back or moved on is the page's, never told as a person's: only the person's own reaches the row's subject", () => {
    const { host, find } = fakeDom();
    const told: (string | undefined)[] = [];
    host.onPoint((kind, data) => {
      if (kind === 'focus') told.push(data?.run ?? data?.item ?? 'none');
      return undefined;
    });
    host.render('list', ROWS('a', 'b', 'c'));
    find('list', '.r-open[data-run="b"]').focus?.();
    expect(told).toEqual(['b']);
    host.render('menu', MENU);
    host.focusMenu();
    told.length = 0;
    host.render('menu', '');
    find('list', '[data-item="b"]').focus?.();
    host.render('list', ROWS('a', 'c'));
    expect(told).toEqual(['b']);
  });

  test('the pin toggle says whether it is pressed', () => {
    const { host, pin } = fakeDom();
    host.setInspector(true, true);
    expect(pin.getAttribute?.('aria-pressed')).toBe('true');
    host.setInspector(false, false);
    expect(pin.getAttribute?.('aria-pressed')).toBe('false');
  });
});
