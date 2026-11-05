// The machine-wide usage-limit hold: the harness key of a suspended call, the keys a workflow reaches, and the hold and
// release records under `<machine dir>/holds/`.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConfig } from '../../src/engine/config';
import type { LoadedWorkflow } from '../../src/engine/load-workflow';
import type { RunHeader } from '../../src/engine/run-header';
import { agent, intake, type StageDefinition, stage, type Workflow, z } from '../../src/sdk/index';
import * as intakes from '../../src/sdk/intakes';
import {
  activeHolds,
  harnessKeyOf,
  harnessKeysOf,
  holdsDir,
  readHold,
  releasedAt,
  releaseHold,
  writeHold,
} from '../../src/watch/holds';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempHome = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sail-holds-'));
  dirs.push(dir);
  return dir;
};

const adapter = (use: string) => ({ use, origin: 'builtin' });
const header = {
  adapters: {
    ticketSource: adapter('fake'),
    codeHost: adapter('fake'),
    harness: adapter('claude-code'),
    workspace: adapter('fake'),
    harnesses: { codex: adapter('pi') },
  },
  intake: { name: 'ticket', origin: 'builtin' },
  stages: {
    spec: { kind: 'agent', origin: 'repo:spec', model: 'claude-opus-5-5' },
    review: {
      origin: 'repo:review',
      steps: [
        { step: 'draft', kind: 'agent', model: 'claude-opus-5-5' },
        { step: 'judge', kind: 'agent', model: 'openai-codex/gpt-5', harness: 'codex' },
      ],
    },
    brief: { kind: 'agent', origin: 'repo:brief', model: 'openai-codex/gpt-5', harness: 'codex' },
  },
} as unknown as Pick<RunHeader, 'adapters' | 'intake' | 'stages'>;

test('a flat stage on the default harness has that harness as its key', () => {
  expect(harnessKeyOf(header, 'spec#1')).toBe('claude-code');
});

test('a step of a multi-step stage on a named pi harness has pi and its model provider as its key', () => {
  expect(harnessKeyOf(header, 'review#2/judge')).toBe('pi:openai-codex');
  expect(harnessKeyOf(header, 'review#2/draft')).toBe('claude-code');
});

test('a flat stage on a named pi harness has pi and its model provider as its key', () => {
  expect(harnessKeyOf(header, 'brief#1')).toBe('pi:openai-codex');
});

test('an intake call reads the intake entry, which has no model and so the default harness', () => {
  expect(harnessKeyOf(header, 'intake#1')).toBe('claude-code');
});

test('a call whose stage the roster lacks, or no call at all, falls back to the default harness', () => {
  expect(harnessKeyOf(header, 'gone#1')).toBe('claude-code');
  expect(harnessKeyOf(header, undefined)).toBe('claude-code');
});

const Out = z.object({ ok: z.boolean() });
const permissions = { read: ['**'], write: ['$STAGE_OUT/**'], commands: [] };
const budget = { maxTurns: 10, maxUsd: 1, maxMinutes: 5 };
const agentOf = (name: string, model?: string) =>
  agent(name, { prompt: './p.md', output: Out, permissions, budget, ...(model === undefined ? {} : { model }) });

const config = {
  name: 'unit',
  sail: '*',
  adapters: {
    ticketSource: { use: 'fake' },
    codeHost: { use: 'fake' },
    harness: { use: 'claude-code' },
    workspace: { use: 'fake' },
    harnesses: { codex: { use: 'pi' } },
  },
  models: { default: 'claude-opus-5-5', deep: { harness: 'codex', model: 'openai-codex/gpt-5' } },
  budgets: {},
} as ProjectConfig;

function loadedOf(definitions: StageDefinition[], own?: LoadedWorkflow['intake']): LoadedWorkflow {
  return {
    name: 'unit',
    workflow: {} as Workflow,
    dir: '/r/.sail/workflows/unit',
    files: [],
    modules: new Map(),
    stages: definitions.map((definition) => ({ definition, dir: `/r/.sail/stages/${definition.name}`, module: {} })),
    intake: own ?? { definition: intakes.ticket, module: { ...intakes } },
  };
}

