// The golden run directory: a complete sail run, validated against every sail.*.v1 schema. It is generated: the run the
// engine makes of the fixture repository's ticket-to-pr on FAKE-1, written by `bun run golden`, which
// test/scripts/golden.test.ts holds it equal to. So it shows what a run writes today, its workspace included, and
// nothing a run can't write yet: no tool call and no multi-step call.
import { afterEach, expect, test } from 'bun:test';
import { accessSync, constants, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    'sail.journal.v1': 9,
    'sail.event.v1': 126,
    'sail.summary.v1': 1,
    'sail.result.v1': 9,
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

test("the golden run is the fixture's: its id, its startedAt the clock's first reading, and its journal the nine calls of ticket-to-pr with their outcomes", () => {
  const header = JSON.parse(text('run.json'));
  expect([header.runId, header.startedAt]).toEqual([RUN_ID, '2026-09-25T09:00:00.000Z']);
  expect(lines('journal.ndjson').map((line) => `${line.key} ${line.outcome}`)).toEqual([
    'intake#1 passed',
    'spec#1 done',
    'implement#1 done',
    'tests#1 failed',
    'implement#2 done',
    'tests#2 passed',
    'self-review#1 done',
    'describe#1 done',
    'open#1 passed',
  ]);
});

test('it holds nothing a run cannot write yet: no tool, thinking, denial or step event, no ticket:updated, and no publish in its roster; its workspace is in run.json and in the stream', () => {
  const types = new Set(lines('events.ndjson').map((event) => String(event.type)));
  const absent = [...types].filter(
    (type) => /^(tool|step):/.test(type) || ['agent:thinking', 'permission:denied', 'ticket:updated'].includes(type),
  );
  expect(absent).toEqual([]);
  expect([...types].filter((type) => type.startsWith('workspace:')).sort()).toEqual([
    'workspace:created',
    'workspace:lease_released',
    'workspace:leased',
    'workspace:released',
  ]);
  expect(types.size).toBe(31);
  const header = JSON.parse(text('run.json'));
  expect(Object.keys(header)).toEqual([
    'schema',
    'runId',
    'source',
    'claim',
    'workflow',
    'sail',
    'adapters',
    'intake',
    'stages',
    'budget',
    'startedAt',
    'branch',
    'repository',
    'workspace',
  ]);
  expect(Object.keys(header.stages)).toEqual(['describe', 'implement', 'open', 'self-review', 'spec', 'tests']);
});

test("open#1's provider events are codehost:pushed, codehost:pr_opened, codehost:labelled and ticket:commented, between its script:exec and script:exit, and its port events file holds the same four without an envelope", () => {
  const own = lines('events.ndjson').filter((event) => event.key === 'open#1');
  const from = own.findIndex((event) => event.type === 'script:exec');
  const provider = own.slice(from + 1, from + 5);
  expect(own.slice(from, from + 6).map((event) => event.type)).toEqual([
    'script:exec',
    'codehost:pushed',
    'codehost:pr_opened',
    'codehost:labelled',
    'ticket:commented',
    'script:exit',
  ]);
  expect(lines('06-open/call-1/port-events.ndjson')).toEqual(
    provider.map(({ seq: _seq, ts: _ts, runId: _runId, key: _key, ...event }) => event),
  );
  expect(provider[1]).toMatchObject({
    number: 5,
    url: 'fake://codehost/fixture/pull/5',
    head: 'sail/FAKE-1-add-a-shout-flag-to-the-greet-command',
  });
  expect(lines('events.ndjson').filter((event) => String(event.type).startsWith('codehost:'))).toHaveLength(3);
});

test('no file of the golden run holds a path of the machine that generated it, and every file in it is writable', () => {
  const files = [...new Bun.Glob('**/*').scanSync({ cwd: fixture })].sort();
  expect(files).toHaveLength(50);
  const machine = /\/(Users|home|private|var|tmp|runner|root)\//;
  expect(files.filter((file) => machine.test(text(file)))).toEqual([]);
  for (const file of files) expect(() => accessSync(join(fixture, file), constants.W_OK)).not.toThrow();
});

test('events are numbered without a gap, never go back in time, and all belong to the run', () => {
  const events = lines('events.ndjson');
  expect(events.map((event) => event.seq)).toEqual(events.map((_, i) => i + 1));
  const times = events.map((event) => Date.parse(String(event.ts)));
  expect(times).toEqual([...times].sort((a, b) => a - b));
  expect(new Set(events.map((event) => event.runId))).toEqual(new Set([basename(fixture)]));
  expect(text('STATUS')).toBe('completed\n');
});

test('the golden run records its claim: run.json holds it, the stream reports it after run:start and the workspace with no key, and the ticket the intake fetched carries its comment', () => {
  const inProgress = { type: 'started', name: 'In Progress' };
  const comment = `sail run ${RUN_ID} started`;
  const header = JSON.parse(text('run.json'));
  expect([header.source.forced, header.claim]).toEqual([[], { claimed: true, state: inProgress }]);

  const events = lines('events.ndjson');
  expect(events.slice(0, 6).map((event) => event.type)).toEqual([
    'run:start',
    'workspace:leased',
    'workspace:created',
    'ticket:claimed',
    'ticket:commented',
    'intake:start',
  ]);
  const envelope = (seq: number, ts: string, type: string) => ({ seq, ts, type, runId: RUN_ID, ticketKey: 'FAKE-1' });
  expect(events.slice(3, 5)).toEqual([
    { ...envelope(4, '2026-09-25T09:00:01.000Z', 'ticket:claimed'), state: inProgress },
    { ...envelope(5, '2026-09-25T09:00:01.100Z', 'ticket:commented'), body: comment },
  ]);
  expect(events[0]).toMatchObject({ source: { kind: 'ticket', ticketKey: 'FAKE-1', via: 'cli', forced: [] } });

  // The intake fetched the ticket after the claim: its one ticket:fetched counts the claim's comment, and names it.
  const fetched = events.filter((event) => event.type === 'ticket:fetched');
  expect(fetched.map((event) => [event.key, event.comments, event.title, event.url])).toEqual([
    ['intake#1', 2, 'Add a --shout flag to the greet command', 'fake://tickets/FAKE-1'],
  ]);
  const ticket = JSON.parse(text('00-intake/call-1/ticket.json'));
  expect([ticket.state, ticket.comments.at(-1)]).toEqual([
    inProgress,
    { author: 'sail', body: comment, createdAt: '2026-09-25T09:00:00.600Z' },
  ]);
  expect(text('00-intake/call-1/brief.md')).toEndWith(
    `<untrusted-input source="ticket FAKE-1, comment 2">\n${comment}\n</untrusted-input>\n`,
  );
  // The input the workflow reads holds no comment, so the journal's first line is what it was.
  expect(Object.keys(lines('journal.ndjson')[0]?.output as object)).toEqual([
    'ticketKey',
    'title',
    'url',
    'acceptanceCriteria',
    'labels',
    'links',
    'attachments',
  ]);
});

/** The move after each stage call, as `[at, value, took]`: the engine routes once per journaled call, but not the intake. */
const MOVES = [
  ['spec#1', 'done', 'implement#1'],
  ['implement#1', 'done', 'tests#1'],
  ['tests#1', 'failed', 'implement#2'],
  ['implement#2', 'done', 'tests#2'],
  ['tests#2', 'passed', 'self-review#1'],
  ['self-review#1', 'done', 'describe#1'],
  ['describe#1', 'done', 'open#1'],
  ['open#1', 'passed', 'end'],
];

test("the golden run's routes are the moves after each stage call", () => {
  const routes = lines('events.ndjson').filter((event) => event.type === 'workflow:route');
  expect(routes.map((event) => [event.at, event.value, event.took])).toEqual(MOVES);
  expect(JSON.parse(text('summary.json')).routes).toEqual(MOVES.map(([at, value, took]) => ({ at, value, took })));
});

/** The summary fields no event carries yet, each with what would bring it. A generated summary holds none of them. */
const NOT_DERIVED_YET = [
  // A call's one-line result: an event of each step kind that reports one.
  'calls[].summary',
  // The commits an agent call made: its harness reports them (Epic 07).
  'calls[].commits',
  // A step's one-line result, as for a call.
  'calls[].steps[].summary',
];

/** Whether `value` holds the field `path` names anywhere, where `name[]` walks every item of the list `name`. */
function holds(value: unknown, path: readonly string[]): boolean {
  const [head, ...rest] = path;
  if (head === undefined || typeof value !== 'object' || value === null) return false;
  const object = value as Record<string, unknown>;
  if (head.endsWith('[]')) {
    const items = object[head.slice(0, -2)];
    return (Array.isArray(items) ? items : []).some((item) => holds(item, rest));
  }
  return rest.length === 0 ? Object.hasOwn(object, head) : holds(object[head], rest);
}

test("the golden run's summary is its events folded, byte for byte, with nothing left out: it names the ticket, and holds no field that no event carries yet", () => {
  const folded = summarize(lines('events.ndjson') as unknown as SailEvent[]);
  expect(`${JSON.stringify(folded, null, 2)}\n`).toBe(text('summary.json'));
  expect(folded?.ticket).toEqual({
    ticketKey: 'FAKE-1',
    title: 'Add a --shout flag to the greet command',
    url: 'fake://tickets/FAKE-1',
  });
  expect(NOT_DERIVED_YET.filter((path) => holds(folded, path.split('.')))).toEqual([]);
  // The check above can tell: a ticket is a field the summary does hold.
  expect(holds(folded, ['calls[]', 'resultPath'])).toBe(true);
});

test('every result records its files by size and hash, and its duration by its timestamps', () => {
  const results = resultFiles();
  expect(results).toHaveLength(9);
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
