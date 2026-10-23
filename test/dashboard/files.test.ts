// What the dashboard reads: repositories from the registry, their runs, and a call's files, every path built from a
// registry entry and checked to stay inside its run directory. Each refusal first finds what it should, so a resolver
// that refuses everything fails too.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { callFile, findRepo, findRunDir, index, repos, runItems } from '../../src/dashboard/files';
import { readEvents } from '../../src/events/consumers/ndjson';
import {
  appendEvent,
  appendStageEnd,
  entryOf,
  GOLDEN_RUN,
  GOLDEN_RUN_ID,
  type Machine,
  machine,
  runningCopy,
  SECRET,
  treeHash,
} from '../helpers/dashboard';

let m: Machine;
beforeEach(() => {
  m = machine();
});
afterEach(() => m.remove());

const golden = (name: string) => JSON.parse(readFileSync(join(GOLDEN_RUN, name), 'utf8'));

/** The golden run as the dashboard lists it. */
const goldenItem = () => ({
  runId: GOLDEN_RUN_ID,
  workflow: 'ticket-to-pr@1',
  startedAt: golden('run.json').startedAt,
  status: { status: 'completed' as const },
  source: { kind: 'ticket' as const, ticketKey: 'FAKE-1', via: 'cli' as const, forced: [] },
  summary: golden('summary.json'),
});

test('two registered clones are listed side by side, each with its run, its status, source and summary, and reading changes nothing', () => {
  const before = treeHash(m.root);
  expect(repos(m.registryDir)).toEqual({ repos: [entryOf(m.alpha), entryOf(m.beta)], problems: [] });
  expect(findRepo(m.registryDir, 'beta')).toEqual(entryOf(m.beta));
  expect(runItems(entryOf(m.alpha))).toEqual([goldenItem()]);
  expect(runItems(entryOf(m.beta))).toEqual([goldenItem()]);
  expect(index(m.registryDir)).toEqual([
    { ...entryOf(m.alpha), runs: [goldenItem()], queues: [] },
    { ...entryOf(m.beta), runs: [goldenItem()], queues: [] },
  ]);
  expect(treeHash(m.root)).toBe(before);
});

test('a clone whose .sail/ was deleted is listed with a problem and no runs, beside the one that still has its run', () => {
  rmSync(m.alpha.sailDir, { recursive: true });
  const listed = repos(m.registryDir).repos;
  expect(listed.map((repo) => [repo.name, typeof repo.problem])).toEqual([
    ['alpha', 'string'],
    ['beta', 'undefined'],
  ]);
  expect(listed[0]?.problem).toContain(m.alpha.sailDir);
  expect(runItems(entryOf(m.alpha))).toEqual([]);
  expect(index(m.registryDir).map((repo) => [repo.name, repo.runs.length])).toEqual([
    ['alpha', 0],
    ['beta', 1],
  ]);
});

test('an unregistered repository name finds nothing, and a registered one its entry', () => {
  expect(findRepo(m.registryDir, 'alpha')).toEqual(entryOf(m.alpha));
  expect(findRepo(m.registryDir, 'gamma')).toBeUndefined();
  expect(findRepo(m.registryDir, '../alpha')).toBeUndefined();
});

test.each([
  ['..', '..'],
  ['.', '.'],
  ['a path', `${GOLDEN_RUN_ID}/00-intake`],
  ['an encoded separator, decoded', decodeURIComponent(`..%2F..%2F${GOLDEN_RUN_ID}`)],
  ['a directory without run.json', 'fake'],
  ['a symlink to a run outside .sail-runs/', 'escape'],
  ['a symlink to a run in a sibling whose name starts the same', 'sibling'],
  ['a path that comes back to the run', `${GOLDEN_RUN_ID}/../${GOLDEN_RUN_ID}`],
])('findRunDir finds the golden run, and refuses %s', (_, runId) => {
  const runs = join(m.alpha.clone, '.sail-runs');
  mkdirSync(join(runs, 'fake'));
  writeFileSync(join(runs, 'fake', 'STATUS'), 'completed\n');
  const away = join(m.outside, 'run');
  cpSync(GOLDEN_RUN, away, { recursive: true });
  symlinkSync(away, join(runs, 'escape'));
  const beside = join(`${runs}-old`, 'run');
  cpSync(GOLDEN_RUN, beside, { recursive: true });
  symlinkSync(beside, join(runs, 'sibling'));
  expect(findRunDir(entryOf(m.alpha), GOLDEN_RUN_ID)).toBe(m.alpha.runDir);
  expect(findRunDir(entryOf(m.alpha), runId)).toEqual({ missing: expect.any(String) });
});

