// What the dashboard reads: repositories from the registry, their runs, and a call's files, every path built from a
// registry entry and checked to stay inside its run directory. Each refusal first finds what it should, so a resolver
// that refuses everything fails too.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { callFile, findRepo, findRunDir, index, repos, runItems } from '../../src/dashboard/files';
import {
  appendEvent,
  appendStageEnd,
  entryOf,
  GOLDEN_RUN,
  GOLDEN_RUN_ID,
  type Machine,
  machine,
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
    { ...entryOf(m.alpha), runs: [goldenItem()] },
    { ...entryOf(m.beta), runs: [goldenItem()] },
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
    outcome: 'done',
    resultPath: '05-describe/call-1/result.json',
  });
  appendEvent(run, 'step:end', {
    key: 'publish#1',
    step: 'open',
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
