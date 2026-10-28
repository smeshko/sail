// The built-in claude-code adapter definition: its credential preflight (D9), its version, its options, and what the
// adapter registry makes of it.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeCodeAdapters, SDK_VERSION } from '../../../src/adapters/claude-code/index';
import { BUILTINS } from '../../../src/adapters/index';
import { resolveAdapters } from '../../../src/engine/adapters';
import type { ProjectConfig } from '../../../src/engine/config';
import type { Env } from '../../../src/ports/adapter';
import { FIXTURE_SAIL } from '../../helpers/fixture';

const definition = claudeCodeAdapters.harness;

const CREDENTIAL = [['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']];

test.each<[string, Env, (string | string[])[]]>([
  ['an empty environment', {}, CREDENTIAL],
  ['Bedrock', { CLAUDE_CODE_USE_BEDROCK: '1' }, ['AWS_REGION']],
  ['Vertex', { CLAUDE_CODE_USE_VERTEX: '1' }, ['CLOUD_ML_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID']],
  ['Bedrock switched off', { CLAUDE_CODE_USE_BEDROCK: '0' }, CREDENTIAL],
  ['Vertex set empty', { CLAUDE_CODE_USE_VERTEX: '' }, CREDENTIAL],
  // Review R3-2: the CLI turns a switch on only for 1, true, yes or on, trimmed and in any case.
  ['Bedrock set false', { CLAUDE_CODE_USE_BEDROCK: 'false' }, CREDENTIAL],
  ['Vertex set off', { CLAUDE_CODE_USE_VERTEX: ' Off ' }, CREDENTIAL],
  ['Bedrock set no', { CLAUDE_CODE_USE_BEDROCK: 'no' }, CREDENTIAL],
  ['Bedrock set TRUE', { CLAUDE_CODE_USE_BEDROCK: ' TRUE ' }, ['AWS_REGION']],
  ['Vertex set yes', { CLAUDE_CODE_USE_VERTEX: 'yes' }, ['CLOUD_ML_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID']],
])('on %s, the preflight asks for its credentials', (_, env, names) => {
  expect(definition.requires?.({}, env)).toEqual(names);
});

/** Resolves the harness alone, from the fixture, as `entry`. */
const resolveHarness = (entry: Record<string, unknown>, env: Env) => {
  const fake = { use: 'fake' };
  const config = {
    name: 'test',
    sail: '>=0.0.0',
    adapters: { ticketSource: fake, codeHost: fake, harness: entry, workspace: fake },
    models: {},
    budgets: {},
  } as unknown as ProjectConfig;
  return resolveAdapters({ sailDir: FIXTURE_SAIL, config, builtins: BUILTINS, env, ports: ['harness'] });
};

test('harness: { use: claude-code } resolves to the built-in, with its SDK version recorded and its permissions enforced', async () => {
  const resolved = await resolveHarness({ use: 'claude-code' }, { ANTHROPIC_API_KEY: 'offline-test' });
  expect('issues' in resolved ? resolved.issues : []).toEqual([]);
  if ('issues' in resolved) return;
  expect({
    entry: resolved.entries.harness,
    name: resolved.ports.harness.name,
    permissions: resolved.ports.harness.capabilities().permissions,
  }).toEqual({
    entry: { use: 'claude-code', origin: 'builtin', versions: { '@anthropic-ai/claude-agent-sdk': '0.3.282' } },
    name: 'claude-code',
    permissions: true,
  });
});

test('a Claude subscription OAuth token alone passes the preflight, and neither it nor an API key is refused naming both', async () => {
  const token = await resolveHarness({ use: 'claude-code' }, { CLAUDE_CODE_OAUTH_TOKEN: 'offline-test' });
  const empty = await resolveHarness(
    { use: 'claude-code' },
    { CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: undefined },
  );
  expect('issues' in token ? token.issues : []).toEqual([]);
  expect(empty).toEqual({
    issues: [
      {
        path: '/adapters/harness',
        message: 'needs one of ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, none of which is set',
      },
    ],
  });
});

test('on Bedrock or Vertex an OAuth token does not stand in for the cloud variables', async () => {
  const env = { CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_OAUTH_TOKEN: 'offline-test' };
  expect(await resolveHarness({ use: 'claude-code' }, env)).toEqual({
    issues: [{ path: '/adapters/harness', message: 'needs AWS_REGION, which is not set' }],
  });
});

test('without its credential, the preflight names it; with an option it takes none, the option is named', async () => {
  const missing = await resolveHarness({ use: 'claude-code' }, {});
  const option = await resolveHarness({ use: 'claude-code', model: 'x' }, { ANTHROPIC_API_KEY: 'offline-test' });
  expect(missing).toEqual({
    issues: [
      {
        path: '/adapters/harness',
        message: 'needs one of ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, none of which is set',
      },
    ],
  });
  expect('issues' in option ? option.issues.map((issue) => issue.path) : option).toEqual(['/adapters/harness']);
  expect('issues' in option ? option.issues[0]?.message : '').toContain('option model');
});

test("the SDK version it declares is the installed package's", () => {
  const installed = join(import.meta.dir, '..', '..', '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  const { version } = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  expect([SDK_VERSION, definition.versions?.()]).toEqual([version, { '@anthropic-ai/claude-agent-sdk': version }]);
});

test('BUILTINS holds the fake, linear, claude-code, pi, git-worktree, github and typesafe, the claude-code one filling the harness alone, with a preflight and a version', () => {
  expect(Object.keys(BUILTINS)).toEqual(['fake', 'linear', 'claude-code', 'pi', 'git-worktree', 'github', 'typesafe']);
  const ports = Object.entries(BUILTINS['claude-code'] ?? {}).map(([port, found]) => [port, Object.keys(found).sort()]);
  expect(ports).toEqual([['harness', ['create', 'requires', 'versions']]]);
});
