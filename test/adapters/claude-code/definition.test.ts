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

// biome-ignore format: TDD-PENDING TASK-008
test
  .skip // TDD-PENDING TASK-008
  .each<[string, Env, string[]]>([
  ['an empty environment', {}, ['ANTHROPIC_API_KEY']],
  ['Bedrock', { CLAUDE_CODE_USE_BEDROCK: '1' }, ['AWS_REGION']],
  ['Vertex', { CLAUDE_CODE_USE_VERTEX: '1' }, ['CLOUD_ML_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID']],
  ['Bedrock switched off', { CLAUDE_CODE_USE_BEDROCK: '0' }, ['ANTHROPIC_API_KEY']],
  ['Vertex set empty', { CLAUDE_CODE_USE_VERTEX: '' }, ['ANTHROPIC_API_KEY']],
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

// biome-ignore format: TDD-PENDING TASK-008
test
  .skip // TDD-PENDING TASK-008
  ('harness: { use: claude-code } resolves to the built-in, with its SDK version recorded and its permissions enforced', async () => {
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

// biome-ignore format: TDD-PENDING TASK-008
test
  .skip // TDD-PENDING TASK-008
  ('without its key, the preflight names it; with an option it takes none, the option is named', async () => {
  const missing = await resolveHarness({ use: 'claude-code' }, {});
  const option = await resolveHarness({ use: 'claude-code', model: 'x' }, { ANTHROPIC_API_KEY: 'offline-test' });
  expect(missing).toEqual({
    issues: [{ path: '/adapters/harness', message: 'needs ANTHROPIC_API_KEY, which is not set' }],
  });
  expect('issues' in option ? option.issues.map((issue) => issue.path) : option).toEqual(['/adapters/harness']);
  expect('issues' in option ? option.issues[0]?.message : '').toContain('option model');
});

// biome-ignore format: TDD-PENDING TASK-008
test
  .skip // TDD-PENDING TASK-008
  ("the SDK version it declares is the installed package's", () => {
  const installed = join(import.meta.dir, '..', '..', '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  const { version } = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  expect([SDK_VERSION, definition.versions?.()]).toEqual([version, { '@anthropic-ai/claude-agent-sdk': version }]);
});

// biome-ignore format: TDD-PENDING TASK-008
test
  .skip // TDD-PENDING TASK-008
  ('BUILTINS holds the fake and claude-code, which fills the harness alone, with a preflight and a version', () => {
  expect(Object.keys(BUILTINS)).toEqual(['fake', 'claude-code']);
  const ports = Object.entries(BUILTINS['claude-code'] ?? {}).map(([port, found]) => [port, Object.keys(found).sort()]);
  expect(ports).toEqual([['harness', ['create', 'requires', 'versions']]]);
});
