// The page's stylesheet, read from index.html: the text tokens' contrast on every surface in each theme block.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../../src/dashboard/page/index.html', import.meta.url), 'utf8');
const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';

const FG = ['--fg', '--fg-2', '--fg-3', '--fg-4'];
const SURFACES = ['--bg', '--panel', '--panel-2', '--hover', '--inset'];

/** The custom properties declared in the block that opens with `opener`, a literal run of the stylesheet. */
const block = (opener: string, from = 0): Record<string, string> => {
  const start = style.indexOf(opener, from);
  if (start < 0) throw new Error(`no block ${opener}`);
  const end = style.indexOf('}', start);
  const props: Record<string, string> = {};
  for (const m of style.slice(start + opener.length, end).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    props[m[1] as string] = (m[2] as string).trim();
  }
  return props;
};

const dark = () => block(':root[data-theme="dark"],\n      :root[data-theme="system"] {');
const light = () => block(':root[data-theme="light"] {');
const systemLight = () => {
  const media = style.indexOf('@media (prefers-color-scheme: light)');
  return block(':root[data-theme="system"] {', media);
};

const channel = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string): number => {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = Number.parseInt(h, 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
/** The WCAG contrast ratio of two `#rgb` or `#rrggbb` colours. */
const ratio = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

test('the contrast helper tells black on white from the old dim token', () => {
  expect(Math.round(ratio('#000', '#fff'))).toBe(21);
  expect(ratio('#3b3b4c', '#111117')).toBeLessThan(2);
});

const THEMES: [string, () => Record<string, string>][] = [
  ['dark', dark],
  ['light', light],
  ['system-light', systemLight],
];

test('every text token is at least 4.5:1 on every surface in each theme block', () => {
  const low: string[] = [];
  for (const [name, read] of THEMES) {
    const props = read();
    for (const fg of FG) {
      for (const surface of SURFACES) {
        const r = ratio(props[fg] as string, props[surface] as string);
        if (r < 4.5) low.push(`${name}: ${fg} on ${surface} is ${r.toFixed(2)}`);
      }
    }
  }
  expect(low).toEqual([]);
});

test('the system theme copy of light holds the light block exactly', () => {
  expect(Object.keys(light()).length).toBeGreaterThan(8);
  expect(systemLight()).toEqual(light());
});

/** The rules of the stylesheet as [selector list, body] pairs, at-rule blocks flattened. */
const rules = (): [string, string][] =>
  [...style.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map(([, sel, body]) => [(sel as string).trim(), body as string]);

test("a run's ⋯ shows on hover and on focus inside the row, and is never hidden with visibility", () => {
  const forMore = rules().filter(([sel]) => /\.r-more/.test(sel));
  const selectors = forMore.flatMap(([sel]) => sel.split(',').map((each) => each.trim()));
  expect(selectors).toContain('.run:hover .r-more');
  expect(selectors).toContain('.run:focus-within .r-more');
  expect(forMore.filter(([, body]) => /visibility:\s*hidden/.test(body))).toEqual([]);
});

test("a row's menu floats: .r-menu is absolute inside a relative .run (ADW-516)", () => {
  const body = (selector: string) => rules().find(([sel]) => sel === selector)?.[1] ?? '';
  expect(body('.run')).toContain('position: relative');
  expect(body('.r-menu')).toContain('position: absolute');
  expect(body('.r-menu')).toContain('top: 100%');
});

test('the page starts with the inspector closed and unpinned (ADW-528)', () => {
  expect(html).toContain('data-inspector="closed" data-pinned="false"');
});

test('the theme and inspector buttons carry an aria-label beside their title (ADW-508)', () => {
  expect(html).toContain('data-action="toggle-theme" aria-label="switch theme" title="theme"');
  expect(html).toContain('data-action="toggle-inspector" aria-label="pin inspector" title="pin the inspector (i)"');
});

test('--focus is at least 3:1 on every surface in each theme block (ADW-508)', () => {
  const low: string[] = [];
  for (const [name, read] of THEMES) {
    const props = read();
    expect(props['--focus'], `${name} defines --focus`).toBeDefined();
    for (const surface of SURFACES) {
      const r = ratio(props['--focus'] as string, props[surface] as string);
      if (r < 3) low.push(`${name}: --focus on ${surface} is ${r.toFixed(2)}`);
    }
  }
  expect(low).toEqual([]);
});

test('one :focus-visible rule draws a 2px --focus outline, and no declaration removes an outline but the menu field (ADW-508)', () => {
  const ring = rules().filter(([sel]) => sel === ':focus-visible');
  expect(ring).toHaveLength(1);
  expect(ring[0]?.[1]).toContain('outline: 2px solid var(--focus);');
  // The command menu's field is the one exception: it is the only thing its dialog focuses, and its caret shows it.
  const field = /\.cmdk-in:focus-visible \{\s*outline: none;\s*\}/;
  expect(style).toMatch(field);
  expect(style.replace(field, '')).not.toMatch(/outline(-width)?:\s*(none|0)\b/);
});

test('buttons, selects, text inputs and role=button have a 24px minimum height in one rule (ADW-508)', () => {
  const target = rules().filter(([sel]) => sel.split(',').some((each) => each.trim() === '[role="button"]'));
  expect(target).toHaveLength(1);
  const [selector, body] = target[0] as [string, string];
  const list = selector.split(',').map((each) => each.trim());
  expect(list).toContain('button');
  expect(list).toContain('select');
  expect(list.some((each) => each.startsWith('input:not([type="checkbox"]):not([type="radio"])'))).toBe(true);
  expect(body).toContain('min-height: 24px;');
});

test('no control class is given a height under 24px (ADW-508)', () => {
  const controls =
    /\.(btn|wf-act|qbadge|hist-t|r-more|r-open|tab|tog|run-link|art-open|q-open|trow|qsec|qrecent-h|lgrp-h|wf-t|sig)\b/;
  const small: string[] = [];
  for (const [selector, body] of rules()) {
    // A decoration inside a control (`.q-open .qd`) is no target: only a selector that ends on the control counts.
    if (!selector.split(',').some((each) => controls.test(each.trim().split(/\s+/).pop() ?? ''))) continue;
    for (const m of body.matchAll(/(?<![\w-])(height|max-height|min-height):\s*(\d+(?:\.\d+)?)px/g)) {
      if (Number(m[2]) < 24) small.push(`${selector} { ${m[1]}: ${m[2]}px }`);
    }
  }
  expect(small).toEqual([]);
});

/** The top-level rules of the stylesheet as [selector list, declarations]: an at-rule's body is read as one rule too. */
const rulesOf = (): [string[], string][] =>
  [...style.matchAll(/(?<=^|\})\s*(?:\/\*[\s\S]*?\*\/\s*)*([^{}@/][^{}]*?)\s*\{([^{}]*)\}/g)].map(
    ([, selectors, body]) => [(selectors as string).split(',').map((each) => each.trim()), body as string],
  );
/** The declarations of every rule that has `selector` among its selectors, joined. */
const declarationsOf = (selector: string): string =>
  rulesOf()
    .filter(([selectors]) => selectors.includes(selector))
    .map(([, body]) => body)
    .join('\n');

/** The body of the `@media` block whose query is `query`, up to its balanced closing brace. */
const mediaBlock = (query: string): string => {
  const open = style.indexOf(`@media (${query}) {`);
  if (open < 0) return '';
  const start = style.indexOf('{', open) + 1;
  let depth = 1;
  let at = start;
  while (depth > 0 && at < style.length) {
    if (style[at] === '{') depth++;
    else if (style[at] === '}') depth--;
    at++;
  }
  return style.slice(start, at - 1);
};
/** The declarations of the rules inside `block` that have `selector` among theirs, joined. */
const inBlock = (block: string, selector: string): string =>
  [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selectors]) =>
      (selectors as string)
        .split(',')
        .map((each) => each.trim())
        .includes(selector),
    )
    .map(([, , body]) => body)
    .join('\n');

