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

test('the theme and inspector buttons carry an aria-label beside their title (ADW-508)', () => {
  expect(html).toContain('data-action="toggle-theme" aria-label="switch theme" title="theme"');
  expect(html).toContain('data-action="toggle-inspector" aria-label="toggle inspector" title="inspector (i)"');
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

test('one :focus-visible rule draws a 2px --focus outline, and no declaration removes an outline (ADW-508)', () => {
  const ring = rules().filter(([sel]) => sel === ':focus-visible');
  expect(ring).toHaveLength(1);
  expect(ring[0]?.[1]).toContain('outline: 2px solid var(--focus);');
  expect(style).not.toMatch(/outline(-width)?:\s*(none|0)\b/);
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
    /\.(btn|wf-act|qbadge|hist-t|r-more|r-open|tab|tog|run-link|art-open|q-row|trow|qsec|qrecent-h|lgrp-h|wf-t|sig)\b/;
  const small: string[] = [];
  for (const [selector, body] of rules()) {
    // A decoration inside a control (`.q-row .qd`) is no target: only a selector that ends on the control counts.
    if (!selector.split(',').some((each) => controls.test(each.trim().split(/\s+/).pop() ?? ''))) continue;
    for (const m of body.matchAll(/(?<![\w-])(height|max-height|min-height):\s*(\d+(?:\.\d+)?)px/g)) {
      if (Number(m[2]) < 24) small.push(`${selector} { ${m[1]}: ${m[2]}px }`);
    }
  }
  expect(small).toEqual([]);
});