test("callFile finds a stage call through stage:end, a script call's log, and a step through the last step:end with its key", () => {
  const run = m.alpha.runDir;
  expect(callFile(run, 'implement#1', 'result.json')).toBe(join(run, '02-implement/call-1/result.json'));
  expect(callFile(run, 'tests#1', 'stdout.log')).toBe(join(run, '03-tests/call-1/stdout.log'));
  expect(callFile(run, 'spec#1', 'session.log')).toBe(join(run, '01-spec/call-1/session.log'));
  expect(callFile(run, 'intake#1', 'result.json')).toBe(join(run, '00-intake/call-1/result.json'));
  appendEvent(run, 'step:end', {
    key: 'publish#1',
    step: 'describe',
    try: 1,
    outcome: 'done',
    resultPath: '05-describe/call-1/result.json',
  });
  appendEvent(run, 'step:end', {
    key: 'publish#1',
    step: 'open',
    try: 1,
    outcome: 'passed',
    resultPath: '06-open/call-1/result.json',
  });
  expect(callFile(run, 'publish#1', 'stderr.log')).toBe(join(run, '06-open/call-1/stderr.log'));
});

test.each([
  ['an unknown key', 'nope#1', 'result.json', () => {}],
  ['a name outside the four', 'implement#1', 'prompt.md', () => {}],
  ['a produced file by name', 'implement#1', 'diff.patch', () => {}],
  [
    'an absolute resultPath',
    'evil#1',
    'result.json',
    (m: Machine) => appendStageEnd(m.alpha.runDir, 'evil#1', join(m.outside, 'result.json')),
  ],
  [
    'a resultPath with .. segments',
    'evil#1',
    'result.json',
    (m: Machine) => appendStageEnd(m.alpha.runDir, 'evil#1', '../../../outside/result.json'),
  ],
  [
    'a resultPath with an empty segment',
    'evil#1',
    'stdout.log',
    (m: Machine) => appendStageEnd(m.alpha.runDir, 'evil#1', '03-tests//call-1/result.json'),
  ],
  [
    'a resultPath that is not a result.json',
    'evil#1',
    'result.json',
    (m: Machine) => appendStageEnd(m.alpha.runDir, 'evil#1', '01-spec/call-1/spec.md'),
  ],
  [
    'a session.log that links out of the run',
    'spec#1',
    'session.log',
    (m: Machine) => {
      const log = join(m.alpha.runDir, '01-spec/call-1/session.log');
      rmSync(log);
      symlinkSync(join(m.outside, 'session.log'), log);
    },
  ],
  [
    'a call directory that links out of the run',
    'evil#1',
    'stdout.log',
    (m: Machine) => {
      symlinkSync(m.outside, join(m.alpha.runDir, '03-tests/call-9'));
      appendStageEnd(m.alpha.runDir, 'evil#1', '03-tests/call-9/result.json');
    },
  ],
] as const)("callFile finds a call's result, and refuses %s", (_, key, name, tamper) => {
  tamper(m);
  expect(callFile(m.alpha.runDir, 'implement#1', 'result.json')).toBe(
    join(m.alpha.runDir, '02-implement/call-1/result.json'),
  );
  expect(callFile(m.alpha.runDir, key, name)).toEqual({ missing: expect.any(String) });
});