test('the sidebar is 180px wide by default, and the list beside a run is 340px (ADW-522)', () => {
  expect(declarationsOf('.body')).toContain('var(--side-w, 180px) 5px minmax(0, 1fr)');
  expect(declarationsOf(':root[data-detail="open"] .body')).toContain(
    'var(--side-w, 180px) 5px minmax(0, var(--list-w, 340px)) minmax(320px, 1fr)',
  );
  expect(declarationsOf(':root:not([data-detail="open"]) .main')).toContain('display: none');
});

test('the inspector has a grid track only from 1100px, and under it is a fixed panel no wider than the window (ADW-528)', () => {
  expect(declarationsOf('.body')).not.toContain('--ins-w');
  expect(declarationsOf(':root[data-detail="open"] .body')).not.toContain('--ins-w');
  const wide = mediaBlock('min-width: 1100px');
  expect(inBlock(wide, ':root[data-inspector="open"] .body')).toContain('5px var(--ins-w, 360px);');
  expect(inBlock(wide, ':root[data-detail="open"][data-inspector="open"] .body')).toContain('5px var(--ins-w, 360px);');
  const narrow = mediaBlock('max-width: 1099px');
  expect(inBlock(narrow, '.inspector')).toContain('position: fixed');
  expect(inBlock(narrow, '.inspector')).toContain('width: min(var(--ins-w, 360px), 100vw)');
  expect(inBlock(narrow, '.resize-right')).toContain('display: none');
  expect([...style.matchAll(/@media \(((?:min|max)-width[^)]*)\)/g)].map((m) => m[1])).toEqual([
    'min-width: 1100px',
    'max-width: 1099px',
    'max-width: 799px',
  ]);
});

