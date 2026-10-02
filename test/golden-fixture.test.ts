// The golden run directory: a complete sail run, validated against every sail.*.v1 schema. Later engine output is
// compared against it, so a schema change updates the fixture in the same change.
import { afterEach, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { formatIssue, validateProjectFile, validateRunDir } from '../src/engine/schemas';
import { summarize } from '../src/events/summary';
import type { SailEvent } from '../src/events/types';

const RUN_ID = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';
const fixture = join(import.meta.dir, 'fixtures', 'runs', RUN_ID);

interface FileEntry {
  path: string;
  bytes: number;
  sha256: string;
}

const text = (path: string): string => readFileSync(join(fixture, path), 'utf8');
const lines = (path: string): Record<string, unknown>[] =>
  text(path)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
const resultFiles = (): string[] => [...new Bun.Glob('*/**/result.json').scanSync({ cwd: fixture })].sort();

const copies: string[] = [];
afterEach(() => {
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function mutatedCopy(path: string, mutate: (content: string) => string): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'sail-golden-')), RUN_ID);
  copies.push(join(dir, '..'));
  cpSync(fixture, dir, { recursive: true });
  writeFileSync(join(dir, path), mutate(readFileSync(join(dir, path), 'utf8')));
  return dir;
}

test('the golden run directory is valid against every run-directory schema', () => {
  const { counts, issues } = validateRunDir(fixture);
  expect(issues.map(formatIssue)).toEqual([]);
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const perSchema = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([schema, n]) => `${schema}: ${n}`)
    .join(', ');
  console.log(`${basename(fixture)}: ${total} documents valid (${perSchema})`);
  expect(counts).toMatchObject({
    'sail.run.v1': 1,
    'sail.journal.v1': 10,
    'sail.event.v1': 137,
    'sail.summary.v1': 1,
    'sail.result.v1': 10,
  });
});

test('the fixture repository config is valid', () => {
  expect(validateProjectFile(join(import.meta.dir, 'fixtures', 'repo', '.sail', 'project.yaml'))).toEqual([]);
});

test('an unknown outcome in a mutated copy names the file, line and field', () => {
  const result = mutatedCopy('04-self-review/call-1/result.json', (content) =>
    content.replace('"outcome": "done"', '"outcome": "approved"'),
  );
  const journal = mutatedCopy('journal.ndjson', (content) => {
    const all = content.split('\n');
    all[6] = (all[6] ?? '').replace('"outcome":"done"', '"outcome":"approved"');
    return all.join('\n');
  });
  const found = [...validateRunDir(result).issues, ...validateRunDir(journal).issues].map(formatIssue);
  for (const issue of found) console.log(issue);
  expect(found).toEqual([
    '04-self-review/call-1/result.json  [sail.result.v1]  /outcome must be equal to one of the allowed values',
    'journal.ndjson:7  [sail.journal.v1]  /outcome must be equal to one of the allowed values',
  ]);
});

