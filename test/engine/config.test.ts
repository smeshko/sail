import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import { readConfig } from '../../src/engine/config';

const FIXTURE_SAIL = join(import.meta.dir, '..', 'fixtures', 'repo', '.sail');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temp `.sail/`, holding `project` as its `project.yaml` unless it is undefined. */
function sailDir(project?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'sail-config-'));
  dirs.push(root);
  const dir = join(root, '.sail');
  mkdirSync(dir);
  if (project !== undefined) writeFileSync(join(dir, 'project.yaml'), project);
  return dir;
}

const ADAPTERS = `adapters:
  ticketSource: { use: linear, team: ADW }
  codeHost: { use: github }
  harness: { use: ./adapters/echo-harness.ts }
  workspace: { use: git-worktree }
`;

test("the fixture's project.yaml reads into a typed config", () => {
  const fake = { use: 'fake' };
  expect(readConfig(FIXTURE_SAIL)).toEqual({
    name: 'fixture',
    sail: '>=0.0.0 <1',
    label: 'sail',
    defaultWorkflow: 'ticket-to-pr',
    adapters: {
      ticketSource: { use: 'fake', seed: './fake/tickets.json' },
      codeHost: { use: 'fake', seed: './fake/prs.json' },
      harness: fake,
      workspace: fake,
    },
    models: { default: 'claude-sonnet-5', deep: 'claude-opus-5-5' },
    budgets: { run: { maxUsd: 25, maxMinutes: 90 } },
  });
});

test('models and budgets default to empty, and an adapter keeps its own options', () => {
  const config = readConfig(sailDir(`name: bare\nsail: ">=0.0.0"\n${ADAPTERS}`));
  if ('issues' in config) throw new Error(`unexpected issues: ${JSON.stringify(config.issues)}`);
  expect(config.models).toEqual({});
  expect(config.budgets).toEqual({});
  expect(config.label).toBeUndefined();
  expect(config.defaultWorkflow).toBeUndefined();
  expect(config.adapters.ticketSource).toEqual({ use: 'linear', team: 'ADW' });
  expect(config.adapters.harness.use).toBe('./adapters/echo-harness.ts');
});

test('a missing project.yaml is an issue at /', () => {
  expect(readConfig(sailDir())).toEqual({ issues: [{ schema: 'sail.project.v1', path: '/', message: 'is missing' }] });
});

test('a project.yaml missing a port is an issue naming it', () => {
  const config = readConfig(sailDir(`name: bare\nsail: ">=0.0.0"\n${ADAPTERS.replace(/ {2}harness:.*\n/, '')}`));
  expect(config).toEqual({ issues: [expect.objectContaining({ path: '/adapters/harness', message: 'is required' })] });
});

test('a project.yaml that does not parse is an issue at /', () => {
  const config = readConfig(sailDir('name: [unclosed\n'));
  expect(config).toEqual({ issues: [expect.objectContaining({ path: '/' })] });
});

const bare = (range: string) => `name: bare\nsail: ${JSON.stringify(range)}\n${ADAPTERS}`;

/** What reading a config whose `sail` is `range` makes of it, for a sail at `version`: 'accepted', or its issues. */
function verdict(range: string, version = '1.5.0'): unknown {
  const config = readConfig(sailDir(bare(range)), version);
  return 'issues' in config ? config.issues : 'accepted';
}

test('a range the running sail does not satisfy is one issue at /sail, naming the range and the version', () => {
  const issue = (version: string) => [
    { path: '/sail', message: `is '>=1.0 <2', which sail ${version} doesn't satisfy` },
  ];
  expect(verdict('>=1.0 <2', '0.0.0')).toEqual(issue('0.0.0'));
  const config = readConfig(sailDir(bare('>=1.0 <2')));
  expect(config).toEqual({ issues: issue(pkg.version) });
});

test.each([
  'latest',
  '>=abc',
  'not a range',
  '1.2.3.4',
  '>=5.0.0 0.x',
  '>=1.0.0 =1.x',
  '1.x 2.x',
  '>x',
  '<*',
  '^x',
  '~*',
  '>=18446744073709551616.0.0',
  '>=1000000000000000.0.0',
  '1.x.3',
  '2.*.3 - 2',
])('%s is one issue at /sail saying it is not a version range', (range) => {
  expect(verdict(range)).toEqual([{ path: '/sail', message: `is '${range}', which is not a version range` }]);
});

test('a version first in its set, a wildcard under >= or <=, and a 15-digit number are ranges, and the version decides', () => {
  const ranges = ['1.x >=1.0.0', '=1.5.0 >=1.0.0', '>=x', '<=*', '>=999999999999999.0.0', '1.x - 2', '1.5.x - 3.x'];
  expect(Object.fromEntries(ranges.map((range) => [range, verdict(range)]))).toEqual({
    '1.x >=1.0.0': 'accepted',
    '=1.5.0 >=1.0.0': 'accepted',
    '>=x': 'accepted',
    '<=*': 'accepted',
    '>=999999999999999.0.0': [
      { path: '/sail', message: "is '>=999999999999999.0.0', which sail 1.5.0 doesn't satisfy" },
    ],
    '1.x - 2': 'accepted',
    '1.5.x - 3.x': 'accepted',
  });
  expect(verdict('1.x >=1.0.0', '2.0.0')).toEqual([
    { path: '/sail', message: "is '1.x >=1.0.0', which sail 2.0.0 doesn't satisfy" },
  ]);
});

test('the grammar accepts caret, tilde, x-ranges, wildcards, equals, unions and hyphen ranges, and the version still decides', () => {
  const ranges = ['^1', '~1.5', '1.x', '*', '=1.5.0', '>=1.0 <2 || >=3', '1.0.0 - 2.0.0', '^2'];
  expect(Object.fromEntries(ranges.map((range) => [range, verdict(range)]))).toEqual({
    '^1': 'accepted',
    '~1.5': 'accepted',
    '1.x': 'accepted',
    '*': 'accepted',
    '=1.5.0': 'accepted',
    '>=1.0 <2 || >=3': 'accepted',
    '1.0.0 - 2.0.0': 'accepted',
    '^2': [{ path: '/sail', message: "is '^2', which sail 1.5.0 doesn't satisfy" }],
  });
});

test('a project.yaml that breaks the schema returns the schema issues alone, and the range is checked once the schema holds', () => {
  const broken = bare('latest').replace(/ {2}harness:.*\n/, '');
  expect(readConfig(sailDir(broken), '1.5.0')).toEqual({
    issues: [expect.objectContaining({ path: '/adapters/harness', message: 'is required' })],
  });
  expect(verdict('latest')).toEqual([{ path: '/sail', message: "is 'latest', which is not a version range" }]);
});

test('conventions reads as the list project.yaml gives, empty included, and is left out when project.yaml has none', () => {
  /** The config's conventions, or the paths of its issues. */
  const read = (extra: string): unknown => {
    const config = readConfig(sailDir(`name: bare\nsail: ">=0.0.0"\n${ADAPTERS}${extra}`));
    return 'issues' in config ? config.issues.map((issue) => issue.path) : config.conventions;
  };
  expect(read('conventions: [docs/STYLE.md, AGENTS.md]\n')).toEqual(['docs/STYLE.md', 'AGENTS.md']);
  expect(read('conventions: []\n')).toEqual([]);
  expect(read('')).toBeUndefined();
  expect(read('conventions: [AGENTS.md, AGENTS.md]\n')).toEqual(['/conventions']);
});
