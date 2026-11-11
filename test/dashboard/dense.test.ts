// The dense fixture's golden views fit the dashboard's 1440×900 window without scrolling (ADW-522): the rows, group
// headers and head of the Active list, and the sidebar, added up at the heights the stylesheet sets, with room for the
// wrapped problem of the unreadable run. A browser measures the same in review's screenshots; this adds it up from the
// stylesheet and the committed views, so a taller row or a new group fails here first.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const root = new URL('../fixtures/dashboard/views/', import.meta.url);
const view = (name: string) => readFileSync(new URL(name, root), 'utf8');
const html = readFileSync(new URL('../../src/dashboard/page/index.html', import.meta.url), 'utf8');
const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';

/** A height custom property of the stylesheet, in px. */
const px = (name: string): number => {
  const value = new RegExp(`${name}:\\s*(\\d+)px`).exec(style)?.[1];
  if (value === undefined) throw new Error(`the stylesheet sets no ${name}`);
  return Number(value);
};
const ROW = px('--row-h');
const GROUP = px('--group-h');
const HEAD = px('--list-head-h');
/** The window's height between the top bar and the status bar: 900 less 46 and 26. */
const SPACE = 900 - 46 - 26;
/** A line of the wrapped problem, and the three a row may add. */
const LINE = 16;
const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

test('the height of the room under the top bar and above the status bar at 1440×900 is 828px', () => {
  expect(SPACE).toBe(828);
});

test('dense-active.html holds 8 run rows in two groups, and its head, groups and rows add up to no more than 828px', () => {
  const active = view('dense-active.html');
  const rows = count(active, /data-row="run:/g);
  const groups = count(active, /data-action="toggle-list-group"/g);
  expect([rows, groups]).toEqual([8, 2]);
  const height = HEAD + groups * GROUP + rows * ROW + 3 * LINE;
  expect(height).toBe(40 + 2 * 28 + 8 * 28 + 48);
  expect(height).toBeLessThanOrEqual(SPACE);
});

test('dense-active.html names the 4 waiting runs first, one of them unreadable with its problem inside its row, and the 4 running ones', () => {
  const active = view('dense-active.html');
  const [waiting = '', running = ''] = active.split('data-group="active:running"');
  expect(count(waiting, /data-row="run:/g)).toBe(4);
  expect(count(running, /data-row="run:/g)).toBe(4);
  expect(count(waiting, /class="r-problem"/g)).toBe(1);
  expect(count(running, /class="r-problem"/g)).toBe(0);
  expect(active).toContain('<span class="lh-t">Active</span><span class="c">8</span>');
});

test('dense-sidebar.html holds 4 entries and 5 repositories, and adds up to no more than 828px', () => {
  const sidebar = view('dense-sidebar.html');
  const entries = count(sidebar, /class="side-ent[" ]/g);
  const repos = count(sidebar, /class="side-repo[" ]/g);
  expect([entries, repos]).toEqual([4, 5]);
  const header = 32;
  expect(entries * ROW + header + repos * ROW).toBeLessThanOrEqual(SPACE);
});

test('dense-history.html holds 36 run rows, 9 failed and 27 done, grouped by day, and dense-queues.html a group for each of 5 repositories and a row for each of 2 queues', () => {
  const history = view('dense-history.html');
  expect(count(history, /data-row="run:/g)).toBe(36);
  expect(count(history, /class="st p-fail"/g)).toBe(9);
  expect(count(history, /class="st p-pass"/g)).toBe(27);
  expect(history).not.toContain('data-group="history:failed"');
  expect(history).not.toContain('data-group="history:done"');
  expect(count(history, /data-group="history:\d{4}-\d{2}-\d{2}"/g)).toBeGreaterThan(1);
  const queues = view('dense-queues.html');
  expect([count(queues, /data-action="toggle-list-group"/g), count(queues, /data-action="select-queue"/g)]).toEqual([
    5, 2,
  ]);
});
