// The linear adapter definition (TASK-006), driven through the registry: its credential is checked before anything is
// created, its options are strict, its creation makes no request, and it is a built-in.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTINS } from '../../../../src/adapters/index';
import { EXIT_OK } from '../../../../src/cli/exit-codes';
import { resolveAdapters } from '../../../../src/engine/adapters';
import { readConfig } from '../../../../src/engine/config';
import type { Env } from '../../../../src/ports/adapter';
import { copyFixture, edit } from '../../../helpers/fixture';
import { createLinearWorld, type LinearWorld } from '../../../helpers/linear-world';
import { runCaptured } from '../../../helpers/run-captured';
import { withTempRepo } from '../../../helpers/temp-repo';

const KEY = 'lin_api_SENTINEL-definition-key';
const FAKE_SOURCE = 'ticketSource: { use: fake, seed: ./fake/tickets.json }';

const roots: string[] = [];
let world: LinearWorld;
const original = globalThis.fetch;

beforeEach(() => {
  world = createLinearWorld();
  globalThis.fetch = world.transport;
});
afterEach(() => {
  globalThis.fetch = original;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Resolves the ticket source a `project.yaml` naming `options` gives, in a fixture copy, with `env`. */
async function resolveSource(options: object, env: Env) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sail-linear-definition-')));
  roots.push(root);
  const sailDir = copyFixture(root);
  edit(sailDir, 'project.yaml', FAKE_SOURCE, `ticketSource: ${JSON.stringify(options)}`);
  const config = readConfig(sailDir);
  if ('issues' in config) throw new Error(JSON.stringify(config.issues));
  return resolveAdapters({ sailDir, config, builtins: BUILTINS, env, ports: ['ticketSource'] });
}

const LINEAR = { use: 'linear', team: 'ADW' };

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('with no LINEAR_API_KEY, linear is one issue at its port, and nothing is created or requested', async () => {
    const result = await resolveSource(LINEAR, {});
    expect(result).toEqual({
      issues: [{ path: '/adapters/ticketSource', message: 'needs LINEAR_API_KEY, which is not set' }],
    });
    expect(world.requests).toEqual([]);
  });

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('with the key set, linear resolves as a built-in ticket source, and its entry names no options', async () => {
    const resolved = await resolveSource(LINEAR, { LINEAR_API_KEY: KEY });
    expect(resolved).toMatchObject({
      ports: { ticketSource: { name: 'linear' } },
      entries: { ticketSource: { use: 'linear', origin: 'builtin' } },
    });
  });

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('an option linear does not take is refused, and the issue names it', async () => {
    const result = await resolveSource({ ...LINEAR, foo: 1 }, { LINEAR_API_KEY: KEY });
    expect('issues' in result ? result.issues.map((issue) => [issue.path, issue.message]) : []).toEqual([
      ['/adapters/ticketSource', expect.stringContaining('foo')],
    ]);
  });

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  .each([
    ['a missing team', { use: 'linear' }],
    ['a lower-case team', { use: 'linear', team: 'adw' }],
  ])('%s is one issue at the ticket source, naming the team', async (_, options) => {
    const result = await resolveSource(options, { LINEAR_API_KEY: KEY });
    expect('issues' in result ? result.issues.map((issue) => issue.path) : []).toEqual(['/adapters/ticketSource']);
    expect('issues' in result ? result.issues[0]?.message : '').toContain('team');
  });

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('creating the linear ticket source sends no request', async () => {
    const resolved = await resolveSource(LINEAR, { LINEAR_API_KEY: KEY });
    expect(resolved).toMatchObject({ ports: { ticketSource: { name: 'linear' } } });
    expect(world.requests).toEqual([]);
  });

// A guard, not a red test: a project.yaml that names linear is a valid config, so `sail check` accepts it. The check
// does not resolve adapters (the registry's checks are the tests above and the end-to-end run's), so this proves the
// config stays valid as the adapter lands.
test('sail check accepts a project.yaml that names linear, with its team', async () => {
  await withTempRepo(async (repo) => {
    edit(copyFixture(repo.dir), 'project.yaml', FAKE_SOURCE, `ticketSource: ${JSON.stringify(LINEAR)}`);
    expect(await runCaptured(['check'], repo.dir, { env: { ...repo.env, LINEAR_API_KEY: KEY } })).toEqual({
      code: EXIT_OK,
      stdout: '.sail/ checked: 1 workflow, 6 stages\n',
      stderr: '',
    });
  });
});