test('under 1100px the inspector carries a close button over its head, and from 1100px it is hidden (review R2) (ADW-528)', () => {
  const aside = /<aside class="inspector">([\s\S]*?)<\/aside>/.exec(html)?.[1] ?? '';
  expect(aside).toMatch(/<button[^>]*class="btn ins-close"[^>]*data-action="close-inspector"/);
  expect(declarationsOf('.ins-close')).toContain('display: none');
  const narrow = mediaBlock('max-width: 1099px');
  expect(inBlock(narrow, '.ins-close')).toContain('display: inline-flex');
  expect(inBlock(narrow, '.ins-close')).toContain('position: absolute');
});

test('beside the list the run view keeps 320px and the list gives way first (ADW-528)', () => {
  const grid = declarationsOf(':root[data-detail="open"] .body');
  expect(grid).toContain('minmax(0, var(--list-w, 340px)) minmax(320px, 1fr)');
});

test('under 800px the page is one column: the sidebar folds, the list hides behind an open detail, and the back button shows (ADW-528)', () => {
  expect(html).toMatch(/<header class="top">\s*<button[^>]*data-action="toggle-sidebar"/);
  const main = /<main class="main">([\s\S]*?)<\/main>/.exec(html)?.[1] ?? '';
  expect(main.indexOf('data-action="close-detail"')).toBeGreaterThan(-1);
  expect(main.indexOf('data-action="close-detail"')).toBeLessThan(main.indexOf('id="main"'));
  expect(declarationsOf('.sidebar-btn')).toContain('display: none');
  expect(declarationsOf('.back')).toContain('display: none');
  const narrow = mediaBlock('max-width: 799px');
  expect(inBlock(narrow, '.body')).toContain('grid-template-columns: minmax(0, 1fr)');
  expect(inBlock(narrow, ':root[data-detail="open"] .body')).toContain('grid-template-columns: minmax(0, 1fr)');
  expect(inBlock(narrow, '.side')).toContain('display: none');
  expect(inBlock(narrow, ':root[data-sidebar="open"] .side')).toContain('display: block');
  expect(inBlock(narrow, ':root[data-detail="open"] .list')).toContain('display: none');
  expect(inBlock(narrow, '.sidebar-btn')).toContain('display: inline-flex');
  expect(inBlock(narrow, ':root[data-detail="open"] .back')).toContain('display: inline-flex');
});

test('no sidebar or problem rule keeps its text on one line, so labels wrap rather than clip (ADW-522)', () => {
  const wrapping = rulesOf().filter(([selectors]) =>
    selectors.some((each) => /^\.(side\b|side-|r-problem|lgrp-p|r-menu|lgh \.nm)/.test(each)),
  );
  expect(wrapping.length).toBeGreaterThan(8);
  for (const [selectors, body] of wrapping)
    expect({ selectors, nowrap: /white-space:\s*nowrap/.test(body) }).toEqual({ selectors, nowrap: false });
  expect(declarationsOf('.side-ent .nm')).toContain('overflow-wrap: anywhere');
  expect(declarationsOf('.side-repo .nm')).toContain('overflow-wrap: anywhere');
  expect(declarationsOf('.r-problem')).toContain('overflow-wrap: anywhere');
});

