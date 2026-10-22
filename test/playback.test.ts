// Golden playback (11.3 D8, D9): the scripted golden run, recorded and played back through the fake harness, is the
// committed golden run byte for byte, and each recorded set plays back to the golden of its own. A change to what a run
// writes fails these tests with a diff a person can read, naming the file, the line and both values. `bun run golden`
// regenerates what they compare.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  GOLDEN_RUN_ID,
  generateGoldenRun,
  PLAYBACK,
  playBack,
  RECORDED_SETS,
  SCRIPTED_SET,
  SESSIONS,
} from '../scripts/golden';
import { Recording } from '../src/adapters/recording';
import { readJournal } from '../src/engine/journal';
import { formatIssue, validateRunDir } from '../src/engine/schemas';
import { runDirDiff } from './helpers/run-diff';

const committedRun = join(import.meta.dir, 'fixtures', 'runs', GOLDEN_RUN_ID);
const temp = mkdtempSync(join(tmpdir(), 'sail-playback-test-'));
const [freshSet, scriptedPlayback] = [join(temp, 'rec'), join(temp, 'scripted-playback')];
const recordedRun = join(temp, 'recorded-run');

/** Why a run couldn't be generated, by name: each test then fails on that, not on the hook. */
const unmade: Record<string, string> = {};
async function generate(name: string, make: () => Promise<void>): Promise<void> {
  try {
    await make();
  } catch (error) {
    unmade[name] = error instanceof Error ? error.message : String(error);
  }
}

const setNames = [SCRIPTED_SET, ...RECORDED_SETS.map((set) => set.name)];
beforeAll(async () => {
  await generate('record', () => generateGoldenRun(recordedRun, { record: freshSet }));
  await generate(SCRIPTED_SET, () => playBack({ name: SCRIPTED_SET, onPromptMismatch: 'fail' }, scriptedPlayback));
  for (const set of RECORDED_SETS) await generate(set.name, () => playBack(set, join(temp, `played-${set.name}`)));
});
afterAll(() => rmSync(temp, { recursive: true, force: true }));

/** Every file under `dir` by relative name, sorted: none when the directory isn't there. */
function filesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/** The lines of `journal.txt` as a run's journal says them. */
const journalLines = (runDir: string): string[] =>
  readJournal(runDir).entries.map(({ key, outcome }) => `${key} ${outcome}`);

/** Why a stored recording differs from a fresh one: each file one has and the other lacks, or whose bytes differ. */
function staleSet(fresh: string, stored: string): string[] {
  const [made, kept] = [filesIn(fresh), filesIn(stored)];
  return [
    ...made.filter((file) => !kept.includes(file)).map((file) => `${file} is missing: run bun run golden`),
    ...kept
      .filter((file) => !made.includes(file))
      .map((file) => `${file} is no file of a fresh recording: run bun run golden`),
    ...made
      .filter(
        (file) =>
          kept.includes(file) && readFileSync(join(fresh, file), 'utf8') !== readFileSync(join(stored, file), 'utf8'),
      )
      .map((file) => `${file} is stale: run bun run golden`),
  ];
}

test('the committed scripted set is what a fresh recording of the scripted run writes, file for file', () => {
  expect(unmade.record).toBeUndefined();
  expect(staleSet(freshSet, join(SESSIONS, SCRIPTED_SET))).toEqual([]);
  expect(filesIn(join(SESSIONS, SCRIPTED_SET))).toEqual(
    ['describe#1', 'implement#1', 'implement#2', 'self-review#1', 'spec#1']
      .map((key) => `${key}.json`)
      .concat('journal.txt')
      .sort(),
  );
});

test('recording the scripted run changes nothing it writes: the recorded run is the committed golden run', () => {
  expect(runDirDiff(recordedRun, committedRun)).toBe('');
});

test('playing the scripted set back writes the committed golden run, all 50 files, byte for byte', () => {
  expect(unmade[SCRIPTED_SET]).toBeUndefined();
  expect(filesIn(committedRun)).toHaveLength(50);
  expect(runDirDiff(scriptedPlayback, committedRun)).toBe('');
});

test('every file of the played-back run validates against its schema, and its journal lines equal the set journal.txt', () => {
  expect(validateRunDir(scriptedPlayback).issues.map(formatIssue)).toEqual([]);
  expect(`${journalLines(scriptedPlayback).join('\n')}\n`).toBe(
    readFileSync(join(SESSIONS, SCRIPTED_SET, 'journal.txt'), 'utf8'),
  );
});

test('a golden changed in one field fails with a diff naming the file, the line and both values', () => {
  const changed = join(temp, 'changed');
  cpSync(scriptedPlayback, changed, { recursive: true });
  const file = join(changed, '01-spec', 'call-1', 'result.json');
  const text = readFileSync(file, 'utf8');
  expect(text).toContain('"outcome": "done",');
  writeFileSync(file, text.replace('"outcome": "done",', '"outcome": "blocked",'));
  const diff = runDirDiff(changed, committedRun);
  const line = text.split('\n').indexOf('  "outcome": "done",') + 1;
  expect(diff).toContain(`01-spec/call-1/result.json line ${line}`);
  expect(diff).toContain('-   "outcome": "done",');
  expect(diff).toContain('+   "outcome": "blocked",');
  expect(diff).toEndWith('run bun run golden to regenerate it');
});

test('a played-back set with one recording removed fails by naming it', () => {
  const missing = join(temp, 'missing-set');
  cpSync(join(SESSIONS, SCRIPTED_SET), missing, { recursive: true });
  rmSync(join(missing, 'describe#1.json'));
  expect(staleSet(freshSet, missing)).toEqual(['describe#1.json is missing: run bun run golden']);
});

// One plain test per recorded set, so none run while the list is empty.
for (const set of RECORDED_SETS) {
  test(`recorded set ${set.name} plays back to its golden, every file valid, its journal, outputs and files as recorded`, () => {
    expect(unmade[set.name]).toBeUndefined();
    const played = join(temp, `played-${set.name}`);
    expect(runDirDiff(played, join(PLAYBACK, set.name))).toBe('');
    expect(validateRunDir(played).issues.map(formatIssue)).toEqual([]);
    const dir = join(SESSIONS, set.name);
    expect(`${journalLines(played).join('\n')}\n`).toBe(readFileSync(join(dir, 'journal.txt'), 'utf8'));
    for (const entry of readJournal(played).entries) {
      const recording = filesIn(dir).includes(`${entry.key.replaceAll('/', '+')}.json`)
        ? Recording.parse(JSON.parse(readFileSync(join(dir, `${entry.key.replaceAll('/', '+')}.json`), 'utf8')))
        : undefined;
      if (recording === undefined) continue;
      const last = recording.tries.at(-1);
      expect(entry.output).toEqual(last?.result.outcome === 'done' ? last.result.output : null);
      for (const [name, file] of Object.entries(last?.files ?? {})) {
        const bytes =
          file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : Buffer.from(file.content, 'utf8');
        expect(entry.files[name]).toBe(createHash('sha256').update(bytes).digest('hex'));
      }
    }
  });
}

test('the sets named in RECORDED_SETS each have a recording directory', () => {
  expect(setNames.filter((name) => !existsSync(join(SESSIONS, name)))).toEqual([]);
});
