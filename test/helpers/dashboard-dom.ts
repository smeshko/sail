// A fake window whose regions resolve `[name="…"]` against the markup last drawn into them, as a browser's would: a field
// exists only in the region the views drew it in, and a redraw makes new fields from the markup, dropping what was typed.
// It parses only what the page draws: double-quoted attributes on `<input>` and `<select>`.
import { type BrowserWindow, type ElementLike, REGIONS } from '../../src/dashboard/page/host';

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const decodeEntities = (text: string) =>
  text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);

const attributes = (tag: string): Record<string, string> =>
  Object.fromEntries(
    [...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, decodeEntities(value ?? '')]),
  );
/** Whether the tag holds the boolean attribute `name`, outside any quoted value. */
const hasFlag = (tag: string, name: string) =>
  new RegExp(`(?:^|\\s)${name}(?=\\s|$)`).test(tag.replace(/"[^"]*"/g, '""'));

function fieldsOf(markup: string): Map<string, ElementLike> {
  const fields = new Map<string, ElementLike>();
  const make = (fields_: Partial<ElementLike>): ElementLike => ({
    innerHTML: '',
    dataset: {},
    parentElement: null,
    ...fields_,
  });
  for (const [, tag = ''] of markup.matchAll(/<input\b([^>]*)>/g)) {
    const attrs = attributes(tag);
    if (attrs.name === undefined) continue;
    const type = attrs.type ?? 'text';
    fields.set(
      attrs.name,
      make({ type, value: attrs.value ?? (type === 'checkbox' ? 'on' : ''), checked: hasFlag(tag, 'checked') }),
    );
  }
  for (const [, tag = '', options = ''] of markup.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const attrs = attributes(tag);
    if (attrs.name === undefined) continue;
    const all = [...options.matchAll(/<option\b([^>]*)>/g)].map(([, option = '']) => ({
      value: attributes(option).value ?? '',
      selected: hasFlag(option, 'selected'),
    }));
    fields.set(attrs.name, make({ type: 'select-one', value: (all.find((o) => o.selected) ?? all[0])?.value ?? '' }));
  }
  return fields;
}

function regionElement(): ElementLike & { fields: Map<string, ElementLike> } {
  let markup = '';
  let fields = new Map<string, ElementLike>();
  const element = {
    dataset: {},
    parentElement: null,
    querySelectorAll: () => [],
    querySelector: (selectors: string) => {
      const name = /^\[name="([^"]*)"\]$/.exec(selectors)?.[1];
      return name === undefined ? null : (fields.get(name) ?? null);
    },
  } as unknown as ElementLike & { fields: Map<string, ElementLike> };
  Object.defineProperty(element, 'innerHTML', {
    get: () => markup,
    set: (next: string) => {
      markup = next;
      fields = fieldsOf(next);
    },
  });
  Object.defineProperty(element, 'fields', { get: () => fields });
  return element;
}

export function markupWindow() {
  const regions: Record<string, ReturnType<typeof regionElement>> = {};
  for (const name of REGIONS) regions[name] = regionElement();
  const body = regionElement();
  const win: BrowserWindow = {
    document: {
      getElementById: (id) => (id === 'body' ? body : (regions[id] ?? null)),
      addEventListener: () => {},
      removeEventListener: () => {},
      documentElement: { dataset: {} },
    },
    location: { host: '127.0.0.1:0', search: '' },
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
    },
  };
  const region = (name: string): ElementLike => {
    const found = regions[name];
    if (found === undefined) throw new Error(`no region #${name}`);
    return found;
  };
  /** The field `name` as `region`'s markup holds it; type into it by setting its `value` or `checked`. */
  const field = (name: string, fieldName: string): ElementLike => {
    const found = (region(name) as ReturnType<typeof regionElement>).fields.get(fieldName);
    if (found === undefined) throw new Error(`no field "${fieldName}" in #${name}`);
    return found;
  };
  return { win, region, field: (regionName: string, fieldName: string) => field(regionName, fieldName) };
}