test('harnessKeysOf lists each key the agent steps reach once, sorted', () => {
  const own: LoadedWorkflow['intake'] = {
    definition: intake('brief', { accepts: ['ticket'], output: Out, steps: [agentOf('brief', 'deep')] }),
    module: {},
  };
  const loaded = loadedOf([agentOf('a'), agentOf('b', 'deep'), agentOf('c')], own);
  expect(harnessKeysOf(loaded, config)).toEqual(['claude-code', 'pi:openai-codex']);
  expect(harnessKeysOf(loadedOf([agentOf('b', 'deep')]), config)).toEqual(['pi:openai-codex']);
  expect(
    harnessKeysOf(loadedOf([stage('s', { output: Out, steps: [agentOf('x', 'deep'), agentOf('y', 'deep')] })]), config),
  ).toEqual(['pi:openai-codex']);
});

const hold = {
  until: '2026-11-05T12:00:00.000Z',
  reason: 'spec#1 hit the usage limit',
  runId: 'run-a',
  repository: 'alpha',
};
const NOW = new Date('2026-11-05T10:00:00.000Z');

test('a hold written under the machine dir reads back with the time it was written', () => {
  const home = tempHome();
  writeHold(home, 'pi:openai-codex', hold, NOW);
  expect(readdirSync(holdsDir(home))).toEqual(['pi%3Aopenai-codex.json']);
  expect(readHold(home, 'pi:openai-codex')).toEqual({ ...hold, at: NOW.toISOString() });
  expect(readHold(home, 'claude-code')).toBeUndefined();
});

test('a write keeps the later until', () => {
  const home = tempHome();
  writeHold(home, 'claude-code', hold, NOW);
  writeHold(home, 'claude-code', { ...hold, until: '2026-11-05T11:00:00.000Z', runId: 'run-b' }, NOW);
  expect(readHold(home, 'claude-code')?.runId).toBe('run-a');
  writeHold(home, 'claude-code', { ...hold, until: '2026-11-05T13:00:00.000Z', runId: 'run-c' }, NOW);
  expect(readHold(home, 'claude-code')).toMatchObject({ until: '2026-11-05T13:00:00.000Z', runId: 'run-c' });
});

test('activeHolds lists the holds on the keys asked that last past now, and ignores an expired one', () => {
  const home = tempHome();
  writeHold(home, 'claude-code', hold, NOW);
  writeHold(home, 'fake', { ...hold, until: '2026-11-05T09:00:00.000Z' }, NOW);
  writeHold(home, 'pi:openai-codex', hold, NOW);
  const active = activeHolds(home, ['claude-code', 'fake', 'other'], NOW);
  expect(active.map((each) => each.key)).toEqual(['claude-code']);
  expect(active[0]?.hold.runId).toBe('run-a');
});

test('an unreadable hold file counts as absent', () => {
  const home = tempHome();
  writeHold(home, 'fake', hold, NOW);
  writeFileSync(join(holdsDir(home), 'fake.json'), '{not json');
  expect(readHold(home, 'fake')).toBeUndefined();
  expect(activeHolds(home, ['fake'], NOW)).toEqual([]);
});

test('releaseHold removes the hold, records the release, and answers whether a hold was there', () => {
  const home = tempHome();
  writeHold(home, 'claude-code', hold, NOW);
  expect(releasedAt(home, 'claude-code')).toBeUndefined();
  expect(releaseHold(home, 'claude-code', NOW)).toBe(true);
  expect(existsSync(join(holdsDir(home), 'claude-code.json'))).toBe(false);
  expect(releasedAt(home, 'claude-code')).toBe(NOW.getTime());
  const later = new Date('2026-11-05T10:30:00.000Z');
  expect(releaseHold(home, 'claude-code', later)).toBe(false);
  expect(releasedAt(home, 'claude-code')).toBe(later.getTime());
});

test('a hold read before the key was last released is not written back (review R4)', () => {
  const home = tempHome();
  releaseHold(home, 'claude-code', NOW);
  writeHold(home, 'claude-code', hold, NOW, NOW.getTime() - 60_000);
  expect(readHold(home, 'claude-code')).toBeUndefined();
  writeHold(home, 'claude-code', hold, NOW, NOW.getTime() + 60_000);
  expect(readHold(home, 'claude-code')?.runId).toBe('run-a');
});
