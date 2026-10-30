// lostEvents(): what a resume restores to the stream, from the golden run's directory with its events cut as a power loss
// would cut them.
import { afterEach, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lostEvents, runStartOf } from '../../src/engine/restore-events';
import { readRunHeader } from '../../src/engine/run-header';

const GOLDEN = join(import.meta.dir, '../fixtures/runs/FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the golden run, its events file changed by `cut` from the lines it holds. */
function copyWith(cut: (lines: string[]) => string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-restore-'));
  dirs.push(dir);
  for (const file of ['run.json', 'journal.ndjson']) cpSync(join(GOLDEN, file), join(dir, file));
  const lines = readFileSync(join(GOLDEN, 'events.ndjson'), 'utf8').split('\n').filter(Boolean);
  writeFileSync(
    join(dir, 'events.ndjson'),
    cut(lines)
      .map((line) => `${line}\n`)
      .join(''),
  );
  return dir;
}

const lostIn = (dir: string) => lostEvents({ dir, header: readRunHeader(dir), sailDir: join(dir, '.sail') });
const isAppend = (type: string) => (line: string) => JSON.parse(line).type === type;

test('a stream that lost nothing restores nothing', () => {
  expect(lostIn(copyWith((lines) => lines))).toEqual({ appends: [] });
});

test("a lost last journal:append is restored with the journal line's key, line and outcome", () => {
  const dir = copyWith((lines) => lines.slice(0, lines.findLastIndex(isAppend('journal:append'))));
  expect(lostIn(dir)).toEqual({
    appends: [{ type: 'journal:append', key: 'publish#1', line: 10, outcome: 'passed' }],
  });
});

test("a lost step line's journal:append is restored with the step's key", () => {
  const dir = copyWith((lines) =>
    lines.filter((line) => !line.includes('"key":"publish#1/open"') || !isAppend('journal:append')(line)),
  );
  expect(lostIn(dir)).toEqual({
    appends: [{ type: 'journal:append', key: 'publish#1/open', line: 9, outcome: 'passed' }],
  });
});

test('events with no run:start get one built from the run header', () => {
  const dir = copyWith((lines) => lines.filter((line) => !isAppend('run:start')(line)));
  const { start, appends } = lostIn(dir);
  expect(start).toEqual(runStartOf(readRunHeader(dir)));
  expect(start).toMatchObject({
    type: 'run:start',
    source: { ticketKey: 'FAKE-1' },
    workflow: { name: 'ticket-to-pr' },
  });
  expect(appends).toEqual([]);
});

test('an empty events file restores the run:start and every journal line', () => {
  const { start, appends } = lostIn(copyWith(() => []));
  expect(start).toMatchObject({ type: 'run:start' });
  expect(appends.map((event) => event.type === 'journal:append' && event.key)).toEqual([
    'intake#1',
    'spec#1',
    'implement#1',
    'tests#1',
    'implement#2',
    'tests#2',
    'self-review#1',
    'publish#1/describe',
    'publish#1/open',
    'publish#1',
  ]);
});

/** A seeded run that reused the golden run's first `reused` lines: its header, and a repository root holding the source. */
function seededIn(reused: number | undefined) {
  const root = mkdtempSync(join(tmpdir(), 'sail-restore-root-'));
  dirs.push(root);
  const source = join(root, '.sail-runs', 'FAKE-1-SOURCE');
  mkdirSync(source, { recursive: true });
  cpSync(join(GOLDEN, 'events.ndjson'), join(source, 'events.ndjson'));
  const dir = copyWith(() => []);
  const header = { ...readRunHeader(dir), fromRun: 'FAKE-1-SOURCE', ...(reused === undefined ? {} : { reused }) };
  return lostEvents({ dir, header, sailDir: join(root, '.sail') });
}

test("the reused journal lines are restored with fromRun, and the intake's with the source's ticket", () => {
  const { appends } = seededIn(2);
  expect(appends.slice(0, 3)).toEqual([
    {
      type: 'journal:append',
      key: 'intake#1',
      line: 1,
      outcome: 'passed',
      fromRun: 'FAKE-1-SOURCE',
      ticket: {
        ticketKey: 'FAKE-1',
        title: 'Add a --shout flag to the greet command',
        url: expect.stringContaining('FAKE-1'),
      },
    },
    { type: 'journal:append', key: 'spec#1', line: 2, outcome: 'done', fromRun: 'FAKE-1-SOURCE' },
    { type: 'journal:append', key: 'implement#1', line: 3, outcome: 'done' },
  ]);
});

test('a seeded header with no reused, an older run, restores its lines without fromRun', () => {
  const { appends } = seededIn(undefined);
  expect(appends.some((event) => event.type === 'journal:append' && 'fromRun' in event)).toBe(false);
  expect(appends[0]).toEqual({ type: 'journal:append', key: 'intake#1', line: 1, outcome: 'passed' });
});
