import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendJournal,
  createJournal,
  JOURNAL_FILE,
  JournalError,
  type NewJournalEntry,
  readJournal,
} from '../../src/engine/journal';
import { validateRunDir } from '../../src/engine/schemas';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-journal-'));
  dirs.push(dir);
  return dir;
}

/** A completed call of `stage`, as the engine journals it. */
function entry(stage: string, call = 1, output: unknown = { ok: true }): NewJournalEntry {
  const dir = `01-${stage}/call-${call}`;
  return {
    key: `${stage}#${call}`,
    stage,
    call,
    outcome: 'done',
    output,
    reason: null,
    files: { 'out.md': `${dir}/out.md` },
    resultPath: `${dir}/result.json`,
  };
}

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 27, 9, 0, seconds));
const text = (dir: string) => readFileSync(join(dir, JOURNAL_FILE), 'utf8');
const line = (seq: number, stage: string, call = 1) =>
  JSON.stringify({ seq, ...entry(stage, call), recordedAt: at(seq).toISOString() });

/** The error `fn` throws, which must be a JournalError. */
function journalError(fn: () => unknown): JournalError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(JournalError);
    return error as JournalError;
  }
  throw new Error('expected a JournalError');
}

test('a new journal is empty, and is created once', () => {
  const dir = runDir();
  createJournal(dir);
  expect(text(dir)).toBe('');
  expect(readJournal(dir)).toEqual({ entries: [], torn: false });
  expect(() => createJournal(dir)).toThrow(expect.objectContaining({ code: 'EEXIST' }));
});

test('appends number each entry and stamp it with the clock, one line each', () => {
  const dir = runDir();
  createJournal(dir);
  const first = appendJournal(dir, entry('spec'), at(1));
  appendJournal(dir, entry('implement'), at(2));
  appendJournal(dir, entry('implement', 2), at(3));

  expect(first).toEqual({ seq: 1, ...entry('spec'), recordedAt: '2026-09-27T09:00:01.000Z' });
  const lines = text(dir).split('\n');
  expect(lines).toHaveLength(4);
  expect(lines.at(-1)).toBe('');
  const { entries, torn } = readJournal(dir);
  expect(torn).toBe(false);
  expect(entries.map((e) => [e.seq, e.key, e.recordedAt])).toEqual([
    [1, 'spec#1', '2026-09-27T09:00:01.000Z'],
    [2, 'implement#1', '2026-09-27T09:00:02.000Z'],
    [3, 'implement#2', '2026-09-27T09:00:03.000Z'],
  ]);

  // No result.json files exist, so every line's link is an issue. Nothing else about the journal is.
  const report = validateRunDir(dir);
  expect(report.counts['sail.journal.v1']).toBe(3);
  const journalIssues = report.issues.filter((issue) => issue.file === JOURNAL_FILE);
  expect(journalIssues.map((issue) => issue.path)).toEqual(['/resultPath', '/resultPath', '/resultPath']);
});

test('the clock defaults to now', () => {
  const dir = runDir();
  createJournal(dir);
  const before = Date.now();
  const { recordedAt } = appendJournal(dir, entry('spec'));
  expect(Date.parse(recordedAt)).toBeGreaterThanOrEqual(before);
});

test('a torn last line is left out of the read, and cut off before the next append', () => {
  const dir = runDir();
  createJournal(dir);
  // Non-ASCII output, so a character-count cut would land in the wrong place.
  appendJournal(dir, entry('spec', 1, { summary: 'naïve — ✓ déjà vu' }), at(1));
  appendJournal(dir, entry('implement'), at(2));
  appendFileSync(join(dir, JOURNAL_FILE), '{"seq":3,"key":"tests#1","sta');

  const read = readJournal(dir);
  expect(read.torn).toBe(true);
  expect(read.entries.map((e) => e.key)).toEqual(['spec#1', 'implement#1']);

  appendJournal(dir, entry('tests'), at(3));
  const lines = text(dir).split('\n');
  expect(lines).toHaveLength(4);
  expect(lines.slice(0, 3).map((l) => JSON.parse(l).key)).toEqual(['spec#1', 'implement#1', 'tests#1']);
  expect(readJournal(dir)).toEqual({ entries: expect.any(Array), torn: false });
  expect(readJournal(dir).entries.map((e) => e.seq)).toEqual([1, 2, 3]);
  expect(readJournal(dir).entries[0]?.output).toEqual({ summary: 'naïve — ✓ déjà vu' });
});

test('a journal holding only a torn line reads empty, and the append replaces the fragment', () => {
  const dir = runDir();
  writeFileSync(join(dir, JOURNAL_FILE), '{"seq":1,');
  expect(readJournal(dir)).toEqual({ entries: [], torn: true });
  appendJournal(dir, entry('spec'), at(1));
  expect(text(dir)).toBe(`${line(1, 'spec')}\n`);
});

test.each([
  ['does not parse', [line(1, 'spec'), 'not json'], 2, 'not valid JSON'],
  ['is blank', [line(1, 'spec'), '', line(2, 'implement')], 2, 'blank'],
  ['breaks the schema', [line(1, 'spec'), line(2, 'implement').replace('"done"', '"bogus"')], 2, '/outcome'],
  ['has its seq out of place', [line(1, 'spec'), line(3, 'implement')], 2, 'seq 3'],
  ['repeats a key', [line(1, 'spec'), line(2, 'spec')], 2, "'spec#1'"],
  ['is the first and breaks the schema', [line(1, 'spec').replace('"spec#1"', '"Spec#1"')], 1, '/key'],
])('a complete line that %s is corruption, named by its line', (_, lines, lineNo, message) => {
  const dir = runDir();
  writeFileSync(join(dir, JOURNAL_FILE), `${lines.join('\n')}\n`);
  const error = journalError(() => readJournal(dir));
  expect(error.line).toBe(lineNo);
  expect(error.message).toContain(`${JOURNAL_FILE}:${lineNo}`);
  expect(error.message).toContain(message);
});

test('corruption before a torn tail still throws: only the last line may be torn', () => {
  const dir = runDir();
  writeFileSync(join(dir, JOURNAL_FILE), `not json\n{"seq":2`);
  expect(journalError(() => readJournal(dir)).line).toBe(1);
});

test('an append refuses a key already journaled, and writes nothing', () => {
  const dir = runDir();
  createJournal(dir);
  appendJournal(dir, entry('spec'), at(1));
  const before = text(dir);
  expect(() => appendJournal(dir, entry('spec'), at(2))).toThrow("'spec#1' is already journaled");
  expect(text(dir)).toBe(before);
});

test('an append refuses an entry that breaks the schema, a bug in sail, and writes nothing', () => {
  const dir = runDir();
  createJournal(dir);
  const bad = { ...entry('spec'), key: 'Spec#1' };
  expect(() => appendJournal(dir, bad, at(1))).toThrow(/sail\.journal\.v1.*\n.*\/key/);
  expect(text(dir)).toBe('');
});

test('an append over a torn tail leaves the tail alone when the entry is refused', () => {
  const dir = runDir();
  createJournal(dir);
  appendJournal(dir, entry('spec'), at(1));
  appendFileSync(join(dir, JOURNAL_FILE), '{"seq":2');
  const before = text(dir);
  expect(() => appendJournal(dir, { ...entry('spec'), key: 'Spec#2' }, at(2))).toThrow();
  expect(text(dir)).toBe(before);
});
