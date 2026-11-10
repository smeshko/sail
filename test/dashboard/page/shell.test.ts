// The structural rules of the page's shell, which `app.ts` once held in one closure: each module is at most 400 lines,
// and the modules keep to their one job. Each scan is shown to catch a made-up source first, so a scan that sees nothing
// can't pass.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PageHost } from '../../../src/dashboard/page/host';
import { CLEARED_KEY, FILTER_KEY, RAIL_KEY, THEME_KEY } from '../../../src/dashboard/page/saved';
import { createStore, FLUSH_MS } from '../../../src/dashboard/page/store';

const PAGE = join(import.meta.dir, '..', '..', '..', 'src', 'dashboard', 'page');
const LIMIT = 400;

const source = (module: string) => readFileSync(join(PAGE, module), 'utf8');
const lines = (text: string) => text.replace(/\n$/, '').split('\n').length;

/** The modules split from `app.ts` so far. */
const SPLIT = ['store.ts', 'saved.ts'];

test('the line counter counts a made-up source, and it is over the limit', () => {
  expect(lines('a\nb\nc\n')).toBe(3);
  expect(lines('x\n'.repeat(LIMIT + 1))).toBeGreaterThan(LIMIT);
});

test.each(SPLIT)('%s is at most 400 lines and imports at runtime only siblings', (module) => {
  const text = source(module);
  expect(lines(text)).toBeLessThanOrEqual(LIMIT);
  const imports = new Bun.Transpiler({ loader: 'ts' }).scanImports(text).map((entry) => entry.path);
  expect(imports.filter((path) => !path.startsWith('./'))).toEqual([]);
});

/** A host that holds a storage and the timers it was asked for, and does nothing else. */
function fakeHost(stored: Record<string, string>) {
  const timers: { ms: number }[] = [];
  const host = {
    load: (key: string) => stored[key],
    save: () => {},
    setTheme: () => {},
    setInspector: () => {},
    offset: () => 120,
    start: () => ({ run: 'r-1' }),
    later: (_fn: () => void, ms: number) => timers.push({ ms }),
    cancel: () => {},
  } as unknown as PageHost;
  return { host, timers };
}

test('createStore reads the saved theme, filter, rail and cleared identities', () => {
  const { host } = fakeHost({
    [THEME_KEY]: 'light',
    [FILTER_KEY]: 'tools,errors,bogus',
    [RAIL_KEY]: '["repo","repo/flow"]',
    [CLEARED_KEY]: '["a","b"]',
  });
  const store = createStore(host);
  expect(store.ui.theme).toBe('light');
  expect(store.ui.hidden).toEqual(['tools', 'errors']);
  expect(store.ui.expanded).toEqual(['repo', 'repo/flow']);
  expect([...store.cleared]).toEqual(['a', 'b']);
  expect(store.ui.tz).toBe(120);
  expect(store.start).toEqual({ run: 'r-1' });
});

test('createStore falls back when what is stored is not valid', () => {
  const { host } = fakeHost({
    [THEME_KEY]: 'neon',
    [RAIL_KEY]: '{"not":"a list"}',
    [CLEARED_KEY]: '[1,2]',
  });
  const store = createStore(host);
  expect(store.ui.theme).toBe('dark');
  expect(store.ui.hidden).toEqual([]);
  expect(store.ui.expanded).toEqual([]);
  expect([...store.cleared]).toEqual([]);
  const broken = createStore(fakeHost({ [RAIL_KEY]: 'not json', [CLEARED_KEY]: 'not json' }).host);
  expect(broken.ui.expanded).toEqual([]);
  expect([...broken.cleared]).toEqual([]);
});

test('two marks before the timer runs schedule one flush, at the flush delay, and none once stopped', () => {
  const { host, timers } = fakeHost({});
  const store = createStore(host);
  store.mark('rail');
  store.mark('main', 'rail');
  expect(timers).toEqual([{ ms: FLUSH_MS }]);
  expect([...store.dirty]).toEqual(['rail', 'main']);
  const stopped = fakeHost({});
  const other = createStore(stopped.host);
  other.stopped = true;
  other.mark('rail');
  expect(stopped.timers).toEqual([]);
});