test('a counter in the sidebar shrinks before its name does (ADW-522)', () => {
  expect(declarationsOf('.side-ent .c')).toContain('flex: 0 100 auto');
  expect(declarationsOf('.side-ent .nm')).toContain('flex: 1 1 auto');
});

test("the list hides horizontal overflow, and a row's facts shrink before its title (ADW-522)", () => {
  expect(declarationsOf('.list')).toContain('overflow-x: hidden');
  expect(declarationsOf('.r-title')).toContain('flex: 1 1 0');
  expect(declarationsOf('.r-wf')).toContain('flex: 0 4 auto');
  expect(declarationsOf('.r-line')).toContain('white-space: nowrap');
  expect(declarationsOf('.r-open')).toContain('min-width: 0');
});

test("beside the run view a row gives up its workflow and cost, and an armed action's label wraps inside its menu (ADW-522)", () => {
  expect(declarationsOf(':root[data-detail="open"] .r-wf')).toContain('display: none');
  expect(declarationsOf(':root[data-detail="open"] .r-cost')).toContain('display: none');
  expect(declarationsOf('.r-menu .act button')).toContain('white-space: normal');
  expect(declarationsOf('.r-menu')).toContain('overflow-wrap: anywhere');
  expect(declarationsOf('.wf-act')).toContain('white-space: normal');
});

test('row, group and head heights are set once, in custom properties the fit test reads (ADW-522)', () => {
  expect(declarationsOf(':root')).toMatch(/--row-h:\s*28px/);
  expect(declarationsOf(':root')).toMatch(/--group-h:\s*28px/);
  expect(declarationsOf(':root')).toMatch(/--list-head-h:\s*40px/);
  expect(declarationsOf('.run')).toContain('min-height: var(--row-h)');
  expect(declarationsOf('.lgh')).toContain('min-height: var(--group-h)');
  expect(declarationsOf('.list-h')).toContain('min-height: var(--list-head-h)');
});

/** The raw body of the block that opens with `opener`, from `from`. */
const rawBlock = (opener: string, from = 0): string => {
  const start = style.indexOf(opener, from);
  if (start < 0) throw new Error(`no block ${opener}`);
  return style.slice(start + opener.length, style.indexOf('}', start));
};

test('each theme block declares its color-scheme, so the browser draws native controls for the theme (ADW-506)', () => {
  const media = style.indexOf('@media (prefers-color-scheme: light)');
  expect(rawBlock(':root[data-theme="dark"],\n      :root[data-theme="system"] {')).toContain('color-scheme: dark;');
  expect(rawBlock(':root[data-theme="light"] {')).toContain('color-scheme: light;');
  expect(rawBlock(':root[data-theme="system"] {', media)).toContain('color-scheme: light;');
});

test('one rule draws every text field from the theme variables, with no literal colour (ADW-506)', () => {
  const selector = ':where(input:not([type="checkbox"]):not([type="radio"]))';
  const own = rulesOf().filter(([selectors]) => selectors.length === 1 && selectors[0] === selector);
  expect(own.length).toBe(1);
  const body = own[0]?.[1] ?? '';
  expect(body).toContain('background: var(--inset);');
  expect(body).toContain('color: var(--fg);');
  expect(body).toContain('border: 1px solid var(--line-2);');
  expect(body).not.toContain('#');
});

test('the text-field rule adds no specificity, so the list filter keeps its own style (review R2) (ADW-506)', () => {
  const fieldRules = rulesOf().filter(([selectors]) =>
    selectors.some((each) => each.includes('input:not([type="checkbox"])')),
  );
  const drawing = fieldRules.filter(([, body]) => body.includes('background:'));
  expect(drawing.length).toBe(1);
  expect(drawing[0]?.[0]).toEqual([':where(input:not([type="checkbox"]):not([type="radio"]))']);
  const filter = declarationsOf('.list-f');
  expect(filter).toContain('background: var(--panel-2);');
  expect(filter).toContain('color: var(--fg-2);');
});

test('a field’s placeholder reads in the dimmest text token (ADW-506)', () => {
  expect(declarationsOf('input::placeholder')).toContain('color: var(--fg-4);');
});

test('a tickbox takes its accent from a theme variable (ADW-506)', () => {
  expect(declarationsOf('input[type="checkbox"]')).toContain('accent-color: var(--run);');
});