test.each([
  ['summary.json', (m: Machine) => join(m.outside, 'creds.json')],
  ['STATUS', (m: Machine) => join(m.outside, 'secret.txt')],
  ['run.json', (m: Machine) => join(m.outside, 'secret.txt')],
  ['summary.json', (m: Machine) => join(m.beta.runDir, 'summary.json')],
] as const)(
  'a run whose %s links out of it is listed with a problem and nothing read from it (review #1.2)',
  (name, target) => {
    writeFileSync(join(m.outside, 'creds.json'), `${JSON.stringify({ token: SECRET })}\n`);
    rmSync(join(m.alpha.runDir, name));
    symlinkSync(target(m), join(m.alpha.runDir, name));
    const [item] = runItems(entryOf(m.alpha));
    expect(item).toEqual({ runId: GOLDEN_RUN_ID, summary: null, problem: expect.stringContaining(name) });
    expect(JSON.stringify(index(m.registryDir))).not.toContain(SECRET.slice(0, 13));
    expect(runItems(entryOf(m.beta))).toEqual([goldenItem()]);
  },
);

test.each([
  ['an empty object', '{}'],
  ['calls that are not a list', JSON.stringify({ ...golden('summary.json'), calls: {} })],
  ['a source that is null', JSON.stringify({ ...golden('summary.json'), source: null })],
])(
  'a run whose summary.json is %s is listed with no summary and a problem naming it, and the other clone is untouched (review R1-1)',
  (_, text) => {
    writeFileSync(join(m.alpha.runDir, 'summary.json'), text);
    const [item] = runItems(entryOf(m.alpha));
    expect(item?.summary).toBeNull();
    expect(item?.problem).toContain('summary.json is not a sail.summary.v1');
    expect({ ...item, summary: undefined, problem: undefined }).toEqual({
      ...goldenItem(),
      summary: undefined,
      problem: undefined,
    });
    expect(runItems(entryOf(m.beta))).toEqual([goldenItem()]);
  },
);

test("a running call's log is found in its call directory before its end, a corrective try's in its try directory, and one that links out is refused (review R3-2)", () => {
  const { dir, rest } = runningCopy(m, 1);
  const lines = rest.map((line) => JSON.parse(line) as { type: string; key?: string });
  const start = lines.findIndex((event) => event.type === 'stage:start' && event.key === 'tests#1');
  const end = lines.findIndex((event) => event.type === 'stage:end' && event.key === 'tests#1');
  const append = (from: number, to: number) =>
    appendFileSync(
      join(dir, 'events.ndjson'),
      rest
        .slice(from, to)
        .map((line) => `${line}\n`)
        .join(''),
    );
  /** tests#1's stage:start again, as try `n`, after every event so far. */
  const retry = (n: number) => {
    const seq = readEvents(dir).length + 1;
    appendFileSync(join(dir, 'events.ndjson'), `${JSON.stringify({ ...lines[start], seq, try: n })}\n`);
  };
  append(0, start + 1);
  expect(callFile(dir, 'tests#1', 'stdout.log')).toBe(join(dir, '03-tests/call-1/stdout.log'));
  expect(callFile(dir, 'intake#1', 'stdout.log')).toEqual({ missing: expect.any(String) });
  append(start + 1, end + 1);
  expect(callFile(dir, 'tests#1', 'stdout.log')).toBe(join(dir, '03-tests/call-1/stdout.log'));
  mkdirSync(join(dir, '03-tests/call-1/try-2'));
  writeFileSync(join(dir, '03-tests/call-1/try-2/stdout.log'), 'try 2\n');
  retry(2);
  expect(callFile(dir, 'tests#1', 'stdout.log')).toBe(join(dir, '03-tests/call-1/try-2/stdout.log'));
  writeFileSync(join(m.outside, 'stdout.log'), `${SECRET}\n`);
  symlinkSync(m.outside, join(dir, '03-tests/call-1/try-3'));
  retry(3);
  expect(callFile(dir, 'tests#1', 'stdout.log')).toEqual({ missing: expect.any(String) });
  expect(callFile(dir, 'nope#1', 'stdout.log')).toEqual({ missing: expect.any(String) });
});
