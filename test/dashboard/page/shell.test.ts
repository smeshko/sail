// The structural rules of the page's shell, which `app.ts` once held in one closure: each module is at most 400 lines,
// and the modules keep to their one job. Each scan is shown to catch a made-up source first, so a scan that sees nothing
// can't pass.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIONS } from '../../../src/dashboard/page/action-registry';
import { actions } from '../../../src/dashboard/page/actions';
import * as app from '../../../src/dashboard/page/app';
import type { PageHost } from '../../../src/dashboard/page/host';
import { CLEARED_KEY, FILTER_KEY, RAIL_KEY, THEME_KEY } from '../../../src/dashboard/page/saved';
import { createStore, FLUSH_MS } from '../../../src/dashboard/page/store';

const PAGE = join(import.meta.dir, '..', '..', '..', 'src', 'dashboard', 'page');
const LIMIT = 400;

const source = (module: string) => readFileSync(join(PAGE, module), 'utf8');
const lines = (text: string) => text.replace(/\n$/, '').split('\n').length;

/** The modules split from `app.ts` so far. */
const SPLIT = [
  'store.ts',
  'saved.ts',
  'draw.ts',
  'reads.ts',
  'streams.ts',
  'actions.ts',
  'act.ts',
  'keys.ts',
  'location.ts',
  'navigate.ts',
  'app.ts',
];

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
    setUrl: () => {},
    onNavigate: () => {},
    href: () => '',
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

/** What a source holds that a module of the sockets must not: a click, a key, or an import of an action module. */
const handlesInput = (text: string) =>
  [/\bonAction\b/, /\bonKey\b/, /from '\.\/(actions|act|keys)'/].filter((rule) => rule.test(text)).length;

test('the scan for input in the sockets flags a made-up source with each, and streams.ts has none', () => {
  expect(handlesInput('host.onAction(() => {});')).toBe(1);
  expect(handlesInput('host.onKey(() => {});')).toBe(1);
  expect(handlesInput("import { dispatch } from './actions';")).toBe(1);
  expect(handlesInput("import { createActor } from './act';")).toBe(1);
  expect(handlesInput("import { moves } from './keys';")).toBe(1);
  expect(handlesInput("import { tick } from './draw';")).toBe(0);
  expect(handlesInput(source('streams.ts'))).toBe(0);
});

/** Whether a source opens a socket: the sockets are the streams' alone. */
const opensSocket = (text: string) => /\.connect\(/.test(text);

test('the scan for sockets flags a made-up source, and neither actions.ts nor act.ts opens one', () => {
  expect(opensSocket('host.connect(`index=1`, handlers);')).toBe(true);
  expect(opensSocket('host.post(path, body);')).toBe(false);
  expect(opensSocket(source('actions.ts'))).toBe(false);
  expect(opensSocket(source('act.ts'))).toBe(false);
});

test("the shell's actions are exactly the page's view actions: every action of the registry is the actor's", () => {
  expect(ACTIONS.filter((each) => each.id in actions)).toEqual([]);
  expect(Object.keys(actions).sort()).toEqual(
    [
      'select-run',
      'select-queue',
      'select-card',
      'open',
      'close-timeline',
      'open-file',
      'close-file',
      'step-card',
      'toggle-tool',
      'toggle-filter',
      'show-all',
      'tab',
      'stream',
      'log-step',
      'toggle-group',
      'item-menu',
      'stop-now',
      'run-menu',
      'toggle-queue-events',
      'toggle-queue-section',
      'toggle-attention',
      'toggle-section',
      'toggle-inspector',
      'toggle-theme',
      'toggle-follow',
      'copy',
      'copy-link',
    ].sort(),
  );
});

test('app.ts exports boot and the nine constants, and nothing else at runtime', () => {
  expect(Object.keys(app).sort()).toEqual(
    [
      'boot',
      'THEME_KEY',
      'RAIL_KEY',
      'FILTER_KEY',
      'CLEARED_KEY',
      'RECONNECT_MS',
      'FLUSH_MS',
      'LOG_REFRESH_MS',
      'TICK_MS',
      'RECENT_EVENTS',
    ].sort(),
  );
});