test('the journal holds the ticket-to-pr key sequence', () => {
  expect(lines('journal.ndjson').map((line) => line.key)).toEqual([
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

test('events are numbered without a gap, never go back in time, and all belong to the run', () => {
  const events = lines('events.ndjson');
  expect(events.map((event) => event.seq)).toEqual(events.map((_, i) => i + 1));
  const times = events.map((event) => Date.parse(String(event.ts)));
  expect(times).toEqual([...times].sort((a, b) => a - b));
  expect(new Set(events.map((event) => event.runId))).toEqual(new Set([basename(fixture)]));
  expect(text('STATUS')).toBe('completed\n');
});

/** The move after each stage call, as `[at, value, took]`: the engine routes once per journaled call, but not the intake. */
const MOVES = [
  ['spec#1', 'done', 'implement#1'],
  ['implement#1', 'done', 'tests#1'],
  ['tests#1', 'failed', 'implement#2'],
  ['implement#2', 'done', 'tests#2'],
  ['tests#2', 'passed', 'self-review#1'],
  ['self-review#1', 'done', 'publish#1'],
  ['publish#1', 'passed', 'end'],
];

test("the golden run's routes are the moves after each stage call", () => {
  const routes = lines('events.ndjson').filter((event) => event.type === 'workflow:route');
  expect(routes.map((event) => [event.at, event.value, event.took])).toEqual(MOVES);
  expect(JSON.parse(text('summary.json')).routes).toEqual(MOVES.map(([at, value, took]) => ({ at, value, took })));
});

/** The summary fields no event carries yet, each with what would bring it. The golden fold leaves them out. */
const NOT_DERIVED_YET = [
  // The fetched ticket's key and title: ticket:fetched, once intake runs (Epic 06).
  'ticket',
  // A call's one-line result: an event of each step kind that reports one.
  'calls[].summary',
  // The commits an agent call made: its harness reports them (Epic 07).
  'calls[].commits',
  // A step's one-line result, as for a call.
  'calls[].steps[].summary',
];

/** Deletes the field `path` names, where `name[]` walks every item of the list `name`. Key order is kept. */
function strip(value: unknown, path: readonly string[]): void {
  const [head, ...rest] = path;
  if (head === undefined || typeof value !== 'object' || value === null) return;
  const object = value as Record<string, unknown>;
  if (head.endsWith('[]')) {
    const items = object[head.slice(0, -2)];
    for (const item of Array.isArray(items) ? items : []) strip(item, rest);
  } else if (rest.length === 0) delete object[head];
  else strip(object[head], rest);
}

test("the golden run's summary is its events, folded", () => {
  const expected = JSON.parse(text('summary.json'));
  for (const path of NOT_DERIVED_YET) strip(expected, path.split('.'));
  const folded = summarize(lines('events.ndjson') as unknown as SailEvent[]);
  expect(JSON.stringify(folded, null, 2)).toBe(JSON.stringify(expected, null, 2));
});

test('every result records its files by size and hash, and its duration by its timestamps', () => {
  const results = resultFiles();
  expect(results).toHaveLength(10);
  for (const path of results) {
    const result = JSON.parse(text(path));
    expect(Date.parse(result.finishedAt) - Date.parse(result.startedAt)).toBe(result.durationMs);
    for (const entry of Object.values<FileEntry>(result.files)) {
      expect(existsSync(join(fixture, entry.path))).toBe(true);
      const bytes = readFileSync(join(fixture, entry.path));
      expect({
        path: entry.path,
        bytes: bytes.byteLength,
        sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
      }).toEqual({
        path: entry.path,
        bytes: entry.bytes,
        sha256: entry.sha256,
      });
    }
  }
});

test('every journal line agrees with the result it points at', () => {
  for (const line of lines('journal.ndjson')) {
    expect(existsSync(join(fixture, String(line.resultPath)))).toBe(true);
    const result = JSON.parse(text(String(line.resultPath)));
    const files = Object.fromEntries(
      Object.entries<FileEntry>(result.files).map(([name, entry]) => [name, entry.path]),
    );
    const recorded: Record<string, unknown> = {
      runId: result.runId,
      key: result.key,
      outcome: result.outcome,
      output: result.output,
      files,
    };
    expect(recorded).toEqual({
      runId: RUN_ID,
      key: line.key,
      outcome: line.outcome,
      output: line.output,
      files: line.files,
    });
  }
});

test("a multi-step call's outcome is its last step's, as that step's result records it", () => {
  const multiStep = resultFiles()
    .map((path) => JSON.parse(text(path)))
    .filter((result) => Array.isArray(result.steps));
  expect(multiStep.map((result) => result.key)).toEqual(['publish#1']);
  for (const result of multiStep) {
    const last = result.steps.at(-1);
    expect(result.outcome).toBe(last.outcome);
    expect(JSON.parse(text(last.resultPath)).outcome).toBe(last.outcome);
  }
});

test("a multi-step call linked to another call's result names the link", () => {
  const dir = mutatedCopy('05-publish/call-1/result.json', (content) =>
    content.replace(
      '"resultPath": "05-publish/call-1/steps/2-open/result.json"',
      '"resultPath": "03-tests/call-2/result.json"',
    ),
  );
  const found = validateRunDir(dir).issues.map(formatIssue);
  for (const issue of found) console.log(issue);
  expect(found).toEqual([
    '05-publish/call-1/result.json  [sail.result.v1]  /steps/1/resultPath points at 03-tests/call-2/result.json, ' +
      'which differs in key ("tests#2", not "publish#1/open"), stage ("tests", not "publish"), call (2, not 1), ' +
      'step (undefined, not "open")',
  ]);
});
