import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    adapters: { ticketSource: fake, codeHost: fake, harness: fake, workspace: fake },
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
